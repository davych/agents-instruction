import { createHash } from "node:crypto";
import path from "node:path";

import {
  resolveWorkItemSchema,
  workItemAdapterIdSchema,
  workItemAdapterSummarySchema,
  workItemDraftSchema,
  workTypeSchema,
  type ResolveWorkItemInput,
  type WorkItemAdapterSummaryDto,
  type WorkItemDraftDto,
  type WorkType,
} from "@ai-sdlc/contracts";
import { z } from "zod";

import { AppError } from "../../domain/errors.js";
import { McpStdioClient, type McpStdioClientOptions } from "./mcp-stdio-client.js";

const unsafeObjectPropertyNames = new Set(["__proto__", "prototype", "constructor"]);

function isSafeObjectPropertyName(value: string): boolean {
  return !unsafeObjectPropertyNames.has(value);
}

const environmentNameSchema = z.string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);

const adapterArgumentSchema = z.string()
  .max(2_048)
  .regex(/^[^\u0000\r\n]*$/u);

const mappingPathSchema = z.string()
  .trim()
  .min(1)
  .max(500)
  .superRefine((value, context) => {
    const parts = value.split(".");
    if (parts.some((part) => (
      !/^[A-Za-z0-9_-]+$/u.test(part)
      || !isSafeObjectPropertyName(part)
    ))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "mapping path 格式无效" });
    }
  });

const adapterConfigSchema = z.object({
  id: workItemAdapterIdSchema,
  label: z.string().trim().min(1).max(120)
    .regex(/^[^\u0000-\u001f\u007f]+$/u),
  command: z.string().trim().min(1).max(4_096)
    .regex(/^[^\u0000\r\n]+$/u)
    .refine((value) => path.isAbsolute(value), "MCP command 必须是绝对路径"),
  args: z.array(adapterArgumentSchema).max(50).default([]),
  toolName: z.string().trim().min(1).max(200)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u),
  referenceArgument: z.string().trim().min(1).max(100)
    .regex(/^[A-Za-z_][A-Za-z0-9_-]*$/u)
    .refine(isSafeObjectPropertyName, "referenceArgument 不能使用危险对象属性名"),
  fixedArguments: z.record(z.string(), z.unknown()).default({}),
  secretEnv: z.record(environmentNameSchema, environmentNameSchema).default({}),
  mapping: z.object({
    title: mappingPathSchema,
    description: mappingPathSchema.optional(),
    externalId: mappingPathSchema.optional(),
    url: mappingPathSchema.optional(),
    acceptanceCriteria: mappingPathSchema.optional(),
    labels: mappingPathSchema.optional(),
    suggestedWorkType: mappingPathSchema.optional(),
  }).strict(),
  defaultWorkType: workTypeSchema.default("feature"),
}).strict().superRefine((config, context) => {
  if (Object.hasOwn(config.fixedArguments, config.referenceArgument)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["fixedArguments", config.referenceArgument],
      message: "referenceArgument 不能同时出现在 fixedArguments",
    });
  }
  const fixedArgumentsError = validateJsonValue(config.fixedArguments);
  if (fixedArgumentsError) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["fixedArguments"],
      message: fixedArgumentsError,
    });
  }
});

const adapterListSchema = z.array(adapterConfigSchema).max(20);
type WorkItemMcpAdapterConfig = z.infer<typeof adapterConfigSchema>;

interface RegisteredAdapter {
  config: WorkItemMcpAdapterConfig;
  environment: Readonly<Record<string, string>> | null;
}

export interface WorkItemMcpRegistryOptions extends McpStdioClientOptions {
  clock?: () => Date;
  maxConcurrent?: number;
}

export class WorkItemMcpRegistry {
  private readonly adapters: ReadonlyMap<string, RegisteredAdapter>;
  private readonly client: McpStdioClient;
  private readonly clock: () => Date;
  private readonly maxConcurrent: number;
  private activeCalls = 0;

  constructor(
    configs: readonly WorkItemMcpAdapterConfig[],
    environment: Readonly<Record<string, string | undefined>>,
    options: WorkItemMcpRegistryOptions = {},
  ) {
    const adapters = new Map<string, RegisteredAdapter>();
    for (const unparsedConfig of configs) {
      const config = adapterConfigSchema.parse(unparsedConfig);
      if (adapters.has(config.id)) throw new Error(`Work Item MCP Adapter ID 重复：${config.id}`);
      adapters.set(config.id, {
        config,
        environment: adapterEnvironment(config, environment),
      });
    }
    this.adapters = adapters;
    this.client = new McpStdioClient(options);
    this.clock = options.clock ?? (() => new Date());
    this.maxConcurrent = boundedPositiveInteger(options.maxConcurrent, 4, 1, 32);
  }

  summaries(): WorkItemAdapterSummaryDto[] {
    return [...this.adapters.values()]
      .map(({ config, environment }) => workItemAdapterSummarySchema.parse({
        id: config.id,
        label: config.label,
        kind: "mcp-stdio",
        configured: environment !== null,
        message: environment === null ? "管理员尚未配置此数据源所需的凭据" : null,
      }))
      .sort((left, right) => compareText(left.id, right.id));
  }

  async resolve(input: ResolveWorkItemInput, signal?: AbortSignal): Promise<WorkItemDraftDto> {
    const parsedInput = resolveWorkItemSchema.parse(input);
    const adapter = this.adapters.get(parsedInput.adapterId);
    if (!adapter) {
      throw new AppError("Work Item 数据源不存在", 404, "WORK_ITEM_ADAPTER_NOT_FOUND");
    }
    if (!adapter.environment) {
      throw new AppError(
        "Work Item 数据源尚未配置好，请联系管理员",
        503,
        "WORK_ITEM_ADAPTER_NOT_CONFIGURED",
      );
    }

    if (this.activeCalls >= this.maxConcurrent) {
      throw new AppError(
        "Work Item 数据源当前正忙，请稍后重试",
        429,
        "WORK_ITEM_MCP_BUSY",
      );
    }
    this.activeCalls += 1;
    try {
      const toolArguments = cloneJsonObject(adapter.config.fixedArguments);
      toolArguments[adapter.config.referenceArgument] = parsedInput.reference;
      const result = await this.client.callTool({
        command: adapter.config.command,
        args: adapter.config.args,
        environment: adapter.environment,
        toolName: adapter.config.toolName,
        toolArguments,
      }, signal);
      const payload = extractToolPayload(result);
      return normalizeWorkItem(adapter.config, parsedInput.reference, payload, this.clock());
    } finally {
      this.activeCalls -= 1;
    }
  }
}

export function createWorkItemMcpRegistryFromEnv(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  options: WorkItemMcpRegistryOptions = {},
): WorkItemMcpRegistry {
  const encoded = environment.AI_SDLC_WORK_ITEM_MCP_ADAPTERS?.trim();
  if (!encoded) return new WorkItemMcpRegistry([], environment, options);
  let raw: unknown;
  try {
    raw = JSON.parse(encoded);
  } catch {
    throw new Error("AI_SDLC_WORK_ITEM_MCP_ADAPTERS 必须是有效 JSON array");
  }
  let configs: WorkItemMcpAdapterConfig[];
  try {
    assertRawFixedArgumentsHaveSafeTopLevelKeys(raw);
    configs = adapterListSchema.parse(raw);
  } catch {
    throw new Error("AI_SDLC_WORK_ITEM_MCP_ADAPTERS 配置无效");
  }
  return new WorkItemMcpRegistry(configs, environment, options);
}

/**
 * Zod's record parser materializes a new object and can normalize away an own
 * `__proto__` key before adapterConfigSchema.superRefine sees it. Inspect the
 * JSON.parse result itself so every object meta key fails closed at the
 * operator-controlled environment boundary.
 */
function assertRawFixedArgumentsHaveSafeTopLevelKeys(raw: unknown): void {
  if (!Array.isArray(raw)) return;
  for (const candidate of raw) {
    if (!isRecord(candidate) || !isRecord(candidate.fixedArguments)) continue;
    for (const propertyName of unsafeObjectPropertyNames) {
      if (Object.hasOwn(candidate.fixedArguments, propertyName)) {
        throw new Error("fixedArguments 不能使用危险对象属性名");
      }
    }
  }
}

function adapterEnvironment(
  config: WorkItemMcpAdapterConfig,
  source: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> | null {
  const result: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"] as const) {
    const value = source[name];
    if (value) result[name] = validateEnvironmentValue(value);
  }
  let complete = true;
  for (const [childName, sourceName] of Object.entries(config.secretEnv)) {
    const value = source[sourceName];
    if (!value) {
      complete = false;
      continue;
    }
    result[childName] = validateEnvironmentValue(value);
  }
  return complete ? result : null;
}

function validateEnvironmentValue(value: string): string {
  if (value.length > 65_536 || value.includes("\u0000")) {
    throw new Error("Work Item MCP 环境变量值格式无效");
  }
  return value;
}

function extractToolPayload(result: unknown): unknown {
  if (!isRecord(result)) throw invalidPayloadError();
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (!Array.isArray(result.content)) throw invalidPayloadError();
  for (const item of result.content) {
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") continue;
    const parsed = parseJsonText(item.text);
    if (parsed !== undefined) return parsed;
  }
  throw invalidPayloadError();
}

function parseJsonText(text: string): unknown | undefined {
  let candidate = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/iu.exec(candidate);
  if (fenced?.[1]) candidate = fenced[1].trim();
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

function normalizeWorkItem(
  config: WorkItemMcpAdapterConfig,
  reference: string,
  payload: unknown,
  fetchedAt: Date,
): WorkItemDraftDto {
  const title = scalarString(readMapping(payload, config.mapping.title));
  if (!title) throw mappingError("title");
  const description = config.mapping.description
    ? plainText(readMapping(payload, config.mapping.description))
    : "";
  const externalId = config.mapping.externalId
    ? scalarString(readMapping(payload, config.mapping.externalId))
    : reference;
  if (!externalId) throw mappingError("externalId");
  const rawUrl = config.mapping.url
    ? scalarString(readMapping(payload, config.mapping.url))
    : null;
  const acceptanceCriteria = config.mapping.acceptanceCriteria
    ? stringList(readMapping(payload, config.mapping.acceptanceCriteria))
    : [];
  const labels = config.mapping.labels
    ? stringList(readMapping(payload, config.mapping.labels))
    : [];
  const suggestedWorkType = config.mapping.suggestedWorkType
    ? mappedWorkType(readMapping(payload, config.mapping.suggestedWorkType), config.defaultWorkType)
    : config.defaultWorkType;
  const normalized = {
    title,
    description,
    suggestedWorkType,
    acceptanceCriteria,
    labels,
  };
  const fingerprint = createHash("sha256").update(JSON.stringify({
    adapterId: config.id,
    reference,
    externalId,
    url: rawUrl,
    ...normalized,
  })).digest("hex");

  try {
    return workItemDraftSchema.parse({
      source: {
        kind: "mcp",
        adapterId: config.id,
        adapterLabel: config.label,
        reference,
        externalId,
        url: rawUrl,
        fetchedAt: fetchedAt.toISOString(),
        fingerprint,
      },
      ...normalized,
    });
  } catch {
    throw new AppError(
      "Work Item 内容超过平台限制或格式不正确",
      422,
      "WORK_ITEM_CONTENT_INVALID",
    );
  }
}

function readMapping(payload: unknown, mappingPath: string): unknown {
  let current = payload;
  for (const segment of mappingPath.split(".")) {
    if (Array.isArray(current) && /^\d+$/u.test(segment)) {
      current = current[Number(segment)];
      continue;
    }
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function scalarString(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function plainText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.map(plainText).filter(Boolean).join("\n").trim();
  }
  if (!isRecord(value)) return "";
  if (typeof value.text === "string") return value.text.trim();
  if (Array.isArray(value.content)) return plainText(value.content);
  return "";
}

function stringList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  const normalized = values.flatMap((entry) => {
    const direct = scalarString(entry);
    if (direct) return [direct];
    if (isRecord(entry)) {
      const named = scalarString(entry.name) ?? scalarString(entry.label) ?? plainText(entry);
      return named ? [named] : [];
    }
    return [];
  });
  return [...new Set(normalized)];
}

function mappedWorkType(value: unknown, fallback: WorkType): WorkType {
  const candidate = scalarString(value)?.toLowerCase();
  const parsed = workTypeSchema.safeParse(candidate);
  return parsed.success ? parsed.data : fallback;
}

function cloneJsonObject(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function validateJsonValue(value: unknown): string | null {
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > 1_000 || depth > 8) return false;
    if (candidate === null || typeof candidate === "boolean") return true;
    if (typeof candidate === "string") return candidate.length <= 10_000;
    if (typeof candidate === "number") return Number.isFinite(candidate);
    if (Array.isArray(candidate)) return candidate.length <= 100
      && candidate.every((entry) => visit(entry, depth + 1));
    if (!isRecord(candidate) || Object.keys(candidate).length > 100) return false;
    return Object.entries(candidate).every(([key, entry]) => (
      /^[A-Za-z0-9_.-]{1,200}$/u.test(key)
      && isSafeObjectPropertyName(key)
      && visit(entry, depth + 1)
    ));
  };
  return visit(value, 0) ? null : "fixedArguments 必须是小型、安全的 JSON object";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidPayloadError(): AppError {
  return new AppError(
    "Work Item MCP 没有返回可解析的结构化内容",
    502,
    "WORK_ITEM_MCP_PAYLOAD_INVALID",
  );
}

function mappingError(field: string): AppError {
  return new AppError(
    `Work Item MCP 返回内容缺少 ${field}`,
    502,
    "WORK_ITEM_MCP_MAPPING_FAILED",
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Work Item MCP 并发上限必须是 ${minimum} 到 ${maximum} 之间的整数`);
  }
  return value;
}
