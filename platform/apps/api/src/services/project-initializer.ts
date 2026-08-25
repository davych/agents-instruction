import { fileURLToPath, pathToFileURL } from "node:url";

import type { AgentClient } from "@ai-sdlc/contracts";

import { AppError } from "../domain/errors.js";

export interface InitializerOptions {
  agentClient?: AgentClient;
  cliPath?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface InitializerModule {
  run(
    args: string[],
    context: {
      cwd: string;
      prompt: (question: string) => Promise<string>;
      output: (message: string) => void;
      signal?: AbortSignal;
    }
  ): Promise<number>;
}

export async function initializeCodexProject(
  rootPath: string,
  name: string,
  summary: string,
  options: InitializerOptions = {}
): Promise<void> {
  const cliPath = options.cliPath
    ?? fileURLToPath(new URL("../../../../../bin/cli.js", import.meta.url));
  const agentClient = options.agentClient ?? "codex";
  const answers = [
    singleLine(name),
    singleLine(summary) || "由 AI SDLC 平台管理的项目",
    "",
    ""
  ];
  let answerIndex = 0;
  let output = "";
  const controller = new AbortController();
  let abortSource: "external" | "timeout" | undefined;
  const timeoutError = new AppError(
    "项目初始化超时 (timeout)",
    504,
    "INITIALIZE_TIMEOUT",
  );
  const relayAbort = () => {
    if (controller.signal.aborted) return;
    abortSource = "external";
    controller.abort(options.signal?.reason ?? new Error("initialization aborted"));
  };
  if (options.signal?.aborted) relayAbort();
  else options.signal?.addEventListener("abort", relayAbort, { once: true });
  const timer = setTimeout(() => {
    if (controller.signal.aborted) return;
    abortSource = "timeout";
    controller.abort(timeoutError);
  }, options.timeoutMs ?? 30_000);
  timer.unref();

  try {
    controller.signal.throwIfAborted();
    const initializer = await import(pathToFileURL(cliPath).href) as InitializerModule;
    controller.signal.throwIfAborted();
    if (typeof initializer.run !== "function") {
      throw new Error("CLI 未导出 run() 函数");
    }
    const exitCode = await initializer.run(
      ["init", rootPath, "--client", agentClient],
      {
        cwd: rootPath,
        prompt: async () => answers[answerIndex++] ?? "",
        output: (message) => {
          if (output.length < 8_000) output += message;
        },
        signal: controller.signal,
      },
    );
    if (exitCode !== 0) {
      throw new Error(`exit ${exitCode}`);
    }
  } catch (error) {
    if (abortSource === "timeout") throw timeoutError;
    if (abortSource === "external") {
      throw new AppError(
        "项目初始化已取消 (aborted)",
        400,
        "INITIALIZE_ABORTED",
        options.signal?.reason,
      );
    }
    if (error instanceof AppError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new AppError(
      `项目初始化失败：${detail || output.trim() || "未知错误"}`,
      400,
      "INITIALIZE_FAILED"
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", relayAbort);
  }
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").trim();
}
