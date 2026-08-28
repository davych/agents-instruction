import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";

import {
  gitRevisionSchema,
  knowledgeSummarySchema,
  safeRepositoryRelativePathSchema,
  type GitRevision,
  type KnowledgePathSignalDto,
} from "@ai-sdlc/contracts";
import { z } from "zod";

import { AppError } from "../domain/errors.js";
import {
  NullDelimitedCommandError,
  streamNullDelimitedCommand,
} from "./null-delimited-command.js";

export interface DeepWikiLiteOptions {
  gitBinary?: string;
  gitTimeoutMs?: number;
  gitMaxBufferBytes?: number;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxSignalsPerKind?: number;
}

const deepWikiTagSchema = z.enum(["entry", "document", "test", "build", "key-path"]);

export const deepWikiIndexedFileSchema = z.object({
  path: safeRepositoryRelativePathSchema,
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  language: z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/u),
  tags: z.array(deepWikiTagSchema).max(5),
}).strict();
export type DeepWikiIndexedFile = z.infer<typeof deepWikiIndexedFileSchema>;

/**
 * The database keeps this internal index beside the public Knowledge summary.
 * Parsing it again at every trust boundary prevents a malformed or partially
 * overwritten JSON document from becoming retrieval or phase context.
 */
export const deepWikiLiteIndexSchema = z.object({
  version: z.literal(1),
  revision: gitRevisionSchema,
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/u),
  summary: knowledgeSummarySchema,
  files: z.array(deepWikiIndexedFileSchema),
}).strict();
export type DeepWikiLiteIndex = z.infer<typeof deepWikiLiteIndexSchema>;

const DEFAULTS = Object.freeze({
  gitTimeoutMs: 10_000,
  gitMaxBufferBytes: 16 * 1024 * 1024,
  maxFiles: 10_000,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxSignalsPerKind: 40,
});

const MAX_GIT_TREE_RECORD_BYTES = 16 * 1024;

interface DeepWikiLimits {
  gitTimeoutMs: number;
  gitMaxBufferBytes: number;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxSignalsPerKind: number;
}

const EXCLUDED_DIRECTORIES = new Set([
  ".git", "node_modules", ".pnpm-store", ".yarn", ".cache", ".next", ".nuxt",
  ".turbo", "dist", "build", "target", "coverage", ".pytest_cache", ".mypy_cache",
  ".ruff_cache", "__pycache__", ".gradle", ".venv", "venv", "vendor",
]);

const SENSITIVE_BASENAMES = new Set([
  ".env", ".env.local", ".env.production", ".npmrc", ".pypirc", ".netrc",
  ".git-credentials", "credentials", "credentials.json", "secrets.json", "auth.json",
  "kubeconfig", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
]);

interface GitTreeBlob {
  objectId: GitRevision;
  bytes: number;
  path: string;
}

export class DeepWikiLiteIndexer {
  private readonly gitBinary: string;
  private readonly limits: Readonly<DeepWikiLimits>;

  constructor(options: DeepWikiLiteOptions = {}) {
    this.gitBinary = options.gitBinary ?? "git";
    this.limits = Object.freeze({
      gitTimeoutMs: positive(options.gitTimeoutMs ?? DEFAULTS.gitTimeoutMs, "DeepWiki Git timeout"),
      gitMaxBufferBytes: positive(
        options.gitMaxBufferBytes ?? DEFAULTS.gitMaxBufferBytes,
        "DeepWiki Git buffer",
      ),
      maxFiles: positive(options.maxFiles ?? DEFAULTS.maxFiles, "DeepWiki file limit"),
      maxFileBytes: positive(options.maxFileBytes ?? DEFAULTS.maxFileBytes, "DeepWiki file bytes"),
      maxTotalBytes: positive(options.maxTotalBytes ?? DEFAULTS.maxTotalBytes, "DeepWiki total bytes"),
      maxSignalsPerKind: positive(
        options.maxSignalsPerKind ?? DEFAULTS.maxSignalsPerKind,
        "DeepWiki signal limit",
      ),
    });
  }

  /** Cheap binding used on cache hits before trusted knowledge is reused. */
  async assertRevision(input: {
    workspaceRoot: string;
    revision: GitRevision;
    signal?: AbortSignal;
  }): Promise<void> {
    await this.resolveWorkspaceAtRevision(input);
  }

  async build(input: {
    workspaceRoot: string;
    revision: GitRevision;
    signal?: AbortSignal;
  }): Promise<DeepWikiLiteIndex> {
    assertActive(input.signal);
    const expectedRevision = gitRevisionSchema.parse(input.revision);
    const workspaceRoot = await this.resolveWorkspaceAtRevision(input);
    const tree = await readGitTree(
      this.gitBinary,
      workspaceRoot,
      expectedRevision,
      this.limits,
      input.signal,
    );
    const trackedBlobs = tree.blobs.sort((left, right) => compareText(left.path, right.path));
    const manifest = createHash("sha256");
    manifest.update(`deepwiki-lite-v1\0${expectedRevision}\0`);
    const files: DeepWikiIndexedFile[] = [];
    const languageStats = new Map<string, { files: number; bytes: number }>();
    const signals = {
      entry: [] as KnowledgePathSignalDto[],
      document: [] as KnowledgePathSignalDto[],
      test: [] as KnowledgePathSignalDto[],
      build: [] as KnowledgePathSignalDto[],
      "key-path": [] as KnowledgePathSignalDto[],
    };
    let fileCount = 0;
    let totalBytes = 0;
    let bytesRead = 0;
    let truncated = tree.truncated;
    for (const blob of trackedBlobs) {
      assertActive(input.signal);
      const language = detectLanguage(blob.path);
      let content: Buffer | null = null;
      if (
        blob.bytes <= this.limits.maxFileBytes
        && bytesRead + blob.bytes <= this.limits.maxTotalBytes
      ) {
        content = await runGit(
          this.gitBinary,
          ["-C", workspaceRoot, "cat-file", "blob", blob.objectId],
          this.limits,
          input.signal,
        );
        bytesRead += content.length;
        if (content.length !== blob.bytes) {
          throw new AppError(
            "DeepWiki Git blob 大小与 tree 清单不一致",
            422,
            "KNOWLEDGE_GIT_OBJECT_INVALID",
          );
        }
        if (looksLikePrivateKey(content)) continue;
      } else {
        truncated = true;
      }
      fileCount += 1;
      totalBytes += blob.bytes;
      manifest.update(`${blob.path}\0${blob.bytes}\0${blob.objectId}\0`);
      const languageStat = languageStats.get(language) ?? { files: 0, bytes: 0 };
      languageStat.files += 1;
      languageStat.bytes += blob.bytes;
      languageStats.set(language, languageStat);
      if (!content || looksBinary(content)) continue;
      const sha256 = createHash("sha256").update(content).digest("hex");
      const tags = classifyPath(blob.path);
      files.push({ path: blob.path, bytes: content.length, sha256, language, tags });
      for (const tag of tags) {
        if (signals[tag].length >= this.limits.maxSignalsPerKind) {
          truncated = true;
          continue;
        }
        const signalSummary = describeSignal(tag, blob.path, language);
        if (signalSummary.length > 500) truncated = true;
        signals[tag].push({
          path: blob.path,
          kind: tag,
          summary: boundedText(signalSummary, 500),
        });
      }
    }
    const summary = knowledgeSummarySchema.parse({
      fileCount,
      totalBytes,
      languages: [...languageStats.entries()]
        .map(([language, counts]) => ({ language, ...counts }))
        .sort((left, right) => right.bytes - left.bytes || compareText(left.language, right.language)),
      entryPoints: signals.entry,
      documents: signals.document,
      tests: signals.test,
      builds: signals.build,
      keyPaths: signals["key-path"],
      truncated,
    });
    return deepWikiLiteIndexSchema.parse({
      version: 1,
      revision: expectedRevision,
      manifestHash: manifest.digest("hex"),
      summary,
      files,
    });
  }

  private async resolveWorkspaceAtRevision(input: {
    workspaceRoot: string;
    revision: GitRevision;
    signal?: AbortSignal;
  }): Promise<string> {
    assertActive(input.signal);
    const expectedRevision = gitRevisionSchema.parse(input.revision);
    const workspaceRoot = await realpath(input.workspaceRoot);
    const actualRevision = gitRevisionSchema.parse((await runGit(
      this.gitBinary,
      ["-C", workspaceRoot, "rev-parse", "--verify", "HEAD"],
      this.limits,
      input.signal,
    )).toString("utf8").trim());
    if (actualRevision !== expectedRevision) {
      throw new AppError(
        "DeepWiki Workspace revision 与请求不一致",
        409,
        "KNOWLEDGE_REVISION_MISMATCH",
      );
    }
    return workspaceRoot;
  }
}

function runGit(
  gitBinary: string,
  args: readonly string[],
  limits: Readonly<DeepWikiLimits>,
  signal?: AbortSignal,
): Promise<Buffer> {
  assertActive(signal);
  return new Promise((resolve, reject) => {
    execFile(gitBinary, [...args], {
      encoding: null,
      timeout: limits.gitTimeoutMs,
      maxBuffer: limits.gitMaxBufferBytes,
      windowsHide: true,
      shell: false,
      signal,
      env: {
        PATH: process.env.PATH,
        LANG: "C",
        LC_ALL: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_OPTIONAL_LOCKS: "0",
      },
    }, (error, stdout) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code;
        reject(new AppError(
          code === "ABORT_ERR" ? "DeepWiki 索引已取消" : "DeepWiki 无法读取 Git 清单",
          code === "ABORT_ERR" ? 499 : 422,
          code === "ABORT_ERR" ? "KNOWLEDGE_CANCELLED" : "KNOWLEDGE_GIT_FAILED",
        ));
        return;
      }
      resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
    });
  });
}

async function readGitTree(
  gitBinary: string,
  workspaceRoot: string,
  revision: GitRevision,
  limits: Readonly<DeepWikiLimits>,
  signal?: AbortSignal,
): Promise<{ blobs: GitTreeBlob[]; truncated: boolean }> {
  const blobs: GitTreeBlob[] = [];
  try {
    const result = await streamNullDelimitedCommand({
      command: gitBinary,
      args: ["-C", workspaceRoot, "ls-tree", "-r", "-z", "-l", "--full-tree", revision],
      environment: deepWikiGitEnvironment(),
      timeoutMs: limits.gitTimeoutMs,
      maxStderrBytes: limits.gitMaxBufferBytes,
      maxRecordBytes: MAX_GIT_TREE_RECORD_BYTES,
      signal,
      onRecord: (record) => {
        if (record.length === 0) return true;
        const blob = parseGitTreeRecord(record);
        if (!blob || isExcludedPath(blob.path) || isSensitivePath(blob.path)) return true;
        if (blobs.length >= limits.maxFiles) return false;
        blobs.push(blob);
        return true;
      },
    });
    return { blobs, truncated: result.truncated };
  } catch (error) {
    if (error instanceof NullDelimitedCommandError && error.reason === "aborted") {
      throw new AppError("DeepWiki 索引已取消", 499, "KNOWLEDGE_CANCELLED");
    }
    if (error instanceof AppError) throw error;
    throw new AppError("DeepWiki 无法读取 Git 清单", 422, "KNOWLEDGE_GIT_FAILED");
  }
}

function parseGitTreeRecord(output: Buffer): GitTreeBlob | null {
  const record = output.toString("utf8");
  const separator = record.indexOf("\t");
  if (separator < 0) {
    throw new AppError("DeepWiki Git tree 清单格式无效", 422, "KNOWLEDGE_GIT_OBJECT_INVALID");
  }
  const metadata = record.slice(0, separator).trim().split(/\s+/u);
  const relativePath = record.slice(separator + 1);
  if (metadata.length !== 4) {
    throw new AppError("DeepWiki Git tree 元数据无效", 422, "KNOWLEDGE_GIT_OBJECT_INVALID");
  }
  const [mode, type, rawObjectId, rawBytes] = metadata;
  if (type !== "blob" || mode === "120000") return null;
  if (
    !mode?.startsWith("100")
    || !rawObjectId
    || !rawBytes
    || !safeRepositoryRelativePathSchema.safeParse(relativePath).success
    || relativePath.includes("\ufffd")
  ) return null;
  const bytes = Number(rawBytes);
  const objectId = gitRevisionSchema.safeParse(rawObjectId);
  if (!Number.isSafeInteger(bytes) || bytes < 0 || !objectId.success) {
    throw new AppError("DeepWiki Git blob 元数据无效", 422, "KNOWLEDGE_GIT_OBJECT_INVALID");
  }
  return { objectId: objectId.data, bytes, path: relativePath };
}

function deepWikiGitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

function isExcludedPath(relativePath: string): boolean {
  return relativePath.split("/").some((component) => EXCLUDED_DIRECTORIES.has(component));
}

function isSensitivePath(relativePath: string): boolean {
  const basename = path.posix.basename(relativePath).toLowerCase();
  const normalized = relativePath.toLowerCase();
  if (SENSITIVE_BASENAMES.has(basename)) return true;
  if (/^\.env(?:\.|$)/u.test(basename)) return true;
  if (/(?:^|[._-])(?:secret|credential|private[-_]?key)(?:[._-]|$)/u.test(basename)) return true;
  if (/^(?:service[-_.]?account|account[-_.]?key).+\.json$/u.test(basename)) return true;
  if (normalized === ".docker/config.json" || normalized.endsWith("/.docker/config.json")) return true;
  return /\.(?:pem|key|p12|pfx|jks|keystore|asc|ppk|tfstate)$/u.test(basename);
}

function looksBinary(content: Buffer): boolean {
  return content.subarray(0, Math.min(content.length, 8_192)).includes(0);
}

function looksLikePrivateKey(content: Buffer): boolean {
  const sample = content.subarray(0, Math.min(content.length, 32_768)).toString("utf8");
  return /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u.test(sample)
    || /-----BEGIN OPENSSH PRIVATE KEY-----/u.test(sample)
    || /-----BEGIN PGP PRIVATE KEY BLOCK-----/u.test(sample);
}

function classifyPath(relativePath: string): DeepWikiIndexedFile["tags"] {
  const normalized = relativePath.toLowerCase();
  const basename = path.posix.basename(normalized);
  const tags = new Set<DeepWikiIndexedFile["tags"][number]>();
  if (
    /^(?:readme|changelog|contributing|architecture|docs?)(?:\.|$)/u.test(basename)
    || normalized.startsWith("docs/")
  ) tags.add("document");
  if (
    /(?:^|\/)(?:test|tests|__tests__|spec|specs)(?:\/|$)/u.test(normalized)
    || /(?:\.test|\.spec)\.[^.]+$/u.test(basename)
  ) tags.add("test");
  if (
    /^(?:package\.json|pyproject\.toml|cargo\.toml|go\.mod|pom\.xml|build\.gradle|makefile|dockerfile)$/u.test(basename)
    || /(?:^|\/)(?:\.github\/workflows|\.gitlab-ci\.yml)(?:\/|$)/u.test(normalized)
  ) tags.add("build");
  if (
    /^(?:main|index|app|server|cli)\.[^.]+$/u.test(basename)
    || /(?:^|\/)src\/(?:main|index|app|server|cli)\.[^.]+$/u.test(normalized)
  ) tags.add("entry");
  if (/^(?:src|app|apps|packages|services|cmd|lib)\//u.test(normalized)) tags.add("key-path");
  return [...tags].sort(compareText);
}

function describeSignal(
  kind: DeepWikiIndexedFile["tags"][number],
  relativePath: string,
  language: string,
): string {
  const labels = {
    entry: "可能的程序入口",
    document: "项目说明或架构文档",
    test: "测试线索",
    build: "构建、依赖或自动化线索",
    "key-path": "主要源码路径",
  } as const;
  return `${labels[kind]}；${language}；${relativePath}`;
}

function detectLanguage(relativePath: string): string {
  const basename = path.posix.basename(relativePath).toLowerCase();
  if (["dockerfile", "containerfile"].includes(basename)) return "Dockerfile";
  if (["makefile", "gnumakefile"].includes(basename)) return "Make";
  const extension = path.posix.extname(basename);
  return ({
    ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript",
    ".mjs": "JavaScript", ".cjs": "JavaScript", ".py": "Python", ".go": "Go",
    ".rs": "Rust", ".java": "Java", ".kt": "Kotlin", ".kts": "Kotlin",
    ".rb": "Ruby", ".php": "PHP", ".cs": "C#", ".swift": "Swift", ".c": "C",
    ".h": "C/C++", ".cc": "C++", ".cpp": "C++", ".hpp": "C++", ".scala": "Scala",
    ".sh": "Shell", ".bash": "Shell", ".zsh": "Shell", ".ps1": "PowerShell",
    ".sql": "SQL", ".md": "Markdown", ".mdx": "Markdown", ".json": "JSON",
    ".yaml": "YAML", ".yml": "YAML", ".toml": "TOML", ".xml": "XML",
    ".html": "HTML", ".css": "CSS", ".scss": "CSS", ".vue": "Vue", ".svelte": "Svelte",
  } as Record<string, string>)[extension] ?? "Other";
}

function boundedText(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return `${value.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`;
}

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} 必须是正整数`);
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertActive(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new AppError("DeepWiki 索引已取消", 499, "KNOWLEDGE_CANCELLED");
}
