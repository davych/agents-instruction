import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
  open,
  opendir,
  realpath,
  stat,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { TextDecoder } from "node:util";

import { isWithin } from "../project-paths.js";
import {
  NullDelimitedCommandError,
  streamNullDelimitedCommand,
} from "../null-delimited-command.js";
import {
  DEFAULT_REPOSITORY_RETRIEVAL_LIMITS,
  RepositoryAccessError,
  RepositoryKnowledgeMismatchError,
  RepositoryRetrievalAbortedError,
  RepositoryRetrievalError,
  RepositoryRevisionMismatchError,
  type RepositoryContextPack,
  type RepositoryRetrievalLimits,
  type RepositoryRetrievalRequest,
  type RepositoryRevision,
  type RepositoryRevisionRequest,
  type RepositorySource,
} from "./repository-types.js";

export * from "./repository-types.js";

const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "bower_components",
  "build",
  "dist",
  "out",
  "target",
  "coverage",
  ".cache",
  "cache",
  "caches",
  ".next",
  ".nuxt",
  ".output",
  ".turbo",
  ".parcel-cache",
  ".vite",
  ".nx",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".gradle",
  ".terraform",
  ".pulumi",
  ".serverless",
  ".aws-sam",
  ".direnv",
  ".pnpm-store",
  "unplugged",
  ".idea",
  ".vscode",
  ".venv",
  "venv",
  "vendor",
  "tmp",
  "temp",
  "logs",
]);

const SENSITIVE_DIRECTORY_NAMES = new Set([
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
]);

const SENSITIVE_EXACT_FILE_NAMES = new Set([
  ".env",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".yarnrc.yaml",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  "credentials",
  "secrets",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "application_default_credentials.json",
  "service-account.json",
  "service_account.json",
  "auth.json",
  "kubeconfig",
  "pip.conf",
  "nuget.config",
  "settings.xml",
  "gradle.properties",
  "local.properties",
  ".envrc",
]);

const SENSITIVE_EXTENSIONS = new Set([
  ".key",
  ".pem",
  ".crt",
  ".cer",
  ".der",
  ".p12",
  ".pfx",
  ".jks",
  ".keystore",
  ".kdbx",
  ".gpg",
  ".asc",
  ".ppk",
  ".mobileprovision",
  ".tfstate",
]);

const PACKAGE_MANIFEST_NAMES = new Set([
  "package.json",
  "pyproject.toml",
  "cargo.toml",
  "go.mod",
  "composer.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "gemfile",
  "mix.exs",
  "deno.json",
  "deno.jsonc",
]);

const HARD_LIMITS: Readonly<RepositoryRetrievalLimits> = Object.freeze({
  maxEntries: 50_000,
  maxFiles: 10_000,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxSources: 50,
  maxContextBytes: 256 * 1024,
  maxExcerptBytes: 32 * 1024,
  maxExcerptLines: 500,
  gitTimeoutMs: 30_000,
  gitMaxBufferBytes: 32 * 1024 * 1024,
});

const MAX_GIT_LIST_RECORD_BYTES = 16 * 1024;

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

interface TextFile {
  relativePath: string;
  content: string;
  sha256: string;
}

interface RepositoryScan {
  files: TextFile[];
  fingerprint: string;
  filesVisited: number;
  textFilesRead: number;
  bytesRead: number;
  truncated: boolean;
}

interface GitCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  systemCode?: string;
}

interface GitCorpusFilter {
  files: ReadonlySet<string>;
  directories: ReadonlySet<string>;
  truncated: boolean;
}

interface GitNullList {
  paths: string[];
  truncated: boolean;
}

interface ScoredFile extends TextFile {
  score: number;
}

export class RepositoryRetriever {
  readonly defaults: Readonly<RepositoryRetrievalLimits>;

  constructor(defaults: Partial<RepositoryRetrievalLimits> = {}) {
    this.defaults = normalizeLimits(defaults);
  }

  async retrieve(input: RepositoryRetrievalRequest): Promise<RepositoryContextPack> {
    try {
      assertNotAborted(input.signal);
      if (typeof input.question !== "string") {
        throw new RepositoryAccessError("项目问题必须是文本", "ASK_QUESTION_INVALID", 400);
      }
      const limits = normalizeLimits({ ...this.defaults, ...input.limits });
      const projectRoot = await resolveRegisteredProjectRoot(input.projectRoot, input.signal);
      const initialGitRevision = await captureGitRevision(projectRoot, limits, input.signal);
      if (input.knowledge) {
        assertKnowledgeRevision(input.knowledge.revision, initialGitRevision);
      }
      const gitCorpus = initialGitRevision
        ? await captureGitCorpusFilter(projectRoot, limits, input.signal)
        : undefined;

      let scan: RepositoryScan;
      let initialRevision: RepositoryRevision;
      if (initialGitRevision) {
        scan = await scanRepository(projectRoot, limits, input.signal, gitCorpus);
        initialRevision = bindCorpusRevision(initialGitRevision, scan.fingerprint);
      } else {
        scan = await scanRepository(projectRoot, limits, input.signal);
        initialRevision = unversionedRevision(scan.fingerprint);
      }
      assertExpectedRevision(input.expectedRevision, initialRevision.revision);

      const evidenceFiles = input.knowledge
        ? knowledgeBoundFiles(scan.files, input.knowledge.files)
        : scan.files;
      const sources = buildSources(
        evidenceFiles,
        input.question,
        initialRevision.revision,
        limits,
        input.knowledge?.summary,
      );
      assertNotAborted(input.signal);

      const finalGitRevision = await captureGitRevision(projectRoot, limits, input.signal);
      const revisionChanged = initialGitRevision
        ? !finalGitRevision || !sameRevision(initialGitRevision, finalGitRevision)
        : finalGitRevision !== null || !sameRevision(
          initialRevision,
          unversionedRevision((await scanRepository(projectRoot, limits, input.signal)).fingerprint),
        );
      if (revisionChanged) {
        throw new RepositoryRevisionMismatchError(
          "读取源码期间项目 revision 发生变化，请重新提问",
        );
      }

      const sourceBytes = sources.reduce(
        (total, source) => total + Buffer.byteLength(source.excerpt),
        0,
      );
      return {
        revision: initialRevision.revision,
        dirty: initialRevision.dirty,
        repositoryRevision: initialRevision,
        sources,
        truncated: scan.truncated || input.knowledge?.summary.truncated === true,
        stats: {
          filesVisited: scan.filesVisited,
          textFilesRead: scan.textFilesRead,
          bytesRead: scan.bytesRead,
          sourceBytes,
        },
      };
    } catch (error) {
      throw publicRepositoryError(error, input.signal);
    }
  }

  async captureRevision(input: RepositoryRevisionRequest): Promise<RepositoryRevision> {
    try {
      const limits = normalizeLimits({ ...this.defaults, ...input.limits });
      const projectRoot = await resolveRegisteredProjectRoot(input.projectRoot, input.signal);
      const gitRevision = await captureGitRevision(projectRoot, limits, input.signal);
      const gitCorpus = gitRevision
        ? await captureGitCorpusFilter(projectRoot, limits, input.signal)
        : undefined;
      const scan = await scanRepository(projectRoot, limits, input.signal, gitCorpus);
      const revision = gitRevision
        ? bindCorpusRevision(gitRevision, scan.fingerprint)
        : unversionedRevision(scan.fingerprint);
      const finalGitRevision = await captureGitRevision(projectRoot, limits, input.signal);
      const changed = gitRevision
        ? !finalGitRevision || !sameRevision(gitRevision, finalGitRevision)
        : finalGitRevision !== null || !sameRevision(
          revision,
          unversionedRevision((await scanRepository(projectRoot, limits, input.signal)).fingerprint),
        );
      if (changed) {
        throw new RepositoryRevisionMismatchError(
          "读取 revision 期间项目发生变化，请重试",
        );
      }
      return revision;
    } catch (error) {
      throw publicRepositoryError(error, input.signal);
    }
  }
}

export async function retrieveRepositoryContext(
  input: RepositoryRetrievalRequest,
): Promise<RepositoryContextPack> {
  return new RepositoryRetriever().retrieve(input);
}

export async function captureRepositoryRevision(
  projectRootOrRequest: string | RepositoryRevisionRequest,
  options: Omit<RepositoryRevisionRequest, "projectRoot"> = {},
): Promise<RepositoryRevision> {
  const request = typeof projectRootOrRequest === "string"
    ? { ...options, projectRoot: projectRootOrRequest }
    : projectRootOrRequest;
  return new RepositoryRetriever().captureRevision(request);
}

async function resolveRegisteredProjectRoot(
  requestedRoot: string,
  signal?: AbortSignal,
): Promise<string> {
  assertNotAborted(signal);
  if (typeof requestedRoot !== "string" || requestedRoot.trim().length === 0) {
    throw new RepositoryAccessError("已登记项目没有可读取的根目录");
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(path.resolve(requestedRoot));
    const info = await stat(canonicalRoot);
    if (!info.isDirectory()) {
      throw new RepositoryAccessError("已登记项目的根目录不是普通目录");
    }
  } catch (error) {
    if (error instanceof RepositoryRetrievalError) throw error;
    throw new RepositoryAccessError("已登记项目的根目录不存在或不可读取");
  }
  assertNotAborted(signal);
  return canonicalRoot;
}

async function captureGitRevision(
  projectRoot: string,
  limits: RepositoryRetrievalLimits,
  signal?: AbortSignal,
): Promise<RepositoryRevision | null> {
  const inside = await runGit(
    projectRoot,
    ["rev-parse", "--is-inside-work-tree"],
    limits,
    signal,
  );
  if (inside.systemCode === "ENOENT") return null;
  if (inside.exitCode !== 0) {
    if (/not a git repository/iu.test(inside.stderr)) return null;
    throw new RepositoryAccessError("项目 Git revision 无法读取", "ASK_REVISION_UNAVAILABLE");
  }
  if (inside.stdout.trim() !== "true") {
    throw new RepositoryAccessError("项目不是受支持的 Git worktree", "ASK_REVISION_UNAVAILABLE");
  }

  const headResult = await runGit(
    projectRoot,
    ["rev-parse", "--verify", "HEAD"],
    limits,
    signal,
  );
  const rawHead = headResult.stdout.trim().toLowerCase();
  let head: string | null = null;
  if (headResult.exitCode === 0) {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(rawHead)) {
      throw new RepositoryAccessError("项目 Git HEAD 格式无效", "ASK_REVISION_UNAVAILABLE");
    }
    head = rawHead;
  } else {
    const symbolicHead = await runGit(
      projectRoot,
      ["symbolic-ref", "-q", "HEAD"],
      limits,
      signal,
    );
    if (symbolicHead.exitCode !== 0 || !/^refs\/heads\/[A-Za-z0-9._/-]+$/u.test(symbolicHead.stdout.trim())) {
      throw new RepositoryAccessError("项目 Git HEAD 无法解析", "ASK_REVISION_UNAVAILABLE");
    }
  }

  const statusResult = await runGit(
    projectRoot,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."],
    limits,
    signal,
  );
  if (statusResult.exitCode !== 0) {
    throw new RepositoryAccessError("项目 Git 工作区状态无法读取", "ASK_REVISION_UNAVAILABLE");
  }
  const dirty = statusResult.stdout.length > 0;
  if (!dirty && head) {
    return {
      kind: "git",
      revision: `git:${head}:clean`,
      head,
      dirty: false,
      dirtyFingerprint: null,
    };
  }

  let trackedDiff = "";
  if (head) {
    const diffResult = await runGit(
      projectRoot,
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--full-index",
        "--binary",
        "--no-renames",
        "HEAD",
        "--",
        ".",
      ],
      limits,
      signal,
    );
    if (diffResult.exitCode !== 0) {
      throw new RepositoryAccessError("项目 Git 变更指纹无法读取", "ASK_REVISION_UNAVAILABLE");
    }
    trackedDiff = diffResult.stdout;
  }

  const untracked = await runGitNullList(
    projectRoot,
    ["ls-files", "--others", "--exclude-standard", "-z", "--", "."],
    limits,
    limits.maxFiles,
    signal,
  );

  const fingerprint = createHash("sha256");
  fingerprint.update("ask-repository-git-v1\0");
  fingerprint.update(head ?? "unborn");
  fingerprint.update("\0");
  fingerprint.update(statusResult.stdout);
  fingerprint.update("\0");
  fingerprint.update(trackedDiff);
  await hashUntrackedFiles(
    fingerprint,
    projectRoot,
    untracked.paths.sort(),
    limits,
    signal,
    untracked.truncated,
  );
  const dirtyFingerprint = fingerprint.digest("hex");
  return {
    kind: "git",
    revision: head
      ? `git:${head}:dirty:${shortFingerprint(dirtyFingerprint)}`
      : `git:unborn:dirty:${shortFingerprint(dirtyFingerprint)}`,
    head,
    dirty: true,
    dirtyFingerprint,
  };
}

async function hashUntrackedFiles(
  hash: ReturnType<typeof createHash>,
  projectRoot: string,
  relativePaths: readonly string[],
  limits: RepositoryRetrievalLimits,
  signal?: AbortSignal,
  listTruncated = false,
): Promise<void> {
  let bytesRead = 0;
  for (const relativePath of relativePaths) {
    assertNotAborted(signal);
    const normalized = normalizeGitPath(relativePath);
    hash.update(normalized ?? "unsafe-path");
    hash.update("\0");
    if (!normalized || isSensitivePath(normalized) || isExcludedRelativePath(normalized)) {
      hash.update("content-skipped\0");
      continue;
    }
    const candidate = path.resolve(projectRoot, ...normalized.split("/"));
    if (!isWithin(projectRoot, candidate) || candidate === projectRoot) {
      hash.update("escape-skipped\0");
      continue;
    }
    try {
      const info = await lstat(candidate);
      hash.update(`${info.mode}:${info.size}:${info.mtimeMs}\0`);
      if (
        !info.isFile()
        || info.isSymbolicLink()
        || info.size > limits.maxFileBytes
        || bytesRead + info.size > limits.maxTotalBytes
      ) continue;
      const bytes = await readBoundedRegularFile(
        projectRoot,
        candidate,
        Math.min(limits.maxFileBytes, limits.maxTotalBytes - bytesRead),
        signal,
      );
      if (!bytes) continue;
      bytesRead += bytes.length;
      hash.update(bytes);
      hash.update("\0");
    } catch (error) {
      if (isAbortError(error, signal)) throw new RepositoryRetrievalAbortedError();
      hash.update("unreadable\0");
    }
  }
  if (listTruncated) hash.update("untracked-limit\0");
}

async function runGit(
  projectRoot: string,
  args: readonly string[],
  limits: RepositoryRetrievalLimits,
  signal?: AbortSignal,
): Promise<GitCommandResult> {
  assertNotAborted(signal);
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "maintenance.auto=false",
        "-c",
        "gc.auto=0",
        "-C",
        projectRoot,
        ...args,
      ],
      {
        encoding: "utf8",
        env: repositoryGitEnvironment(),
        maxBuffer: limits.gitMaxBufferBytes,
        timeout: limits.gitTimeoutMs,
        signal,
        shell: false,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ exitCode: 0, stdout, stderr });
          return;
        }
        if (isAbortError(error, signal)) {
          reject(new RepositoryRetrievalAbortedError());
          return;
        }
        const childError = error as NodeJS.ErrnoException & {
          code?: string | number;
          killed?: boolean;
        };
        if (typeof childError.code === "number") {
          resolve({ exitCode: childError.code, stdout, stderr });
          return;
        }
        if (childError.code === "ENOENT") {
          resolve({ exitCode: null, stdout, stderr, systemCode: "ENOENT" });
          return;
        }
        reject(new RepositoryAccessError(
          childError.killed
            ? "读取项目 Git revision 超时"
            : "读取项目 Git revision 超出安全上限",
          childError.killed ? "ASK_REVISION_TIMEOUT" : "ASK_REVISION_UNAVAILABLE",
        ));
      },
    );
  });
}

async function runGitNullList(
  projectRoot: string,
  args: readonly string[],
  limits: RepositoryRetrievalLimits,
  maxRecords: number,
  signal?: AbortSignal,
): Promise<GitNullList> {
  assertNotAborted(signal);
  const paths: string[] = [];
  let recordsSeen = 0;
  try {
    const result = await streamNullDelimitedCommand({
      command: "git",
      args: [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "maintenance.auto=false",
        "-c",
        "gc.auto=0",
        "-C",
        projectRoot,
        ...args,
      ],
      environment: repositoryGitEnvironment(),
      timeoutMs: limits.gitTimeoutMs,
      maxStderrBytes: limits.gitMaxBufferBytes,
      maxRecordBytes: MAX_GIT_LIST_RECORD_BYTES,
      signal,
      onRecord: (record) => {
        if (record.length === 0) return true;
        recordsSeen += 1;
        if (recordsSeen > maxRecords) return false;
        try {
          paths.push(utf8Decoder.decode(record));
        } catch {
          // An undecodable repository path is not safe retrieval evidence, but
          // it still consumes one bounded list entry.
        }
        return true;
      },
    });
    return { paths, truncated: result.truncated };
  } catch (error) {
    if (error instanceof NullDelimitedCommandError) {
      if (error.reason === "aborted") throw new RepositoryRetrievalAbortedError();
      if (error.reason === "timeout") {
        throw new RepositoryAccessError(
          "读取项目 Git 文件列表超时",
          "ASK_REVISION_TIMEOUT",
        );
      }
      throw new RepositoryAccessError(
        "项目 Git 文件列表无法安全读取",
        "ASK_REVISION_UNAVAILABLE",
      );
    }
    throw error;
  }
}

function repositoryGitEnvironment(): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  return {
    ...environment,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    LC_ALL: "C",
    LANG: "C",
  };
}

async function captureGitCorpusFilter(
  projectRoot: string,
  limits: RepositoryRetrievalLimits,
  signal?: AbortSignal,
): Promise<GitCorpusFilter> {
  const result = await runGitNullList(
    projectRoot,
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."],
    limits,
    limits.maxEntries,
    signal,
  );

  const files = new Set<string>();
  const directories = new Set<string>(["."]);
  for (const rawPath of result.paths) {
    assertNotAborted(signal);
    const relativePath = normalizeGitPath(rawPath);
    if (!relativePath) continue;
    files.add(relativePath);
    const components = relativePath.split("/");
    components.pop();
    let parent = "";
    for (const component of components) {
      parent = parent ? `${parent}/${component}` : component;
      directories.add(parent);
    }
  }
  return { files, directories, truncated: result.truncated };
}

async function scanRepository(
  projectRoot: string,
  limits: RepositoryRetrievalLimits,
  signal?: AbortSignal,
  gitCorpus?: GitCorpusFilter,
): Promise<RepositoryScan> {
  const files: TextFile[] = [];
  const snapshot = createHash("sha256");
  snapshot.update("ask-repository-corpus-v1\0");
  const directoryQueue = [projectRoot];
  let filesVisited = 0;
  let entriesVisited = 0;
  let textFilesRead = 0;
  let bytesRead = 0;
  let truncated = gitCorpus?.truncated ?? false;

  while (directoryQueue.length > 0) {
    assertNotAborted(signal);
    if (entriesVisited >= limits.maxEntries || filesVisited >= limits.maxFiles) {
      truncated = true;
      break;
    }
    const directoryPath = directoryQueue.shift();
    if (!directoryPath) break;
    const directoryRelative = relativeSourcePath(projectRoot, directoryPath);
    snapshot.update(`directory\0${directoryRelative}\0`);

    let directory;
    try {
      directory = await opendir(directoryPath);
    } catch {
      snapshot.update("unreadable-directory\0");
      continue;
    }
    const children: Array<{ name: string; isDirectory: boolean; isFile: boolean; isSymbolicLink: boolean }> = [];
    try {
      while (entriesVisited + children.length < limits.maxEntries) {
        assertNotAborted(signal);
        const child = await directory.read();
        if (!child) break;
        children.push({
          name: child.name,
          isDirectory: child.isDirectory(),
          isFile: child.isFile(),
          isSymbolicLink: child.isSymbolicLink(),
        });
      }
      const extra = await directory.read();
      if (extra) truncated = true;
    } finally {
      await directory.close().catch(() => undefined);
    }
    children.sort(compareDirectoryEntries);

    for (const child of children) {
      assertNotAborted(signal);
      if (entriesVisited >= limits.maxEntries || filesVisited >= limits.maxFiles) {
        truncated = true;
        break;
      }
      entriesVisited += 1;
      const absolutePath = path.join(directoryPath, child.name);
      const relativePath = relativeSourcePath(projectRoot, absolutePath);
      if (!isSafeSourcePath(relativePath)) {
        snapshot.update("escape-skipped\0");
        continue;
      }
      if (
        gitCorpus
        && (
          (child.isDirectory && !gitCorpus.directories.has(relativePath))
          || (!child.isDirectory && !gitCorpus.files.has(relativePath))
        )
      ) {
        continue;
      }
      if (child.isSymbolicLink) {
        snapshot.update(`symlink-skipped\0${relativePath}\0`);
        continue;
      }

      let info;
      try {
        info = await lstat(absolutePath);
      } catch {
        snapshot.update(`unreadable-entry\0${relativePath}\0`);
        continue;
      }
      if (info.isSymbolicLink()) {
        snapshot.update(`symlink-skipped\0${relativePath}\0`);
        continue;
      }
      if (info.isDirectory()) {
        if (isExcludedDirectory(child.name) || isSensitiveDirectory(child.name)) {
          snapshot.update(`directory-skipped\0${relativePath}\0`);
          continue;
        }
        directoryQueue.push(absolutePath);
        continue;
      }
      if (!info.isFile()) {
        snapshot.update(`special-skipped\0${relativePath}\0`);
        continue;
      }

      filesVisited += 1;
      snapshot.update(`file\0${relativePath}\0${info.mode}:${info.size}:${info.mtimeMs}\0`);
      if (isSensitivePath(relativePath)) {
        snapshot.update("sensitive-skipped\0");
        continue;
      }
      if (info.size > limits.maxFileBytes || bytesRead + info.size > limits.maxTotalBytes) {
        snapshot.update("oversize-skipped\0");
        truncated = true;
        continue;
      }

      let bytes: Buffer | null;
      try {
        bytes = await readBoundedRegularFile(
          projectRoot,
          absolutePath,
          Math.min(limits.maxFileBytes, limits.maxTotalBytes - bytesRead),
          signal,
        );
      } catch (error) {
        if (isAbortError(error, signal)) throw new RepositoryRetrievalAbortedError();
        snapshot.update("unreadable-file\0");
        continue;
      }
      if (!bytes) {
        snapshot.update("unsafe-file-skipped\0");
        continue;
      }
      bytesRead += bytes.length;
      const contentHash = sha256(bytes);
      snapshot.update(`${contentHash}\0`);
      const text = decodeText(bytes);
      if (text === null || text.trim().length === 0) {
        snapshot.update("nontext-skipped\0");
        continue;
      }
      textFilesRead += 1;
      files.push({ relativePath, content: text, sha256: contentHash });
    }
  }

  if (truncated) snapshot.update("truncated\0");
  return {
    files,
    fingerprint: snapshot.digest("hex"),
    filesVisited,
    textFilesRead,
    bytesRead,
    truncated,
  };
}

async function readBoundedRegularFile(
  projectRoot: string,
  candidate: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  assertNotAborted(signal);
  if (maxBytes <= 0) return null;
  const canonicalPath = await realpath(candidate);
  if (!isWithin(projectRoot, canonicalPath) || canonicalPath === projectRoot) return null;
  const handle = await open(canonicalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes) return null;
    const buffer = Buffer.allocUnsafe(Math.min(maxBytes + 1, before.size + 1));
    let offset = 0;
    while (offset < buffer.length) {
      assertNotAborted(signal);
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) return null;
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new RepositoryRevisionMismatchError("读取源码时文件发生变化，请重新提问");
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function buildSources(
  files: readonly TextFile[],
  question: string,
  revision: string,
  limits: RepositoryRetrievalLimits,
  knowledgeSummary?: NonNullable<RepositoryRetrievalRequest["knowledge"]>["summary"],
): RepositorySource[] {
  const scoringQuestion = normalizeQuestionForScoring(question);
  const terms = questionTerms(scoringQuestion);
  const knowledgePriorities = knowledgePathPriorities(knowledgeSummary);
  const scored: ScoredFile[] = files.map((file) => ({
    ...file,
    score: scoreFile(file, scoringQuestion, terms)
      + (knowledgePriorities.get(file.relativePath) ?? 0),
  }));
  scored.sort((left, right) => right.score - left.score
    || left.relativePath.localeCompare(right.relativePath));

  const sources: RepositorySource[] = [];
  let contextBytes = 0;
  const fairExcerptBytes = Math.max(
    1,
    Math.ceil(limits.maxContextBytes / limits.maxSources),
  );
  for (const file of scored) {
    if (sources.length >= limits.maxSources || contextBytes >= limits.maxContextBytes) break;
    const remainingBytes = limits.maxContextBytes - contextBytes;
    const excerpt = selectExcerpt(
      file.content,
      scoringQuestion,
      terms,
      Math.min(limits.maxExcerptBytes, fairExcerptBytes, remainingBytes),
      limits.maxExcerptLines,
    );
    if (!excerpt) continue;
    contextBytes += Buffer.byteLength(excerpt.excerpt);
    sources.push({
      sourceId: sourceIdFor(revision, file, excerpt),
      path: file.relativePath,
      startLine: excerpt.startLine,
      endLine: excerpt.endLine,
      excerpt: excerpt.excerpt,
      sha256: file.sha256,
      revision,
    });
  }
  return sources;
}

function knowledgeBoundFiles(
  files: readonly TextFile[],
  indexedFiles: NonNullable<RepositoryRetrievalRequest["knowledge"]>["files"],
): TextFile[] {
  const indexedHashes = new Map(indexedFiles.map((file) => [file.path, file.sha256]));
  const bounded: TextFile[] = [];
  for (const file of files) {
    const indexedHash = indexedHashes.get(file.relativePath);
    if (!indexedHash) continue;
    if (indexedHash !== file.sha256) {
      throw new RepositoryKnowledgeMismatchError(
        `DeepWiki 文件校验失败：${file.relativePath}`,
      );
    }
    bounded.push(file);
  }
  return bounded;
}

function knowledgePathPriorities(
  summary?: NonNullable<RepositoryRetrievalRequest["knowledge"]>["summary"],
): Map<string, number> {
  const priorities = new Map<string, number>();
  if (!summary) return priorities;
  for (const [signals, priority] of [
    [summary.entryPoints, 2_000],
    [summary.documents, 1_100],
    [summary.builds, 1_000],
    [summary.tests, 900],
    [summary.keyPaths, 700],
  ] as const) {
    for (const signal of signals) {
      priorities.set(signal.path, Math.max(priority, priorities.get(signal.path) ?? 0));
    }
  }
  return priorities;
}

function assertKnowledgeRevision(
  expectedRevision: string,
  repositoryRevision: RepositoryRevision | null,
): void {
  if (
    !repositoryRevision
    || repositoryRevision.kind !== "git"
    || repositoryRevision.dirty
    || repositoryRevision.head !== expectedRevision
  ) {
    throw new RepositoryKnowledgeMismatchError(
      "DeepWiki revision 与固定源码快照不一致",
    );
  }
}

function scoreFile(file: TextFile, question: string, terms: readonly string[]): number {
  const normalizedPath = file.relativePath.toLocaleLowerCase("en-US");
  const normalizedContent = file.content.toLocaleLowerCase("en-US");
  let score = pathPriority(file.relativePath);
  const normalizedQuestion = question.trim().toLocaleLowerCase("en-US");
  const pathQuestion = normalizedQuestion.replaceAll("\\", "/");
  const basename = path.posix.basename(normalizedPath);
  if (pathQuestion.includes(normalizedPath)) score += 10_000;
  else if (basename.length >= 3 && pathQuestion.includes(basename)) score += 2_500;
  if (normalizedQuestion.length >= 4 && normalizedContent.includes(normalizedQuestion)) score += 600;
  for (const term of terms) {
    if (normalizedPath.includes(term)) score += 100;
    let fromIndex = 0;
    let matches = 0;
    while (matches < 20) {
      const found = normalizedContent.indexOf(term, fromIndex);
      if (found < 0) break;
      matches += 1;
      fromIndex = found + term.length;
    }
    score += Math.min(matches, 20) * (term.length >= 5 ? 18 : 10);
  }
  return score;
}

function sourceIdFor(
  revision: string,
  file: TextFile,
  excerpt: { excerpt: string; startLine: number; endLine: number },
): string {
  const digest = createHash("sha256")
    .update("ask-source-v1\0")
    .update(revision)
    .update("\0")
    .update(file.relativePath)
    .update("\0")
    .update(file.sha256)
    .update("\0")
    .update(`${excerpt.startLine}:${excerpt.endLine}\0`)
    .update(excerpt.excerpt)
    .digest("hex")
    .slice(0, 32);
  return `S${(BigInt(`0x${digest}`) + 1n).toString(10)}`;
}

function pathPriority(relativePath: string): number {
  const basename = path.posix.basename(relativePath).toLocaleLowerCase("en-US");
  if (basename === "agents.md") return 560;
  if (/^readme(?:\.[a-z0-9_-]+)?$/u.test(basename)) return 540;
  if (basename === "ai-native.yaml" || basename === "ai-native.yml") return 520;
  if (PACKAGE_MANIFEST_NAMES.has(basename)) return 500;
  if (basename === "workflow.md") return 420;
  if (relativePath.startsWith("docs/") || relativePath.includes("/docs/")) return 120;
  return 0;
}

function questionTerms(question: string): string[] {
  const normalized = question.normalize("NFKC").toLocaleLowerCase("en-US");
  const terms: string[] = [];
  for (const match of normalized.matchAll(/[\p{Script=Han}]+|[\p{L}\p{N}][\p{L}\p{N}._/-]*/gu)) {
    const value = match[0];
    if (/^\p{Script=Han}+$/u.test(value)) {
      if (value.length <= 8) terms.push(value);
      for (let index = 0; index < value.length - 1; index += 1) {
        terms.push(value.slice(index, index + 2));
      }
    } else if (value.length >= 2) {
      terms.push(value);
    }
    if (terms.length >= 80) break;
  }
  return [...new Set(terms)].slice(0, 64);
}

function normalizeQuestionForScoring(question: string): string {
  return question.normalize("NFKC").slice(0, 20_000);
}

function selectExcerpt(
  content: string,
  question: string,
  terms: readonly string[],
  maxBytes: number,
  maxLines: number,
): { excerpt: string; startLine: number; endLine: number } | null {
  if (maxBytes <= 0 || maxLines <= 0) return null;
  const lines = content.split(/\r\n|\n|\r/u);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) return null;
  const normalizedQuestion = question.trim().toLocaleLowerCase("en-US");
  let bestIndex = 0;
  let bestScore = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const normalizedLine = (lines[index] ?? "").toLocaleLowerCase("en-US");
    let score = normalizedQuestion.length >= 4 && normalizedLine.includes(normalizedQuestion) ? 300 : 0;
    for (const term of terms) if (normalizedLine.includes(term)) score += term.length >= 5 ? 8 : 4;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  let start = Math.max(0, bestIndex - Math.min(12, Math.floor(maxLines / 3)));
  let end = Math.min(lines.length, start + maxLines);
  start = Math.max(0, end - maxLines);
  while (start < end && (lines[start] ?? "").trim().length === 0) start += 1;
  while (end > start && (lines[end - 1] ?? "").trim().length === 0) end -= 1;
  if (start >= end) return null;

  let selected = lines.slice(start, end);
  while (selected.length > 1 && Buffer.byteLength(selected.join("\n")) > maxBytes) {
    selected.pop();
    end -= 1;
  }
  let excerpt = selected.join("\n");
  if (Buffer.byteLength(excerpt) > maxBytes) excerpt = truncateUtf8(excerpt, maxBytes);
  if (!excerpt) return null;
  return { excerpt, startLine: start + 1, endLine: end };
}

function decodeText(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  let value: string;
  try {
    value = utf8Decoder.decode(bytes);
  } catch {
    return null;
  }
  let disallowedControls = 0;
  let examined = 0;
  for (const character of value.slice(0, 16_384)) {
    const codePoint = character.codePointAt(0) ?? 0;
    examined += 1;
    if (codePoint < 32 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13 && codePoint !== 12) {
      disallowedControls += 1;
    }
  }
  if (examined > 0 && disallowedControls / examined > 0.01) return null;
  return value.startsWith("\uFEFF") ? value.slice(1) : value;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function compareDirectoryEntries(
  left: { name: string; isDirectory: boolean },
  right: { name: string; isDirectory: boolean },
): number {
  const leftPriority = entryTraversalPriority(left);
  const rightPriority = entryTraversalPriority(right);
  return rightPriority - leftPriority || left.name.localeCompare(right.name);
}

function entryTraversalPriority(entry: { name: string; isDirectory: boolean }): number {
  if (!entry.isDirectory) return pathPriority(entry.name) + 1_000;
  const name = entry.name.toLocaleLowerCase("en-US");
  if (["src", "app", "apps", "packages", "lib", "docs"].includes(name)) return 900;
  return 0;
}

function isExcludedDirectory(name: string): boolean {
  return EXCLUDED_DIRECTORY_NAMES.has(name.toLocaleLowerCase("en-US"));
}

function isSensitiveDirectory(name: string): boolean {
  return SENSITIVE_DIRECTORY_NAMES.has(name.toLocaleLowerCase("en-US"));
}

function isExcludedRelativePath(relativePath: string): boolean {
  return relativePath.split("/").some((component) => isExcludedDirectory(component));
}

function isSensitivePath(relativePath: string): boolean {
  const components = relativePath.split("/");
  if (components.some((component) => isSensitiveDirectory(component))) return true;
  const basename = (components.at(-1) ?? "").toLocaleLowerCase("en-US");
  if (SENSITIVE_EXACT_FILE_NAMES.has(basename)) return true;
  if (
    basename === ".env"
    || basename === ".envrc"
    || basename.startsWith(".env.")
    || basename.endsWith(".env")
    || basename.includes(".env.")
  ) return true;
  if (/^(?:credentials?|secrets?)(?:[._-]|$)/u.test(basename)) return true;
  if (/(?:[._-])(?:credentials?|secrets?)(?:[._-]|$)/u.test(basename)) return true;
  if (/^(?:private|client)[._-]?key(?:[._-]|$)/u.test(basename)) return true;
  if (/^(?:cert|certificate|keystore)(?:[._-]|$)/u.test(basename)) return true;
  if (basename.includes(".tfstate")) return true;
  if (/firebase-adminsdk/iu.test(basename)) return true;
  if (
    /(?:^|[._-])(?:api[._-]?key|access[._-]?key|secret[._-]?key|private[._-]?key|client[._-]?secret|auth[._-]?token|access[._-]?token|refresh[._-]?token)(?:[._-]|$)/u
      .test(basename)
  ) return true;
  return SENSITIVE_EXTENSIONS.has(path.posix.extname(basename));
}

function relativeSourcePath(projectRoot: string, candidate: string): string {
  const relative = path.relative(projectRoot, candidate);
  return relative === "" ? "." : relative.split(path.sep).join("/");
}

function normalizeGitPath(value: string): string | null {
  if (!isSafeSourcePath(value) || path.win32.isAbsolute(value)) {
    return null;
  }
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) return null;
  return normalized;
}

function isSafeSourcePath(value: string): boolean {
  return Boolean(value)
    && !/[\u0000-\u001f\u007f\\]/u.test(value)
    && !path.posix.isAbsolute(value)
    && !path.win32.isAbsolute(value)
    && value.split("/").every((component) => component !== "" && component !== "." && component !== "..");
}

function unversionedRevision(fingerprint: string): RepositoryRevision {
  return {
    kind: "unversioned",
    revision: `unversioned:sha256:${fingerprint}`,
    head: null,
    dirty: true,
    dirtyFingerprint: fingerprint,
  };
}

function bindCorpusRevision(
  baseRevision: RepositoryRevision,
  corpusFingerprint: string,
): RepositoryRevision {
  return {
    ...baseRevision,
    revision: `${baseRevision.revision}:corpus:${shortFingerprint(corpusFingerprint)}`,
  };
}

function shortFingerprint(fingerprint: string): string {
  // 128 bits keeps the public token well below contract limits even for SHA-256 Git HEADs.
  return fingerprint.slice(0, 32);
}

function sameRevision(left: RepositoryRevision, right: RepositoryRevision): boolean {
  return left.kind === right.kind
    && left.revision === right.revision
    && left.head === right.head
    && left.dirty === right.dirty
    && left.dirtyFingerprint === right.dirtyFingerprint;
}

function assertExpectedRevision(expected: string | null | undefined, actual: string): void {
  if (expected !== undefined && expected !== null && expected !== actual) {
    throw new RepositoryRevisionMismatchError();
  }
}

function normalizeLimits(
  overrides: Partial<RepositoryRetrievalLimits>,
): Readonly<RepositoryRetrievalLimits> {
  const normalized = {} as RepositoryRetrievalLimits;
  for (const key of Object.keys(DEFAULT_REPOSITORY_RETRIEVAL_LIMITS) as Array<keyof RepositoryRetrievalLimits>) {
    const requested = overrides[key] ?? DEFAULT_REPOSITORY_RETRIEVAL_LIMITS[key];
    if (!Number.isSafeInteger(requested) || requested <= 0) {
      throw new RepositoryAccessError("源码检索上限配置无效", "ASK_REPOSITORY_LIMIT_INVALID", 500);
    }
    normalized[key] = Math.min(requested, HARD_LIMITS[key]);
  }
  normalized.maxExcerptBytes = Math.min(normalized.maxExcerptBytes, normalized.maxContextBytes);
  normalized.maxFileBytes = Math.min(normalized.maxFileBytes, normalized.maxTotalBytes);
  return Object.freeze(normalized);
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RepositoryRetrievalAbortedError();
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true
    || (error instanceof Error && (error.name === "AbortError" || error.name === "RepositoryRetrievalAbortedError"));
}

function publicRepositoryError(error: unknown, signal?: AbortSignal): RepositoryRetrievalError {
  if (isAbortError(error, signal)) return new RepositoryRetrievalAbortedError();
  if (error instanceof RepositoryRetrievalError) return error;
  return new RepositoryAccessError();
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
