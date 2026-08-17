import { spawn } from "node:child_process";

import {
  CODEX_REASONING_EFFORTS,
  codexModelCapabilitySchema,
  codexModelSchema,
  codexReasoningEffortSchema,
  type CodexExecutionCapabilitiesDto,
  type CodexModelCapabilityDto,
  type CodexReasoningEffort,
  type ExecutePhaseInput
} from "@ai-sdlc/contracts";
import { z } from "zod";

import { AppError } from "../domain/errors.js";

const modelListPageSchema = z.object({
  data: z.array(z.unknown()),
  nextCursor: z.string().nullable().optional()
});

const appServerModelSchema = z.object({
  id: z.string(),
  displayName: z.string().optional(),
  hidden: z.boolean(),
  defaultReasoningEffort: z.string(),
  supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() }))
});

export interface CodexExecutionCapabilitiesOptions {
  binary?: string;
  allowedModels?: readonly string[];
  allowedReasoningEfforts?: readonly CodexReasoningEffort[];
  defaultModel?: string;
  defaultReasoningEffort?: CodexReasoningEffort;
  codexHome?: string;
  environment?: NodeJS.ProcessEnv;
  catalog?: readonly CodexModelCapabilityDto[];
  timeoutMs?: number;
}

export interface ResolvedCodexExecutionConfig {
  model: string;
  reasoningEffort: CodexReasoningEffort;
}

interface CodexConfigLayer {
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
}

export class CodexExecutionCapabilities {
  private readonly binary: string;
  private readonly allowedModelIds: Set<string> | undefined;
  private readonly allowedReasoningEfforts: Set<CodexReasoningEffort>;
  private readonly configuredDefaultModel: string | undefined;
  private readonly configuredDefaultReasoningEffort: CodexReasoningEffort | undefined;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly configuredCatalog: CodexModelCapabilityDto[] | undefined;
  private readonly timeoutMs: number;
  private readonly catalogPromises = new Map<string, Promise<CodexModelCapabilityDto[]>>();

  constructor(options: CodexExecutionCapabilitiesOptions = {}) {
    this.binary = options.binary ?? "codex";
    this.allowedModelIds = options.allowedModels === undefined
      ? undefined
      : new Set(options.allowedModels.map((model) => codexModelSchema.parse(model)));
    this.allowedReasoningEfforts = new Set(
      (options.allowedReasoningEfforts ?? CODEX_REASONING_EFFORTS)
        .map((effort) => codexReasoningEffortSchema.parse(effort))
    );
    this.configuredDefaultModel = options.defaultModel === undefined
      ? undefined
      : codexModelSchema.parse(options.defaultModel);
    this.configuredDefaultReasoningEffort = options.defaultReasoningEffort === undefined
      ? undefined
      : codexReasoningEffortSchema.parse(options.defaultReasoningEffort);
    this.environment = {
      ...(options.environment ?? process.env),
      ...(options.codexHome ? { CODEX_HOME: options.codexHome } : {})
    };
    this.configuredCatalog = options.catalog?.map((entry) => codexModelCapabilitySchema.parse(entry));
    this.timeoutMs = options.timeoutMs ?? 15_000;

    if (
      this.configuredDefaultModel
      && this.allowedModelIds
      && !this.allowedModelIds.has(this.configuredDefaultModel)
    ) {
      throw new Error("AI_SDLC_CODEX_DEFAULT_MODEL 必须包含在 AI_SDLC_CODEX_MODELS 中");
    }
    if (
      this.configuredDefaultReasoningEffort
      && !this.allowedReasoningEfforts.has(this.configuredDefaultReasoningEffort)
    ) {
      throw new Error(
        "AI_SDLC_CODEX_DEFAULT_REASONING_EFFORT 必须包含在 AI_SDLC_CODEX_REASONING_EFFORTS 中"
      );
    }
  }

  async status(projectRoot: string): Promise<CodexExecutionCapabilitiesDto> {
    const catalog = await this.models(projectRoot);
    const models = catalog.flatMap((model) => {
      if (this.allowedModelIds && !this.allowedModelIds.has(model.id)) return [];
      const reasoningEfforts = model.reasoningEfforts.filter(
        (effort) => this.allowedReasoningEfforts.has(effort)
      );
      if (reasoningEfforts.length === 0) return [];
      return [{
        ...model,
        defaultReasoningEffort: reasoningEfforts.includes(model.defaultReasoningEffort)
          ? model.defaultReasoningEffort
          : reasoningEfforts[0]!,
        reasoningEfforts
      }];
    });
    if (models.length === 0) {
      throw new AppError(
        "Codex 已安装模型目录与服务端允许列表没有交集",
        503,
        "CODEX_MODEL_CATALOG_EMPTY"
      );
    }

    const current = this.configuredDefaultModel && this.configuredDefaultReasoningEffort
      ? {}
      : await readEffectiveCodexConfig(projectRoot, {
          binary: this.binary,
          environment: this.environment,
          timeoutMs: this.timeoutMs
        });
    const defaultModel = this.configuredDefaultModel ?? current.model;
    if (!defaultModel) {
      throw new AppError(
        "无法解析当前 Codex 默认模型；请在 config.toml 设置 model，或配置 AI_SDLC_CODEX_DEFAULT_MODEL",
        503,
        "CODEX_DEFAULT_MODEL_UNAVAILABLE"
      );
    }
    const model = models.find((candidate) => candidate.id === defaultModel);
    if (!model) {
      throw new AppError(
        `当前 Codex 默认模型不在可执行目录或服务端允许列表中：${defaultModel}`,
        503,
        "CODEX_DEFAULT_MODEL_NOT_ALLOWED",
        { defaultModel, allowedModels: models.map((candidate) => candidate.id) }
      );
    }
    const defaultReasoningEffort = this.configuredDefaultReasoningEffort
      ?? (this.configuredDefaultModel ? model.defaultReasoningEffort : current.reasoningEffort)
      ?? model.defaultReasoningEffort;
    if (!model.reasoningEfforts.includes(defaultReasoningEffort)) {
      throw new AppError(
        `当前 reasoning effort ${defaultReasoningEffort} 不受模型 ${model.id} 支持`,
        503,
        "CODEX_DEFAULT_REASONING_EFFORT_NOT_ALLOWED",
        { model: model.id, allowedReasoningEfforts: model.reasoningEfforts }
      );
    }

    return { models, defaultModel: model.id, defaultReasoningEffort };
  }

  async resolve(
    projectRoot: string,
    input: Pick<ExecutePhaseInput, "model" | "reasoningEffort">
  ): Promise<ResolvedCodexExecutionConfig> {
    const capabilities = await this.status(projectRoot);
    const modelId = input.model ?? capabilities.defaultModel;
    const model = capabilities.models.find((candidate) => candidate.id === modelId);
    if (!model) {
      throw new AppError(
        `Codex 模型不在当前 run 的允许目录中：${modelId}`,
        400,
        "CODEX_MODEL_NOT_ALLOWED",
        { allowedModels: capabilities.models.map((candidate) => candidate.id) }
      );
    }
    const reasoningEffort = input.reasoningEffort
      ?? (model.id === capabilities.defaultModel
        ? capabilities.defaultReasoningEffort
        : model.defaultReasoningEffort);
    if (!model.reasoningEfforts.includes(reasoningEffort)) {
      throw new AppError(
        `模型 ${model.id} 不支持 reasoning effort ${reasoningEffort}`,
        400,
        "CODEX_REASONING_EFFORT_NOT_ALLOWED",
        { model: model.id, allowedReasoningEfforts: model.reasoningEfforts }
      );
    }
    return { model: model.id, reasoningEffort };
  }

  private async models(projectRoot: string): Promise<CodexModelCapabilityDto[]> {
    if (this.configuredCatalog) return this.configuredCatalog;
    const cached = this.catalogPromises.get(projectRoot);
    if (cached) return cached;
    const pending = this.loadInstalledCatalog(projectRoot).catch((error) => {
      this.catalogPromises.delete(projectRoot);
      throw error;
    });
    this.catalogPromises.set(projectRoot, pending);
    return pending;
  }

  private async loadInstalledCatalog(projectRoot: string): Promise<CodexModelCapabilityDto[]> {
    const models = await readInstalledCodexModels(projectRoot, {
      binary: this.binary,
      environment: this.environment,
      timeoutMs: this.timeoutMs
    });
    if (models.length === 0) {
      throw new AppError(
        "本机 Codex 模型目录没有可用的 model / reasoning effort 组合",
        503,
        "CODEX_MODEL_CATALOG_EMPTY"
      );
    }
    return models;
  }
}

export interface EffectiveCodexConfigProbeOptions {
  binary?: string;
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export async function readInstalledCodexModels(
  projectRoot: string,
  options: EffectiveCodexConfigProbeOptions = {}
): Promise<CodexModelCapabilityDto[]> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxOutputBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
  return new Promise<CodexModelCapabilityDto[]>((resolve, reject) => {
    const child = spawn(options.binary ?? "codex", ["app-server", "--stdio"], {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: codexEnvironment(options.environment ?? process.env)
    });
    let settled = false;
    let stdout = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let expectedId = 2;
    let handshakeComplete = false;
    const collected: CodexModelCapabilityDto[] = [];
    const timeout = setTimeout(() => finish(new AppError(
      "读取 Codex model/list 超时",
      503,
      "CODEX_MODEL_CATALOG_TIMEOUT"
    )), timeoutMs);
    timeout.unref();

    const finish = (error?: Error, value?: CodexModelCapabilityDto[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdin.end();
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(value ?? []);
    };
    const sendPage = (cursor: string | null) => {
      child.stdin.write(`${JSON.stringify({
        method: "model/list",
        id: expectedId,
        params: { cursor, limit: 100, includeHidden: false }
      })}\n`);
    };

    child.once("error", () => finish(new AppError(
      "无法启动 Codex app-server 读取模型目录",
      503,
      "CODEX_MODEL_CATALOG_UNAVAILABLE"
    )));
    child.once("close", () => {
      if (!settled) finish(new AppError(
        "Codex app-server 在返回完整模型目录前退出",
        503,
        "CODEX_MODEL_CATALOG_UNAVAILABLE"
      ));
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > 256 * 1024) finish(new AppError(
        "Codex app-server 诊断输出超过安全上限",
        503,
        "CODEX_MODEL_CATALOG_OUTPUT_LIMIT"
      ));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > maxOutputBytes) {
        finish(new AppError(
          "Codex app-server model/list 输出超过安全上限",
          503,
          "CODEX_MODEL_CATALOG_OUTPUT_LIMIT"
        ));
        return;
      }
      stdout += chunk;
      for (;;) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) break;
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        const message = parseJson(line);
        if (!message || typeof message !== "object") continue;
        const messageId = (message as { id?: unknown }).id;
        if (!handshakeComplete && messageId === 1) {
          if ((message as { error?: unknown }).error) {
            finish(new AppError(
              "Codex app-server initialize 失败",
              503,
              "CODEX_MODEL_CATALOG_UNAVAILABLE"
            ));
            return;
          }
          handshakeComplete = true;
          child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
          sendPage(null);
          continue;
        }
        if (!handshakeComplete || messageId !== expectedId) continue;
        if ((message as { error?: unknown }).error) {
          finish(new AppError(
            "Codex app-server 拒绝了 model/list 请求",
            503,
            "CODEX_MODEL_CATALOG_UNAVAILABLE"
          ));
          return;
        }
        const page = modelListPageSchema.safeParse((message as { result?: unknown }).result);
        if (!page.success) {
          finish(new AppError(
            "Codex app-server 返回了无法识别的模型目录",
            503,
            "CODEX_MODEL_CATALOG_INVALID"
          ));
          return;
        }
        collected.push(...page.data.data.flatMap(parseAppServerModel));
        if (page.data.nextCursor) {
          expectedId += 1;
          sendPage(page.data.nextCursor);
        } else {
          finish(undefined, uniqueModels(collected));
        }
      }
    });
    child.stdin.once("error", () => finish(new AppError(
      "无法向 Codex app-server 发送 model/list 请求",
      503,
      "CODEX_MODEL_CATALOG_UNAVAILABLE"
    )));
    child.stdin.write(`${JSON.stringify({
      method: "initialize",
      id: 1,
      params: {
        clientInfo: {
          name: "ai_sdlc_platform",
          title: "AI SDLC Platform",
          version: "0.1.0"
        }
      }
    })}\n`);
  });
}

export async function readEffectiveCodexConfig(
  projectRoot: string,
  options: EffectiveCodexConfigProbeOptions = {}
): Promise<CodexConfigLayer> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxOutputBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
  return new Promise<CodexConfigLayer>((resolve, reject) => {
    const child = spawn(options.binary ?? "codex", ["app-server", "--stdio"], {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: codexEnvironment(options.environment ?? process.env)
    });
    let settled = false;
    let stdout = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let handshakeComplete = false;
    const timeout = setTimeout(() => finish(new AppError(
      "读取 Codex effective config 超时",
      503,
      "CODEX_CONFIG_READ_TIMEOUT"
    )), timeoutMs);
    timeout.unref();

    const finish = (error?: Error, value?: CodexConfigLayer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdin.end();
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(value ?? {});
    };

    child.once("error", () => finish(new AppError(
      "无法启动 Codex app-server 读取 effective config",
      503,
      "CODEX_CONFIG_READ_UNAVAILABLE"
    )));
    child.once("close", () => {
      if (!settled) finish(new AppError(
        "Codex app-server 在返回 effective config 前退出",
        503,
        "CODEX_CONFIG_READ_FAILED"
      ));
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > 256 * 1024) finish(new AppError(
        "Codex app-server 诊断输出超过安全上限",
        503,
        "CODEX_CONFIG_READ_OUTPUT_LIMIT"
      ));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > maxOutputBytes) {
        finish(new AppError(
          "Codex app-server config/read 输出超过安全上限",
          503,
          "CODEX_CONFIG_READ_OUTPUT_LIMIT"
        ));
        return;
      }
      stdout += chunk;
      for (;;) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) break;
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        const message = parseJson(line);
        if (!message || typeof message !== "object") continue;
        const messageId = (message as { id?: unknown }).id;
        if (!handshakeComplete && messageId === 1) {
          if ((message as { error?: unknown }).error) {
            finish(new AppError(
              "Codex app-server initialize 失败",
              503,
              "CODEX_CONFIG_READ_FAILED"
            ));
            return;
          }
          handshakeComplete = true;
          const requests = [
            { method: "initialized", params: {} },
            { method: "config/read", id: 2, params: { cwd: projectRoot, includeLayers: false } }
          ];
          child.stdin.write(`${requests.map((request) => JSON.stringify(request)).join("\n")}\n`);
          continue;
        }
        if (!handshakeComplete || messageId !== 2) continue;
        if ((message as { error?: unknown }).error) {
          finish(new AppError(
            "Codex app-server 拒绝了 config/read 请求",
            503,
            "CODEX_CONFIG_READ_FAILED"
          ));
          return;
        }
        const config = (message as { result?: { config?: unknown } }).result?.config;
        if (!config || typeof config !== "object") {
          finish(new AppError(
            "Codex app-server 返回了无法识别的 effective config",
            503,
            "CODEX_CONFIG_READ_INVALID"
          ));
          return;
        }
        const rawModel = (config as { model?: unknown }).model;
        const rawEffort = (config as { model_reasoning_effort?: unknown }).model_reasoning_effort;
        const parsedModel = codexModelSchema.safeParse(rawModel);
        const parsedEffort = codexReasoningEffortSchema.safeParse(rawEffort);
        if (rawModel !== undefined && rawModel !== null && !parsedModel.success) {
          finish(new AppError(
            "Codex app-server 返回了不安全或无法识别的 effective model",
            503,
            "CODEX_CONFIG_READ_INVALID"
          ));
          return;
        }
        if (rawEffort !== undefined && rawEffort !== null && !parsedEffort.success) {
          finish(new AppError(
            "Codex app-server 返回了无法识别的 effective reasoning effort",
            503,
            "CODEX_CONFIG_READ_INVALID"
          ));
          return;
        }
        finish(undefined, {
          model: parsedModel.success ? parsedModel.data : undefined,
          reasoningEffort: parsedEffort.success ? parsedEffort.data : undefined
        });
        return;
      }
    });
    child.stdin.once("error", () => finish(new AppError(
      "无法向 Codex app-server 发送 config/read 请求",
      503,
      "CODEX_CONFIG_READ_FAILED"
    )));
    child.stdin.write(`${JSON.stringify({
      method: "initialize",
      id: 1,
      params: {
        clientInfo: {
          name: "ai_sdlc_platform",
          title: "AI SDLC Platform",
          version: "0.1.0"
        }
      }
    })}\n`);
  });
}

function parseJson(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    return undefined;
  }
}

function parseAppServerModel(raw: unknown): CodexModelCapabilityDto[] {
  const entryResult = appServerModelSchema.safeParse(raw);
  // `includeHidden: false` is requested above, but keep this fail-closed check so
  // an internal picker entry can never leak if a server version ignores it.
  if (!entryResult.success || entryResult.data.hidden) return [];
  const entry = entryResult.data;
  const id = codexModelSchema.safeParse(entry.id);
  const defaultEffort = codexReasoningEffortSchema.safeParse(entry.defaultReasoningEffort);
  const reasoningEfforts = unique(entry.supportedReasoningEfforts.flatMap(({ reasoningEffort }) => {
    const parsedEffort = codexReasoningEffortSchema.safeParse(reasoningEffort);
    return parsedEffort.success ? [parsedEffort.data] : [];
  }));
  if (!id.success || !defaultEffort.success || reasoningEfforts.length === 0) return [];
  if (!reasoningEfforts.includes(defaultEffort.data)) return [];
  return [{
    id: id.data,
    name: (entry.displayName?.trim() || id.data).slice(0, 160),
    defaultReasoningEffort: defaultEffort.data,
    reasoningEfforts
  }];
}

function uniqueModels(models: readonly CodexModelCapabilityDto[]): CodexModelCapabilityDto[] {
  const result = new Map<string, CodexModelCapabilityDto>();
  for (const model of models) if (!result.has(model.id)) result.set(model.id, model);
  return [...result.values()];
}

function codexEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TEMP", "TMP",
    "LANG", "LC_ALL", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR",
    "CODEX_HOME", "CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "SSL_CERT_FILE", "SSL_CERT_DIR"
  ];
  return Object.fromEntries(
    allowed.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]])
  ) as NodeJS.ProcessEnv;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
