import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import type {
  FigmaIntegrationStatusDto,
  FigmaPlanCapabilitiesDto,
  FigmaPlanCapabilityDto,
} from "@ai-sdlc/contracts";

const FIGMA_SERVER_NAME = "figma";
const FIGMA_MCP_URL = "https://mcp.figma.com/mcp";
const FIGMA_APP_CONNECTOR_ID = "connector_68df038e0ba48191908c8434991bbac2";
const FIGMA_AUTHORIZATION_URL =
  "https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/#codex";
const APP_LIST_UPDATED_NOTIFICATION = "app/list/updated";
const CODEX_APPS_SERVER_NAME = "codex_apps";
const FIGMA_WHOAMI_TOOL = "figma.whoami";
const APP_LIST_PAGE_SIZE = 3;
const MAX_APP_LIST_PAGES = 100;
const MAX_FIGMA_PLANS = 100;

interface FigmaMcpIntegrationOptions {
  binary?: string;
  timeoutMs?: number;
  appTimeoutMs?: number;
  maxOutputBytes?: number;
  appMaxOutputBytes?: number;
  appMaxLineBytes?: number;
  cacheTtlMs?: number;
  environment?: NodeJS.ProcessEnv;
}

interface McpServerEntry {
  name?: unknown;
  enabled?: unknown;
  transport?: {
    type?: unknown;
    url?: unknown;
  };
  auth_status?: unknown;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
}

interface CacheEntry {
  expiresAt: number;
  status: FigmaIntegrationStatusDto;
}

interface PlanCacheEntry {
  expiresAt: number;
  capabilities: FigmaPlanCapabilitiesDto;
}

interface FigmaStatusOptions {
  force?: boolean;
}

export class FigmaMcpIntegration {
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly appTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly appMaxOutputBytes: number;
  private readonly appMaxLineBytes: number;
  private readonly cacheTtlMs: number;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<FigmaIntegrationStatusDto>>();
  private readonly planCache = new Map<string, PlanCacheEntry>();
  private readonly planInFlight = new Map<string, Promise<FigmaPlanCapabilitiesDto>>();
  private appProbeTail: Promise<void> = Promise.resolve();

  constructor(options: FigmaMcpIntegrationOptions = {}) {
    this.binary = options.binary ?? "codex";
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.appTimeoutMs = options.appTimeoutMs ?? 30_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
    this.appMaxOutputBytes =
      options.appMaxOutputBytes ?? options.maxOutputBytes ?? 512 * 1024;
    this.appMaxLineBytes =
      options.appMaxLineBytes ?? options.maxOutputBytes ?? 128 * 1024;
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 10_000);
    this.environment = codexEnvironment(options.environment ?? process.env);
  }

  async status(
    workingDirectory?: string,
    options: FigmaStatusOptions = {},
  ): Promise<FigmaIntegrationStatusDto> {
    const cacheKey = workingDirectory ?? "";
    if (!options.force) {
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) return { ...cached.status };
    }

    const pending = this.inFlight.get(cacheKey);
    if (pending) {
      if (!options.force) return pending;
      await pending;
      return this.status(workingDirectory, { force: true });
    }

    const probe = this.detectStatus(workingDirectory, options.force === true)
      .then((status) => {
        if (this.cacheTtlMs > 0) {
          this.cache.set(cacheKey, { expiresAt: Date.now() + this.cacheTtlMs, status });
        }
        return status;
      })
      .finally(() => this.inFlight.delete(cacheKey));
    this.inFlight.set(cacheKey, probe);
    return probe;
  }

  async plans(
    workingDirectory: string,
    options: FigmaStatusOptions = {},
  ): Promise<FigmaPlanCapabilitiesDto> {
    const cacheKey = workingDirectory;
    if (!options.force) {
      const cached = this.planCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return clonePlanCapabilities(cached.capabilities);
      }
    }

    const pending = this.planInFlight.get(cacheKey);
    if (pending) {
      if (!options.force) return pending.then(clonePlanCapabilities);
      await pending;
      return this.plans(workingDirectory, { force: true });
    }

    const probe = this.enqueueAppProbe(() => this.queryFigmaPlans(workingDirectory))
      .then((capabilities) => {
        if (this.cacheTtlMs > 0) {
          this.planCache.set(cacheKey, {
            expiresAt: Date.now() + this.cacheTtlMs,
            capabilities,
          });
        }
        return capabilities;
      })
      .finally(() => this.planInFlight.delete(cacheKey));
    this.planInFlight.set(cacheKey, probe);
    return probe.then(clonePlanCapabilities);
  }

  private async detectStatus(
    workingDirectory?: string,
    forceAppRefetch = false,
  ): Promise<FigmaIntegrationStatusDto> {
    const [mcpStatus, appStatus] = await Promise.all([
      this.detectMcpStatus(workingDirectory),
      this.enqueueAppProbe(() => this.detectAppStatus(workingDirectory, forceAppRefetch)),
    ]);

    if (mcpStatus.state === "ready") return mcpStatus;
    if (appStatus.state === "ready") return appStatus;
    if (mcpStatus.state === "authorization_required") return mcpStatus;
    if (appStatus.state === "authorization_required") return appStatus;
    if (mcpStatus.state === "unavailable") return mcpStatus;
    if (appStatus.state === "unavailable") return appStatus;

    return {
      provider: "figma",
      state: "not_configured",
      serverName: null,
      message: "Codex 中尚未配置官方 Figma MCP，也未检测到可用的 Figma App connector。",
      authorizationUrl: FIGMA_AUTHORIZATION_URL,
    };
  }

  private enqueueAppProbe<T>(probe: () => Promise<T>): Promise<T> {
    const previous = this.appProbeTail;
    let release!: () => void;
    this.appProbeTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous
      .catch(() => undefined)
      .then(probe)
      .finally(() => release());
  }

  private async detectMcpStatus(
    workingDirectory?: string,
  ): Promise<FigmaIntegrationStatusDto> {
    let result: CommandResult;
    try {
      result = await this.listMcpServers(workingDirectory);
    } catch {
      return unavailableStatus(null, "暂时无法检测 Figma MCP，请确认 Codex CLI 可用后重试。");
    }

    if (result.exitCode !== 0) {
      return unavailableStatus(null, "暂时无法检测 Figma MCP，请确认 Codex CLI 可用后重试。");
    }

    let entries: unknown;
    try {
      entries = JSON.parse(result.stdout);
    } catch {
      return unavailableStatus(null, "Codex 返回了无法识别的 Figma MCP 状态，请更新或检查 Codex CLI。");
    }
    if (!Array.isArray(entries)) {
      return unavailableStatus(null, "Codex 返回了无法识别的 Figma MCP 状态，请更新或检查 Codex CLI。");
    }

    const figma = entries.find(
      (entry): entry is McpServerEntry => isObject(entry) && entry.name === FIGMA_SERVER_NAME,
    );
    if (!figma) return notConfiguredStatus();

    if (
      figma.transport?.type !== "streamable_http" ||
      !isOfficialFigmaMcpUrl(figma.transport.url)
    ) {
      return unavailableStatus(
        FIGMA_SERVER_NAME,
        "检测到名为 figma 的 MCP 配置，但它不是官方 Figma MCP 地址。",
      );
    }
    if (figma.enabled !== true) {
      return unavailableStatus(FIGMA_SERVER_NAME, "Figma MCP 当前已禁用，请先启用后重新检测。");
    }
    if (figma.auth_status === "o_auth") {
      return {
        provider: "figma",
        state: "ready",
        serverName: FIGMA_SERVER_NAME,
        message: "Codex CLI 中已存在 Figma OAuth 凭据；执行时仍会验证真实 Figma MCP 写入证据。",
        authorizationUrl: null,
      };
    }
    if (figma.auth_status === "not_logged_in") {
      return {
        provider: "figma",
        state: "authorization_required",
        serverName: FIGMA_SERVER_NAME,
        message: "Figma MCP 尚未授权，请先完成 Figma 授权。",
        authorizationUrl: FIGMA_AUTHORIZATION_URL,
      };
    }
    return unavailableStatus(
      FIGMA_SERVER_NAME,
      "无法确认 Figma MCP 的授权状态，请按授权指引重新连接后再试。",
    );
  }

  private async detectAppStatus(
    workingDirectory?: string,
    forceRefetch = false,
  ): Promise<FigmaIntegrationStatusDto> {
    let figma: NormalizedFigmaApp | null;
    try {
      figma = await this.listFigmaApp(workingDirectory, forceRefetch);
    } catch {
      return unavailableStatus(
        null,
        "暂时无法检测 Codex Desktop 的 Figma connector，请确认 Codex 可用后重试。",
      );
    }

    if (!figma) return notConfiguredStatus();
    if (!figma.accessible) {
      return {
        provider: "figma",
        state: "authorization_required",
        serverName: FIGMA_SERVER_NAME,
        message: "Codex Desktop 的 Figma App connector 尚未授权，请完成连接授权后重试。",
        authorizationUrl: FIGMA_AUTHORIZATION_URL,
      };
    }
    if (!figma.enabled) {
      return unavailableStatus(
        FIGMA_SERVER_NAME,
        "Codex Desktop 的 Figma App connector 当前已禁用，请先启用后重新检测。",
      );
    }
    return {
      provider: "figma",
      state: "ready",
      serverName: FIGMA_SERVER_NAME,
      message:
        "Codex Desktop 的 Figma App connector 已连接且启用；执行时仍会验证真实 Figma 工具调用证据。",
      authorizationUrl: null,
    };
  }

  private listMcpServers(workingDirectory?: string): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, ["mcp", "list", "--json"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: this.environment,
        cwd: workingDirectory,
      });
      const stdout: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      let timedOut = false;
      let outputExceeded = false;
      let timeout: NodeJS.Timeout | undefined;

      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        callback();
      };
      const consume = (chunk: Buffer | string, collect: boolean) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outputBytes += buffer.byteLength;
        if (outputBytes > this.maxOutputBytes) {
          outputExceeded = true;
          child.kill("SIGKILL");
          return;
        }
        if (collect) stdout.push(buffer);
      };

      child.stdout.on("data", (chunk: Buffer | string) => consume(chunk, true));
      child.stderr.on("data", (chunk: Buffer | string) => consume(chunk, false));
      child.once("error", () => finish(() => reject(new Error("Codex MCP status command failed"))));
      child.once("close", (code) => {
        finish(() => {
          if (timedOut) reject(new Error("Codex MCP status command timed out"));
          else if (outputExceeded) reject(new Error("Codex MCP status output exceeded the limit"));
          else resolve({ exitCode: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8") });
        });
      });

      timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, this.timeoutMs);
      timeout.unref();
    });
  }

  private listFigmaApp(
    workingDirectory?: string,
    forceRefetch = false,
  ): Promise<NormalizedFigmaApp | null> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, ["app-server", "--stdio"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: this.environment,
        cwd: workingDirectory,
      });
      const decoder = new StringDecoder("utf8");
      let pendingLine = "";
      let outputBytes = 0;
      let settled = false;
      let timedOut = false;
      let outputExceeded = false;
      let protocolFailed = false;
      let initializeCompleted = false;
      let pendingAppListId: number | undefined;
      let nextRequestId = 2;
      let pageCount = 0;
      const seenCursors = new Set<string>();
      let response: NormalizedFigmaApp | null | undefined;
      let timeout: NodeJS.Timeout | undefined;
      let shutdownTimeout: NodeJS.Timeout | undefined;

      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (shutdownTimeout) clearTimeout(shutdownTimeout);
        callback();
      };
      const failProtocol = () => {
        protocolFailed = true;
        child.kill("SIGKILL");
      };
      const writeMessage = (message: unknown) => {
        if (child.stdin.destroyed || child.stdin.writableEnded) {
          failProtocol();
          return;
        }
        child.stdin.write(`${JSON.stringify(message)}\n`);
      };
      const finishResponse = (value: NormalizedFigmaApp | null) => {
        if (response !== undefined) return;
        response = value;
        child.stdin.end();
        shutdownTimeout = setTimeout(() => child.kill("SIGKILL"), 250);
        shutdownTimeout.unref();
      };
      const requestPage = (cursor?: string) => {
        if (pageCount >= MAX_APP_LIST_PAGES || (cursor && seenCursors.has(cursor))) {
          failProtocol();
          return;
        }
        if (cursor) seenCursors.add(cursor);
        const id = nextRequestId;
        nextRequestId += 1;
        pageCount += 1;
        pendingAppListId = id;
        writeMessage({
          id,
          method: "app/list",
          params: {
            forceRefetch: forceRefetch && cursor === undefined,
            limit: APP_LIST_PAGE_SIZE,
            ...(cursor ? { cursor } : {}),
          },
        });
      };
      const inspectLine = (line: string) => {
        if (!line.trim()) return;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          failProtocol();
          return;
        }
        if (!isObject(message)) return;
        if (message.id === 1) {
          if (initializeCompleted || "error" in message || !("result" in message)) {
            failProtocol();
            return;
          }
          initializeCompleted = true;
          writeMessage({ method: "initialized" });
          requestPage();
          return;
        }
        if (message.id !== pendingAppListId) return;
        if (
          "error" in message ||
          !isObject(message.result) ||
          !Array.isArray(message.result.data)
        ) {
          failProtocol();
          return;
        }
        try {
          const figma = normalizeFigmaApp(message.result.data);
          if (figma) {
            finishResponse(figma);
            return;
          }
          const nextCursor = message.result.nextCursor;
          if (nextCursor === null || nextCursor === undefined) {
            finishResponse(null);
          } else if (typeof nextCursor === "string" && nextCursor.length > 0) {
            requestPage(nextCursor);
          } else {
            failProtocol();
          }
        } catch {
          failProtocol();
        }
      };
      const consumeStdout = (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outputBytes += buffer.byteLength;
        if (outputBytes > this.appMaxOutputBytes) {
          outputExceeded = true;
          child.kill("SIGKILL");
          return;
        }
        if (protocolFailed || response !== undefined) return;
        pendingLine += decoder.write(buffer);
        for (;;) {
          const newline = pendingLine.indexOf("\n");
          if (newline < 0) break;
          const line = pendingLine.slice(0, newline);
          pendingLine = pendingLine.slice(newline + 1);
          if (Buffer.byteLength(line) > this.appMaxLineBytes) {
            outputExceeded = true;
            child.kill("SIGKILL");
            return;
          }
          inspectLine(line);
          if (protocolFailed || response !== undefined) {
            pendingLine = "";
            break;
          }
        }
        if (Buffer.byteLength(pendingLine) > this.appMaxLineBytes) {
          outputExceeded = true;
          child.kill("SIGKILL");
        }
      };
      const consumeStderr = (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outputBytes += buffer.byteLength;
        if (outputBytes > this.appMaxOutputBytes) {
          outputExceeded = true;
          child.kill("SIGKILL");
        }
      };

      child.stdout.on("data", consumeStdout);
      child.stderr.on("data", consumeStderr);
      child.stdin.on("error", () => {
        if (response === undefined) failProtocol();
      });
      child.once("spawn", () => {
        writeMessage({
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "ai-sdlc-platform", version: "1.0.0" },
            capabilities: {
              experimentalApi: true,
              optOutNotificationMethods: [APP_LIST_UPDATED_NOTIFICATION],
            },
          },
        });
      });
      child.once("error", () =>
        finish(() => reject(new Error("Codex App connector status command failed"))),
      );
      child.once("close", () => {
        finish(() => {
          if (timedOut) reject(new Error("Codex App connector status command timed out"));
          else if (outputExceeded) reject(new Error("Codex App connector status output exceeded the limit"));
          else if (protocolFailed || response === undefined) {
            reject(new Error("Codex App connector returned an invalid response"));
          } else resolve(response);
        });
      });

      timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, this.appTimeoutMs);
      timeout.unref();
    });
  }

  private queryFigmaPlans(workingDirectory: string): Promise<FigmaPlanCapabilitiesDto> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, ["app-server", "--stdio"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: this.environment,
        cwd: workingDirectory,
      });
      const decoder = new StringDecoder("utf8");
      let pendingLine = "";
      let outputBytes = 0;
      let settled = false;
      let timedOut = false;
      let outputExceeded = false;
      let protocolFailed = false;
      let stage: "initialize" | "thread" | "tool" | "done" = "initialize";
      let timeout: NodeJS.Timeout | undefined;
      let shutdownTimeout: NodeJS.Timeout | undefined;
      let threadId: string | undefined;
      let response: FigmaPlanCapabilitiesDto | undefined;

      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (shutdownTimeout) clearTimeout(shutdownTimeout);
        callback();
      };
      const failProtocol = () => {
        protocolFailed = true;
        child.kill("SIGKILL");
      };
      const writeMessage = (message: unknown) => {
        if (child.stdin.destroyed || child.stdin.writableEnded) {
          failProtocol();
          return;
        }
        child.stdin.write(`${JSON.stringify(message)}\n`);
      };
      const finishResponse = (value: FigmaPlanCapabilitiesDto) => {
        if (response !== undefined) return;
        stage = "done";
        response = value;
        child.stdin.end();
        shutdownTimeout = setTimeout(() => child.kill("SIGKILL"), 250);
        shutdownTimeout.unref();
      };
      const inspectLine = (line: string) => {
        if (!line.trim()) return;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          failProtocol();
          return;
        }
        if (!isObject(message)) return;
        if (message.id === 1) {
          if (stage !== "initialize" || "error" in message || !isObject(message.result)) {
            failProtocol();
            return;
          }
          stage = "thread";
          writeMessage({ method: "initialized" });
          writeMessage({
            id: 2,
            method: "thread/start",
            params: {
              cwd: workingDirectory,
              approvalPolicy: "never",
              sandbox: "read-only",
              ephemeral: true,
            },
          });
          return;
        }
        if (message.id === 2) {
          if (
            stage !== "thread" ||
            "error" in message ||
            !isObject(message.result) ||
            !isObject(message.result.thread) ||
            typeof message.result.thread.id !== "string" ||
            message.result.thread.ephemeral !== true
          ) {
            failProtocol();
            return;
          }
          stage = "tool";
          threadId = message.result.thread.id;
          writeMessage({
            id: 3,
            method: "mcpServer/tool/call",
            params: {
              threadId,
              server: CODEX_APPS_SERVER_NAME,
              tool: FIGMA_WHOAMI_TOOL,
              arguments: {},
            },
          });
          return;
        }
        if (message.id !== 3) {
          if ("id" in message) failProtocol();
          return;
        }
        if (
          stage !== "tool" ||
          "error" in message ||
          !isObject(message.result) ||
          message.result.isError === true
        ) {
          failProtocol();
          return;
        }
        try {
          finishResponse(normalizeFigmaPlans(message.result));
        } catch {
          failProtocol();
        }
      };
      const consumeStdout = (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outputBytes += buffer.byteLength;
        if (outputBytes > this.appMaxOutputBytes) {
          outputExceeded = true;
          child.kill("SIGKILL");
          return;
        }
        if (protocolFailed || response !== undefined) return;
        pendingLine += decoder.write(buffer);
        for (;;) {
          const newline = pendingLine.indexOf("\n");
          if (newline < 0) break;
          const line = pendingLine.slice(0, newline);
          pendingLine = pendingLine.slice(newline + 1);
          if (Buffer.byteLength(line) > this.appMaxLineBytes) {
            outputExceeded = true;
            child.kill("SIGKILL");
            return;
          }
          inspectLine(line);
          if (protocolFailed || response !== undefined) {
            pendingLine = "";
            break;
          }
        }
        if (Buffer.byteLength(pendingLine) > this.appMaxLineBytes) {
          outputExceeded = true;
          child.kill("SIGKILL");
        }
      };
      const consumeStderr = (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outputBytes += buffer.byteLength;
        if (outputBytes > this.appMaxOutputBytes) {
          outputExceeded = true;
          child.kill("SIGKILL");
        }
      };

      child.stdout.on("data", consumeStdout);
      child.stderr.on("data", consumeStderr);
      child.stdin.on("error", () => {
        if (response === undefined) failProtocol();
      });
      child.once("spawn", () => {
        writeMessage({
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "ai-sdlc-platform", version: "1.0.0" },
            capabilities: {
              experimentalApi: true,
              optOutNotificationMethods: [APP_LIST_UPDATED_NOTIFICATION],
            },
          },
        });
      });
      child.once("error", () =>
        finish(() => reject(new Error("Codex App connector plan probe failed"))),
      );
      child.once("close", () => {
        finish(() => {
          if (timedOut) reject(new Error("Codex App connector plan probe timed out"));
          else if (outputExceeded) reject(new Error("Codex App connector plan probe exceeded the output limit"));
          else if (protocolFailed || response === undefined) {
            reject(new Error("Codex App connector returned an invalid plan response"));
          } else resolve(response);
        });
      });

      timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, this.appTimeoutMs);
      timeout.unref();
    });
  }
}

interface NormalizedFigmaApp {
  accessible: boolean;
  enabled: boolean;
}

function normalizeFigmaApp(entries: unknown[]): NormalizedFigmaApp | null {
  const figma = entries.find(
    (entry) => isObject(entry) && entry.id === FIGMA_APP_CONNECTOR_ID,
  );
  if (!isObject(figma)) return null;
  const pluginDisplayNames = Array.isArray(figma.pluginDisplayNames)
    ? figma.pluginDisplayNames
    : [];
  if (figma.name !== "Figma" && !pluginDisplayNames.includes("Figma")) {
    throw new Error("Codex App connector returned an invalid Figma identity");
  }
  if (typeof figma.isAccessible !== "boolean" || typeof figma.isEnabled !== "boolean") {
    throw new Error("Codex App connector returned an invalid Figma entry");
  }
  return { accessible: figma.isAccessible, enabled: figma.isEnabled };
}

function normalizeFigmaPlans(result: Record<string, unknown>): FigmaPlanCapabilitiesDto {
  const payload = findFigmaWhoamiPayload(result);
  if (!isObject(payload) || !Array.isArray(payload.plans) || payload.plans.length > MAX_FIGMA_PLANS) {
    throw new Error("Invalid Figma plan payload");
  }
  const seenKeys = new Set<string>();
  const plans = payload.plans.map((plan): FigmaPlanCapabilityDto => {
    if (!isObject(plan)) throw new Error("Invalid Figma plan");
    const key = safePlanKey(plan.key);
    const name = safeDisplayField(plan.name, 160);
    const seat = safeDisplayField(plan.seat, 80);
    const tier = safeDisplayField(plan.tier, 80);
    if (seenKeys.has(key)) throw new Error("Duplicate Figma plan");
    seenKeys.add(key);
    return {
      key,
      name,
      seat,
      tier,
      writable: ["full", "dev"].includes(seat.toLowerCase()),
    };
  });
  return { provider: "figma", plans };
}

function findFigmaWhoamiPayload(result: Record<string, unknown>): unknown {
  if (isObject(result.structuredContent) && Array.isArray(result.structuredContent.plans)) {
    return result.structuredContent;
  }
  if (!Array.isArray(result.content)) throw new Error("Missing Figma whoami content");
  for (const item of result.content) {
    if (!isObject(item) || item.type !== "text" || typeof item.text !== "string") continue;
    if (Buffer.byteLength(item.text) > 128 * 1024) throw new Error("Figma whoami content too large");
    try {
      const parsed = JSON.parse(item.text) as unknown;
      if (isObject(parsed) && Array.isArray(parsed.plans)) return parsed;
    } catch {
      // Ignore non-JSON informational text blocks; no raw connector content is exposed.
    }
  }
  throw new Error("Missing Figma plans");
}

function safePlanKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    !/^[a-zA-Z][a-zA-Z0-9_-]*::[a-zA-Z0-9_-]+$/u.test(value)
  ) {
    throw new Error("Invalid Figma plan key");
  }
  return value;
}

function safeDisplayField(value: unknown, maximum: number): string {
  if (typeof value !== "string") throw new Error("Invalid Figma plan field");
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new Error("Invalid Figma plan field");
  }
  return normalized;
}

function clonePlanCapabilities(
  capabilities: FigmaPlanCapabilitiesDto,
): FigmaPlanCapabilitiesDto {
  return {
    provider: "figma",
    plans: capabilities.plans.map((plan) => ({ ...plan })),
  };
}

function notConfiguredStatus(): FigmaIntegrationStatusDto {
  return {
    provider: "figma",
    state: "not_configured",
    serverName: null,
    message: "尚未配置 Figma。",
    authorizationUrl: FIGMA_AUTHORIZATION_URL,
  };
}

function unavailableStatus(
  serverName: string | null,
  message: string,
): FigmaIntegrationStatusDto {
  return {
    provider: "figma",
    state: "unavailable",
    serverName,
    message,
    authorizationUrl: FIGMA_AUTHORIZATION_URL,
  };
}

function isOfficialFigmaMcpUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const normalizedUrl = `${url.origin}${url.pathname.replace(/\/$/u, "")}`;
    return (
      normalizedUrl === FIGMA_MCP_URL &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function codexEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "TERM",
    "NO_COLOR",
    "CODEX_HOME",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ];
  return Object.fromEntries(
    allowed.flatMap((key) => (source[key] === undefined ? [] : [[key, source[key]]])),
  ) as NodeJS.ProcessEnv;
}
