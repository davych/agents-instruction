import { constants as fsConstants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import path from "node:path";

import { safeRepositoryRelativePathSchema } from "@ai-sdlc/contracts";
import { z } from "zod";

import type {
  AskLlmFunctionTool,
  AskLlmToolCall,
} from "../llm/types.js";
import { isWithin } from "../project-paths.js";

const MAX_SOURCE_FILE_BYTES = 512 * 1_024;
const MAX_WRITE_BYTES = 192 * 1_024;
const MAX_TOOL_OUTPUT_CHARACTERS = 48_000;
const MAX_SEARCHED_FILES = 600;
const MAX_SEARCHED_BYTES = 4 * 1_024 * 1_024;
const SKIPPED_DIRECTORY_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".aws",
  ".ssh",
  "node_modules",
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "build",
  "target",
]);

const listFilesArgumentsSchema = z.object({
  path: z.string().trim().min(1).max(4_096),
  maxDepth: z.number().int().min(1).max(8),
  maxEntries: z.number().int().min(1).max(500),
}).strict();

const readFileArgumentsSchema = z.object({
  path: safeRepositoryRelativePathSchema,
  startLine: z.number().int().min(1).max(100_000),
  endLine: z.number().int().min(1).max(100_000),
}).strict().refine(({ startLine, endLine }) => endLine >= startLine, {
  message: "endLine 不能小于 startLine",
});

const searchTextArgumentsSchema = z.object({
  path: z.string().trim().min(1).max(4_096),
  query: z.string().min(1).max(300),
  caseSensitive: z.boolean(),
  maxResults: z.number().int().min(1).max(200),
}).strict();

const writeFileArgumentsSchema = z.object({
  path: safeRepositoryRelativePathSchema,
  content: z.string().max(MAX_WRITE_BYTES),
  overwrite: z.boolean(),
}).strict();

const applyPatchArgumentsSchema = z.object({
  path: safeRepositoryRelativePathSchema,
  oldText: z.string().min(1).max(96_000),
  newText: z.string().max(96_000),
  replaceAll: z.boolean(),
}).strict();

const runCheckArgumentsSchema = z.object({
  checkId: z.string().trim().min(1).max(80)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
}).strict();

export type RootedAgentAccessMode = "read-only" | "sandbox-write";

export interface AgentSandboxCheckDefinition {
  id: string;
  label: string;
  timeoutMs: number;
}

export interface AgentSandboxCheckResult {
  exitCode: number;
  output: string;
  durationMs: number;
}

/**
 * This port must be implemented by a real container or microVM worker. The API
 * process intentionally has no built-in shell/process implementation: a repo's
 * test script is arbitrary code and a cwd check alone is not a sandbox.
 */
export interface AgentSandboxCheckRunner {
  readonly isolation: "container" | "microvm";
  definitions(): readonly AgentSandboxCheckDefinition[];
  run(input: {
    checkId: string;
    workspaceRoot: string;
    timeoutMs: number;
    maxOutputBytes: number;
    signal: AbortSignal;
  }): Promise<AgentSandboxCheckResult>;
}

export interface ProviderAgentToolExecution {
  summary: string;
  content: string;
  changedPaths: readonly string[];
}

export interface ProviderAgentToolHost {
  readonly accessMode: RootedAgentAccessMode;
  definitions(): readonly AskLlmFunctionTool[];
  execute(
    call: AskLlmToolCall,
    options: { signal: AbortSignal; maxOutputCharacters: number },
  ): Promise<ProviderAgentToolExecution>;
}

export class ProviderAgentToolError extends Error {
  constructor(
    readonly code: string,
    readonly safeMessage: string,
    readonly fatal = false,
  ) {
    super(safeMessage);
    this.name = "ProviderAgentToolError";
  }
}

export class RootedAgentToolHost implements ProviderAgentToolHost {
  private constructor(
    private readonly rootPath: string,
    readonly accessMode: RootedAgentAccessMode,
    private readonly checkRunner?: AgentSandboxCheckRunner,
    private readonly checkDefinitions: readonly AgentSandboxCheckDefinition[] = [],
  ) {}

  static async create(input: {
    rootPath: string;
    accessMode: RootedAgentAccessMode;
    checkRunner?: AgentSandboxCheckRunner;
  }): Promise<RootedAgentToolHost> {
    const canonicalRoot = await realpath(path.resolve(input.rootPath));
    const rootStat = await stat(canonicalRoot);
    if (!rootStat.isDirectory()) {
      throw new ProviderAgentToolError("AGENT_WORKSPACE_INVALID", "Sandbox Workspace 不是目录");
    }
    if (
      input.checkRunner
      && input.checkRunner.isolation !== "container"
      && input.checkRunner.isolation !== "microvm"
    ) {
      throw new Error("Sandbox check Runner 没有声明真实隔离边界");
    }
    const checkDefinitions = input.checkRunner
      ? input.checkRunner.definitions().map((definition) => ({ ...definition }))
      : [];
    validateCheckDefinitions(checkDefinitions);
    return new RootedAgentToolHost(
      canonicalRoot,
      input.accessMode,
      input.checkRunner,
      checkDefinitions,
    );
  }

  definitions(): readonly AskLlmFunctionTool[] {
    const tools: AskLlmFunctionTool[] = [LIST_FILES_TOOL, READ_FILE_TOOL, SEARCH_TEXT_TOOL];
    if (this.accessMode === "sandbox-write") tools.push(WRITE_FILE_TOOL, APPLY_PATCH_TOOL);
    if (
      this.accessMode === "sandbox-write"
      && this.checkRunner
      && this.checkDefinitions.length > 0
    ) {
      const checks = this.checkDefinitions;
      tools.push({
        type: "function",
        name: "run_check",
        description: "运行 Sandbox Blueprint 预先批准的一项检查。只能使用 checkId，不能提交命令、参数、环境变量或宿主路径。",
        strict: true,
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["checkId"],
          properties: {
            checkId: {
              type: "string",
              enum: checks.map(({ id }) => id),
              description: checks.map(({ id, label }) => `${id}: ${label}`).join("；"),
            },
          },
        },
      });
    }
    return tools;
  }

  async execute(
    call: AskLlmToolCall,
    options: { signal: AbortSignal; maxOutputCharacters: number },
  ): Promise<ProviderAgentToolExecution> {
    assertNotAborted(options.signal);
    const outputLimit = Math.min(
      Math.max(1, options.maxOutputCharacters),
      MAX_TOOL_OUTPUT_CHARACTERS,
    );
    try {
      switch (call.name) {
        case "list_files":
          return await this.listFiles(listFilesArgumentsSchema.parse(call.arguments), outputLimit);
        case "read_file":
          return await this.readSource(readFileArgumentsSchema.parse(call.arguments), outputLimit);
        case "search_text":
          return await this.searchText(searchTextArgumentsSchema.parse(call.arguments), outputLimit);
        case "write_file":
          this.assertWritable();
          return await this.writeSource(writeFileArgumentsSchema.parse(call.arguments));
        case "apply_patch":
          this.assertWritable();
          return await this.applyPatch(applyPatchArgumentsSchema.parse(call.arguments));
        case "run_check":
          this.assertWritable();
          return await this.runCheck(
            runCheckArgumentsSchema.parse(call.arguments),
            options.signal,
            outputLimit,
          );
        default:
          throw new ProviderAgentToolError(
            "AGENT_TOOL_NOT_ALLOWED",
            "模型选择了未向本轮开放的工具，平台已拒绝执行",
          );
      }
    } catch (error) {
      if (error instanceof ProviderAgentToolError) throw error;
      if (error instanceof z.ZodError) {
        throw new ProviderAgentToolError(
          "AGENT_TOOL_ARGUMENTS_INVALID",
          "工具参数不符合平台约束，未执行",
        );
      }
      throw new ProviderAgentToolError("AGENT_TOOL_FAILED", safeFileError(error));
    }
  }

  private async listFiles(
    input: z.infer<typeof listFilesArgumentsSchema>,
    outputLimit: number,
  ): Promise<ProviderAgentToolExecution> {
    const relative = parseBrowsablePath(input.path);
    const directory = await this.resolveExisting(relative, "directory");
    const entries: string[] = [];
    await walkTree({
      absoluteRoot: directory,
      relativeRoot: relative,
      depth: 0,
      maxDepth: input.maxDepth,
      maxEntries: input.maxEntries,
      entries,
    });
    const omitted = entries.length >= input.maxEntries;
    const content = boundedText(
      entries.join("\n") || "（目录为空，或内容均属于平台禁止暴露的路径。）",
      outputLimit,
    );
    return {
      summary: omitted
        ? `列出 ${entries.length} 项，已达到上限`
        : `列出 ${entries.length} 项`,
      content,
      changedPaths: [],
    };
  }

  private async readSource(
    input: z.infer<typeof readFileArgumentsSchema>,
    outputLimit: number,
  ): Promise<ProviderAgentToolExecution> {
    const relative = parseRepositoryPath(input.path);
    const absolute = await this.resolveExisting(relative, "file");
    const content = await readUtf8Source(absolute);
    const lines = content.split(/\r?\n/u);
    if (input.startLine > lines.length) {
      throw new ProviderAgentToolError(
        "AGENT_FILE_RANGE_INVALID",
        `起始行超出文件范围；文件共 ${lines.length} 行`,
      );
    }
    const endLine = Math.min(input.endLine, input.startLine + 399, lines.length);
    const selected = lines.slice(input.startLine - 1, endLine)
      .map((line, index) => `${input.startLine + index}: ${line}`)
      .join("\n");
    const redacted = redactLikelySecrets(selected);
    return {
      summary: redacted.redacted
        ? `读取 ${relative} 第 ${input.startLine}-${endLine} 行；疑似 Secret 已隐藏`
        : `读取 ${relative} 第 ${input.startLine}-${endLine} 行`,
      content: boundedText(redacted.text, outputLimit),
      changedPaths: [],
    };
  }

  private async searchText(
    input: z.infer<typeof searchTextArgumentsSchema>,
    outputLimit: number,
  ): Promise<ProviderAgentToolExecution> {
    const relative = parseBrowsablePath(input.path);
    const directory = await this.resolveExisting(relative, "directory");
    const files = await collectSourceFiles(directory, relative);
    const needle = input.caseSensitive ? input.query : input.query.toLocaleLowerCase("en-US");
    const matches: string[] = [];
    let searchedBytes = 0;
    let searchedFiles = 0;
    for (const file of files) {
      if (matches.length >= input.maxResults || searchedFiles >= MAX_SEARCHED_FILES) break;
      const fileStat = await stat(file.absolute);
      if (fileStat.size > MAX_SOURCE_FILE_BYTES || searchedBytes + fileStat.size > MAX_SEARCHED_BYTES) continue;
      let source: string;
      try {
        source = await readUtf8Source(file.absolute);
      } catch (error) {
        if (error instanceof ProviderAgentToolError && error.code === "AGENT_FILE_NOT_TEXT") continue;
        throw error;
      }
      searchedBytes += fileStat.size;
      searchedFiles += 1;
      const lines = source.split(/\r?\n/u);
      for (let index = 0; index < lines.length && matches.length < input.maxResults; index += 1) {
        const line = lines[index] ?? "";
        const haystack = input.caseSensitive ? line : line.toLocaleLowerCase("en-US");
        if (!haystack.includes(needle)) continue;
        const excerpt = redactLikelySecrets(line.slice(0, 500)).text;
        matches.push(`${file.relative}:${index + 1}: ${excerpt}`);
      }
    }
    return {
      summary: `在 ${searchedFiles} 个文本文件中找到 ${matches.length} 处`,
      content: boundedText(matches.join("\n") || "没有找到匹配内容。", outputLimit),
      changedPaths: [],
    };
  }

  private async writeSource(
    input: z.infer<typeof writeFileArgumentsSchema>,
  ): Promise<ProviderAgentToolExecution> {
    const relative = parseRepositoryPath(input.path);
    assertNoSecretMaterial(input.content);
    const target = await this.resolveWritableFile(relative, input.overwrite);
    await writeUtf8NoFollow(target, input.content, input.overwrite);
    return {
      summary: `${input.overwrite ? "写入" : "创建"} ${relative}（${Buffer.byteLength(input.content, "utf8")} bytes）`,
      content: "文件已在当前 Session Sandbox 内更新。",
      changedPaths: [relative],
    };
  }

  private async applyPatch(
    input: z.infer<typeof applyPatchArgumentsSchema>,
  ): Promise<ProviderAgentToolExecution> {
    const relative = parseRepositoryPath(input.path);
    const absolute = await this.resolveWritableFile(relative, true);
    const current = await readUtf8Source(absolute);
    const occurrences = countOccurrences(current, input.oldText);
    if (occurrences === 0) {
      throw new ProviderAgentToolError(
        "AGENT_PATCH_CONTEXT_MISSING",
        "补丁的 oldText 在目标文件中不存在，文件未改动",
      );
    }
    if (!input.replaceAll && occurrences !== 1) {
      throw new ProviderAgentToolError(
        "AGENT_PATCH_CONTEXT_AMBIGUOUS",
        `补丁的 oldText 出现 ${occurrences} 次；请提供更精确上下文`,
      );
    }
    const updated = input.replaceAll
      ? current.split(input.oldText).join(input.newText)
      : current.replace(input.oldText, input.newText);
    if (Buffer.byteLength(updated, "utf8") > MAX_WRITE_BYTES) {
      throw new ProviderAgentToolError("AGENT_FILE_TOO_LARGE", "补丁后的文件超过 Sandbox 写入上限");
    }
    assertNoSecretMaterial(updated);
    await writeUtf8NoFollow(absolute, updated, true);
    return {
      summary: `补丁已应用到 ${relative}${input.replaceAll ? `（${occurrences} 处）` : ""}`,
      content: "文件已在当前 Session Sandbox 内更新。",
      changedPaths: [relative],
    };
  }

  private async runCheck(
    input: z.infer<typeof runCheckArgumentsSchema>,
    signal: AbortSignal,
    outputLimit: number,
  ): Promise<ProviderAgentToolExecution> {
    if (!this.checkRunner) {
      throw new ProviderAgentToolError(
        "AGENT_CHECK_RUNNER_UNAVAILABLE",
        "当前 Sandbox 没有注册隔离测试 Runner，未在 API 宿主执行命令",
      );
    }
    const definition = this.checkDefinitions.find(({ id }) => id === input.checkId);
    if (!definition) {
      throw new ProviderAgentToolError(
        "AGENT_CHECK_NOT_ALLOWED",
        "该检查不在 Sandbox Blueprint 的批准列表中",
      );
    }
    const result = await this.checkRunner.run({
      checkId: definition.id,
      workspaceRoot: this.rootPath,
      timeoutMs: definition.timeoutMs,
      maxOutputBytes: Math.min(outputLimit * 4, 192_000),
      signal,
    });
    if (!Number.isSafeInteger(result.exitCode) || result.durationMs < 0) {
      throw new ProviderAgentToolError("AGENT_CHECK_RESULT_INVALID", "Sandbox Runner 返回了无效结果");
    }
    const redacted = redactLikelySecrets(result.output);
    return {
      summary: `${definition.label} ${result.exitCode === 0 ? "通过" : `失败（exit ${result.exitCode}）`}，耗时 ${Math.round(result.durationMs)}ms`,
      content: boundedText(redacted.text || "（检查没有输出。）", outputLimit),
      changedPaths: [],
    };
  }

  private assertWritable(): void {
    if (this.accessMode !== "sandbox-write") {
      throw new ProviderAgentToolError(
        "AGENT_WORKSPACE_READ_ONLY",
        "当前 @repo 不是本 Session 的可写主仓库，平台已拒绝修改",
      );
    }
  }

  private async resolveExisting(
    relative: string,
    kind: "file" | "directory",
  ): Promise<string> {
    const absolute = path.resolve(this.rootPath, relative === "." ? "" : relative);
    this.assertWithinRoot(absolute);
    await assertPathHasNoSymlink(this.rootPath, relative, false);
    const canonical = await realpath(absolute);
    this.assertWithinRoot(canonical);
    const targetStat = await stat(canonical);
    if (kind === "file" ? !targetStat.isFile() : !targetStat.isDirectory()) {
      throw new ProviderAgentToolError(
        "AGENT_PATH_KIND_INVALID",
        kind === "file" ? "目标不是普通文本文件" : "目标不是目录",
      );
    }
    return canonical;
  }

  private async resolveWritableFile(relative: string, overwrite: boolean): Promise<string> {
    const absolute = path.resolve(this.rootPath, relative);
    this.assertWithinRoot(absolute);
    const parentRelative = path.posix.dirname(relative);
    await this.resolveExisting(parentRelative === "." ? "." : parentRelative, "directory");
    try {
      const targetStat = await lstat(absolute);
      if (targetStat.isSymbolicLink() || !targetStat.isFile() || targetStat.nlink !== 1) {
        throw new ProviderAgentToolError(
          "AGENT_PATH_KIND_INVALID",
          "目标不是可写的单链接普通文件",
        );
      }
      if (!overwrite) {
        throw new ProviderAgentToolError(
          "AGENT_FILE_EXISTS",
          "目标文件已存在；只有明确 overwrite 才能覆盖",
        );
      }
      const canonical = await realpath(absolute);
      this.assertWithinRoot(canonical);
      return canonical;
    } catch (error) {
      if (error instanceof ProviderAgentToolError) throw error;
      if (isNodeError(error) && error.code === "ENOENT") return absolute;
      throw error;
    }
  }

  private assertWithinRoot(candidate: string): void {
    if (!isWithin(this.rootPath, candidate)) {
      throw new ProviderAgentToolError(
        "AGENT_PATH_OUTSIDE_WORKSPACE",
        "工具路径超出当前 Session Sandbox，平台已拒绝",
      );
    }
  }
}

const LIST_FILES_TOOL: AskLlmFunctionTool = {
  type: "function",
  name: "list_files",
  description: "列出当前 Session Sandbox 中某个目录下的文件。path 使用仓库相对路径，根目录写成 .；不会跟随符号链接。",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path", "maxDepth", "maxEntries"],
    properties: {
      path: { type: "string" },
      maxDepth: { type: "integer", minimum: 1, maximum: 8 },
      maxEntries: { type: "integer", minimum: 1, maximum: 500 },
    },
  },
};

const READ_FILE_TOOL: AskLlmFunctionTool = {
  type: "function",
  name: "read_file",
  description: "按行读取当前 Session Sandbox 内一个 UTF-8 文本文件。每次最多返回 400 行；Secret 会被隐藏。",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path", "startLine", "endLine"],
    properties: {
      path: { type: "string" },
      startLine: { type: "integer", minimum: 1 },
      endLine: { type: "integer", minimum: 1 },
    },
  },
};

const SEARCH_TEXT_TOOL: AskLlmFunctionTool = {
  type: "function",
  name: "search_text",
  description: "在当前 Session Sandbox 的文本源码中做字面量搜索，不支持正则，不读取敏感或生成目录。",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path", "query", "caseSensitive", "maxResults"],
    properties: {
      path: { type: "string" },
      query: { type: "string" },
      caseSensitive: { type: "boolean" },
      maxResults: { type: "integer", minimum: 1, maximum: 200 },
    },
  },
};

const WRITE_FILE_TOOL: AskLlmFunctionTool = {
  type: "function",
  name: "write_file",
  description: "在可写主仓库的 Session Sandbox 内创建或完整写入一个 UTF-8 文本文件。不能创建目录、写 Secret 或越出根目录。",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path", "content", "overwrite"],
    properties: {
      path: { type: "string" },
      content: { type: "string" },
      overwrite: { type: "boolean" },
    },
  },
};

const APPLY_PATCH_TOOL: AskLlmFunctionTool = {
  type: "function",
  name: "apply_patch",
  description: "在可写主仓库的 Session Sandbox 内用精确 oldText 替换应用小补丁。默认 oldText 必须只出现一次。",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path", "oldText", "newText", "replaceAll"],
    properties: {
      path: { type: "string" },
      oldText: { type: "string" },
      newText: { type: "string" },
      replaceAll: { type: "boolean" },
    },
  },
};

function parseBrowsablePath(candidate: string): string {
  if (candidate === ".") return ".";
  return parseRepositoryPath(candidate);
}

function parseRepositoryPath(candidate: string): string {
  const parsed = safeRepositoryRelativePathSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ProviderAgentToolError(
      "AGENT_PATH_INVALID",
      "工具路径必须是安全的仓库相对路径",
    );
  }
  const normalized = parsed.data.split("/").join(path.sep);
  if (isSensitiveRelativePath(parsed.data)) {
    throw new ProviderAgentToolError(
      "AGENT_SENSITIVE_PATH_FORBIDDEN",
      "该路径可能包含凭据或版本库内部数据，平台不会向模型暴露或写入",
    );
  }
  return normalized;
}

function isSensitiveRelativePath(candidate: string): boolean {
  const parts = candidate.toLocaleLowerCase("en-US").split(/[\\/]/u);
  const basename = parts.at(-1) ?? "";
  if (parts.some((part) => [".git", ".ssh", ".aws", ".gnupg"].includes(part))) return true;
  if (/^\.env(?:\.|$)/u.test(basename) && !/^\.env\.(?:example|sample|template)$/u.test(basename)) {
    return true;
  }
  return /^(?:\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials\.json|id_(?:rsa|dsa|ecdsa|ed25519))$/u.test(basename)
    || /\.(?:pem|p12|pfx|key|keystore|jks)$/u.test(basename);
}

async function assertPathHasNoSymlink(
  rootPath: string,
  relative: string,
  allowMissingLeaf: boolean,
): Promise<void> {
  if (relative === ".") return;
  const components = relative.split(path.sep);
  let cursor = rootPath;
  for (let index = 0; index < components.length; index += 1) {
    cursor = path.join(cursor, components[index]!);
    try {
      const entry = await lstat(cursor);
      if (entry.isSymbolicLink()) {
        throw new ProviderAgentToolError(
          "AGENT_SYMLINK_FORBIDDEN",
          "工具路径包含符号链接，平台已拒绝访问",
        );
      }
    } catch (error) {
      if (
        allowMissingLeaf
        && index === components.length - 1
        && isNodeError(error)
        && error.code === "ENOENT"
      ) return;
      throw error;
    }
  }
}

async function walkTree(input: {
  absoluteRoot: string;
  relativeRoot: string;
  depth: number;
  maxDepth: number;
  maxEntries: number;
  entries: string[];
}): Promise<void> {
  if (input.entries.length >= input.maxEntries) return;
  const children = (await readdir(input.absoluteRoot, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const child of children) {
    if (input.entries.length >= input.maxEntries) return;
    const relative = input.relativeRoot === "." ? child.name : path.join(input.relativeRoot, child.name);
    if (isSensitiveRelativePath(relative)) continue;
    if (child.isSymbolicLink()) continue;
    if (child.isDirectory()) {
      if (SKIPPED_DIRECTORY_NAMES.has(child.name)) continue;
      input.entries.push(`${relative.split(path.sep).join("/")}/`);
      if (input.depth + 1 < input.maxDepth) {
        await walkTree({
          ...input,
          absoluteRoot: path.join(input.absoluteRoot, child.name),
          relativeRoot: relative,
          depth: input.depth + 1,
        });
      }
    } else if (child.isFile()) {
      const fileStat = await stat(path.join(input.absoluteRoot, child.name));
      input.entries.push(`${relative.split(path.sep).join("/")} (${fileStat.size} bytes)`);
    }
  }
}

async function collectSourceFiles(
  absoluteRoot: string,
  relativeRoot: string,
): Promise<Array<{ absolute: string; relative: string }>> {
  const collected: Array<{ absolute: string; relative: string }> = [];
  async function visit(directory: string, relativeDirectory: string, depth: number): Promise<void> {
    if (depth > 10 || collected.length >= MAX_SEARCHED_FILES * 2) return;
    const children = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const child of children) {
      if (collected.length >= MAX_SEARCHED_FILES * 2) return;
      const relative = relativeDirectory === "."
        ? child.name
        : path.join(relativeDirectory, child.name);
      if (isSensitiveRelativePath(relative) || child.isSymbolicLink()) continue;
      if (child.isDirectory()) {
        if (SKIPPED_DIRECTORY_NAMES.has(child.name)) continue;
        await visit(path.join(directory, child.name), relative, depth + 1);
      } else if (child.isFile()) {
        collected.push({
          absolute: path.join(directory, child.name),
          relative: relative.split(path.sep).join("/"),
        });
      }
    }
  }
  await visit(absoluteRoot, relativeRoot, 0);
  return collected;
}

async function readUtf8Source(absolute: string): Promise<string> {
  const fileStat = await stat(absolute);
  if (!fileStat.isFile()) {
    throw new ProviderAgentToolError("AGENT_PATH_KIND_INVALID", "目标不是普通文件");
  }
  if (fileStat.size > MAX_SOURCE_FILE_BYTES) {
    throw new ProviderAgentToolError("AGENT_FILE_TOO_LARGE", "文件超过单次源码读取上限");
  }
  const buffer = await readFile(absolute);
  if (buffer.includes(0)) {
    throw new ProviderAgentToolError("AGENT_FILE_NOT_TEXT", "目标不是 UTF-8 文本文件");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new ProviderAgentToolError("AGENT_FILE_NOT_TEXT", "目标不是 UTF-8 文本文件");
  }
}

async function writeUtf8NoFollow(
  absolute: string,
  content: string,
  overwrite: boolean,
): Promise<void> {
  const flags = fsConstants.O_WRONLY
    | fsConstants.O_CREAT
    | fsConstants.O_NOFOLLOW
    | (overwrite ? fsConstants.O_TRUNC : fsConstants.O_EXCL);
  const handle = await open(absolute, flags, 0o644);
  try {
    await handle.writeFile(content, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function countOccurrences(source: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= source.length - needle.length) {
    const found = source.indexOf(needle, offset);
    if (found < 0) break;
    count += 1;
    offset = found + needle.length;
  }
  return count;
}

function validateCheckDefinitions(definitions: readonly AgentSandboxCheckDefinition[]): void {
  const ids = new Set<string>();
  if (definitions.length > 32) throw new Error("Sandbox check 数量超过上限");
  for (const definition of definitions) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u.test(definition.id)
      || ids.has(definition.id)
      || !definition.label.trim()
      || definition.label.length > 200
      || !Number.isSafeInteger(definition.timeoutMs)
      || definition.timeoutMs < 1_000
      || definition.timeoutMs > 10 * 60_000
    ) {
      throw new Error("Sandbox check 定义无效");
    }
    ids.add(definition.id);
  }
}

const OUTPUT_SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu,
  /\bAKIA[A-Z0-9]{16}\b/gu,
  /((?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["']?)([^\s"';,]{12,})/giu,
];

const WRITE_SECRET_PATTERNS: readonly RegExp[] = OUTPUT_SECRET_PATTERNS.slice(0, 5);

export function containsLikelySecret(source: string): boolean {
  if (WRITE_SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(source);
  })) return true;
  const labelledSecret = OUTPUT_SECRET_PATTERNS[5]!;
  labelledSecret.lastIndex = 0;
  for (const match of source.matchAll(labelledSecret)) {
    const value = (match[2] ?? "").toLocaleLowerCase("en-US");
    if (!isClearlyNonSecretValue(value)) return true;
  }
  return false;
}

export function redactLikelySecrets(source: string): { text: string; redacted: boolean } {
  let text = source;
  for (const pattern of OUTPUT_SECRET_PATTERNS.slice(0, 5)) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, "[REDACTED]");
  }
  const labelledSecret = OUTPUT_SECRET_PATTERNS[5]!;
  labelledSecret.lastIndex = 0;
  text = text.replace(labelledSecret, "$1[REDACTED]");
  return { text, redacted: text !== source };
}

function assertNoSecretMaterial(source: string): void {
  if (containsLikelySecret(source)) {
    throw new ProviderAgentToolError(
      "AGENT_SECRET_WRITE_FORBIDDEN",
      "写入内容包含疑似真实 Secret，平台已拒绝；请只写变量名或占位符",
    );
  }
}

function boundedText(source: string, maxCharacters: number): string {
  if (source.length <= maxCharacters) return source;
  const marker = "\n…（输出已达到平台上限）";
  if (maxCharacters <= marker.length) return marker.slice(0, maxCharacters);
  return `${source.slice(0, maxCharacters - marker.length)}${marker}`;
}

function isClearlyNonSecretValue(value: string): boolean {
  return /^(?:process\.env\b|import\.meta\.env\b|os\.getenv\b|system\.getenv\b|env\.|config\.get\b|\$\{|<|\[|your[_-]|example|placeholder|change[_-]?me|dummy|test[_-]?only)/u.test(value);
}

function safeFileError(error: unknown): string {
  if (isNodeError(error)) {
    if (error.code === "ENOENT") return "目标路径不存在，未执行";
    if (error.code === "EACCES" || error.code === "EPERM") return "Sandbox 拒绝访问该路径";
    if (error.code === "EEXIST") return "目标文件已存在，未覆盖";
    if (error.code === "ELOOP") return "路径包含符号链接，平台已拒绝";
  }
  return "Sandbox 工具执行失败；内部路径和错误细节未暴露给模型";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ProviderAgentToolError("AGENT_TOOL_CANCELLED", "工具执行已取消");
  }
}
