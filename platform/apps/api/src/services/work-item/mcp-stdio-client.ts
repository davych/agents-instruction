import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { tmpdir } from "node:os";

import { AppError } from "../../domain/errors.js";

const MCP_PROTOCOL_VERSION = "2025-11-25";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: unknown;
}

export interface McpStdioToolRequest {
  command: string;
  args: readonly string[];
  environment: Readonly<Record<string, string>>;
  toolName: string;
  toolArguments: Readonly<Record<string, unknown>>;
}

export interface McpStdioClientOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/**
 * Minimal MCP stdio client for operator-installed Work Item adapters.
 *
 * It deliberately has no generic "run this command" API: callers supply a
 * server-owned adapter definition, and browser input can only become one tool
 * argument. stdout is protocol-only and both output and wall time are bounded.
 */
export class McpStdioClient {
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(options: McpStdioClientOptions = {}) {
    this.timeoutMs = boundedPositiveInteger(options.timeoutMs, 20_000, 1_000, 120_000);
    this.maxOutputBytes = boundedPositiveInteger(
      options.maxOutputBytes,
      2 * 1024 * 1024,
      16 * 1024,
      10 * 1024 * 1024,
    );
  }

  async callTool(request: McpStdioToolRequest, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw abortedError();

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(request.command, [...request.args], {
        cwd: tmpdir(),
        env: { ...request.environment },
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      throw startError();
    }

    let nextId = 1;
    let outputBytes = 0;
    let stdoutBuffer = "";
    let terminalError: AppError | null = null;
    let finished = false;
    let terminationPromise: Promise<void> | undefined;
    const pending = new Map<string, {
      resolve: (value: unknown) => void;
      reject: (error: AppError) => void;
    }>();

    const signalProcessTree = (signalName: NodeJS.Signals) => {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, signalName);
          return;
        } catch {
          // Fall through to the direct-child signal when the process group has
          // already gone away.
        }
      }
      child.kill(signalName);
    };

    const processClosed = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => {
        if (!child.pid) resolve();
      });
    });

    const terminate = (): Promise<void> => {
      if (terminationPromise) return terminationPromise;
      terminationPromise = (async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        signalProcessTree("SIGTERM");
        const closedGracefully = await Promise.race([
          processClosed.then(() => true),
          delay(1_000).then(() => false),
        ]);
        if (!closedGracefully && child.exitCode === null && child.signalCode === null) {
          signalProcessTree("SIGKILL");
          // Deliberately do not release the caller's concurrency reservation
          // until the OS confirms that the adapter process tree is gone.
          await processClosed;
        }
      })();
      return terminationPromise;
    };

    const fail = (error: AppError) => {
      if (terminalError || finished) return;
      terminalError = error;
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
      void terminate();
    };

    const accountOutput = (bytes: number): boolean => {
      outputBytes += bytes;
      if (outputBytes <= this.maxOutputBytes) return true;
      fail(new AppError(
        "Work Item MCP 返回内容超过平台上限",
        502,
        "WORK_ITEM_MCP_OUTPUT_LIMIT",
      ));
      return false;
    };

    const handleProtocolLine = (line: string) => {
      if (!line.trim()) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        fail(protocolError());
        return;
      }
      if (!isJsonRpcResponse(parsed)) return;
      const waiter = pending.get(String(parsed.id));
      if (!waiter) return;
      pending.delete(String(parsed.id));
      if (parsed.error !== undefined) {
        waiter.reject(new AppError(
          "Work Item MCP 工具调用失败",
          502,
          "WORK_ITEM_MCP_TOOL_ERROR",
        ));
        return;
      }
      waiter.resolve(parsed.result);
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (!accountOutput(Buffer.byteLength(chunk))) return;
      stdoutBuffer += chunk;
      if (Buffer.byteLength(stdoutBuffer) > this.maxOutputBytes) {
        fail(new AppError(
          "Work Item MCP 协议消息超过平台上限",
          502,
          "WORK_ITEM_MCP_OUTPUT_LIMIT",
        ));
        return;
      }
      let newline = stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).replace(/\r$/u, "");
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        handleProtocolLine(line);
        if (terminalError) return;
        newline = stdoutBuffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      accountOutput(chunk.length);
      // stderr is intentionally neither logged nor returned: it may contain
      // adapter credentials or host filesystem details.
    });
    child.once("error", () => fail(startError()));
    child.stdin.once("error", () => {
      if (!finished) fail(protocolError());
    });
    child.once("close", () => {
      if (finished || terminalError) return;
      if (stdoutBuffer.trim()) handleProtocolLine(stdoutBuffer.replace(/\r$/u, ""));
      if (!finished && !terminalError) {
        fail(new AppError(
          "Work Item MCP 在完成调用前退出",
          502,
          "WORK_ITEM_MCP_EXITED",
        ));
      }
    });

    const timer = setTimeout(() => fail(new AppError(
      "Work Item MCP 调用超时",
      504,
      "WORK_ITEM_MCP_TIMEOUT",
    )), this.timeoutMs);
    const abort = () => fail(abortedError());
    signal?.addEventListener("abort", abort, { once: true });

    const send = (message: Record<string, unknown>) => {
      if (terminalError) throw terminalError;
      const serialized = `${JSON.stringify(message)}\n`;
      child.stdin.write(serialized, (error) => {
        if (error) fail(protocolError());
      });
    };

    const rpc = (method: string, params: Record<string, unknown>): Promise<unknown> => {
      if (terminalError) return Promise.reject(terminalError);
      const id = nextId++;
      const response = new Promise<unknown>((resolve, reject) => {
        pending.set(String(id), { resolve, reject });
      });
      send({ jsonrpc: "2.0", id, method, params });
      return response;
    };

    try {
      const initialized = await rpc("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "ai-sdlc-work-item", version: "0.1.0" },
      });
      if (!isInitializeResult(initialized)) throw protocolError();
      send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      const toolResult = await rpc("tools/call", {
        name: request.toolName,
        arguments: request.toolArguments,
      });
      if (!isToolResult(toolResult)) throw protocolError();
      if (toolResult.isError === true) {
        throw new AppError(
          "Work Item MCP 工具报告调用失败",
          502,
          "WORK_ITEM_MCP_TOOL_ERROR",
        );
      }
      finished = true;
      return toolResult;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw protocolError();
    } finally {
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      pending.clear();
      child.stdin.end();
      await terminate();
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (!isRecord(value) || value.jsonrpc !== "2.0") return false;
  return typeof value.id === "string" || typeof value.id === "number";
}

function isInitializeResult(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.protocolVersion === "string";
}

function isToolResult(value: unknown): value is Record<string, unknown> & { isError?: boolean } {
  return isRecord(value)
    && (value.isError === undefined || typeof value.isError === "boolean")
    && (value.structuredContent !== undefined || Array.isArray(value.content));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function startError(): AppError {
  return new AppError(
    "Work Item MCP 进程无法启动，请检查服务端配置",
    503,
    "WORK_ITEM_MCP_START_FAILED",
  );
}

function protocolError(): AppError {
  return new AppError(
    "Work Item MCP 返回了无效协议消息",
    502,
    "WORK_ITEM_MCP_PROTOCOL_ERROR",
  );
}

function abortedError(): AppError {
  return new AppError("Work Item MCP 请求已取消", 499, "WORK_ITEM_MCP_ABORTED");
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`MCP limit 必须是 ${minimum} 到 ${maximum} 之间的整数`);
  }
  return value;
}
