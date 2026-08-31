import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  changesetSchema,
  gitRevisionSchema,
  type ChangesetDto,
  type ChangesetFileDto,
  type ChangesetFileStatus,
} from "@ai-sdlc/contracts";

import { AppError } from "../domain/errors.js";
import { isWithin } from "./project-paths.js";

export interface CreateRunChangesetInput {
  runId: string;
  workspaceRoot: string;
  baseRevision: string;
  controlRoot?: string;
  excludedPaths?: string[];
  gitBinary?: string;
  maxPatchBytes?: number;
  maxFiles?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface GeneratedRunChangeset extends ChangesetDto {
  /** Internal persistence/download payload. Never serialize this as JSON. */
  patch: Buffer;
}

interface GitContext {
  cwd: string;
  binary: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}

interface GitResult {
  stdout: Buffer;
  exitCode: number;
}

const defaultMaxPatchBytes = 16 * 1024 * 1024;
const defaultMaxFiles = 5_000;
const metadataOutputLimit = 8 * 1024 * 1024;
const stderrLimit = 16 * 1024;
const gitConfigArgs = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "core.quotepath=false",
  "-c", "diff.external=",
] as const;

/**
 * Produces a base-revision-bound binary patch without touching the repository
 * index or object database. A temporary index and quarantine object directory
 * represent the complete working tree, including safe untracked files.
 */
export async function createRunChangeset(
  input: CreateRunChangesetInput,
): Promise<GeneratedRunChangeset> {
  const baseRevision = gitRevisionSchema.parse(input.baseRevision).toLowerCase();
  const maxPatchBytes = boundedPositiveInteger(
    input.maxPatchBytes ?? defaultMaxPatchBytes,
    1,
    256 * 1024 * 1024,
    "Changeset patch byte limit",
  );
  const maxFiles = boundedPositiveInteger(
    input.maxFiles ?? defaultMaxFiles,
    1,
    20_000,
    "Changeset file limit",
  );
  const timeoutMs = boundedPositiveInteger(
    input.timeoutMs ?? 30_000,
    250,
    5 * 60_000,
    "Changeset Git timeout",
  );
  input.signal?.throwIfAborted();
  const workspaceRoot = path.resolve(input.workspaceRoot);
  const canonicalWorkspace = await canonicalRepositoryRoot(
    workspaceRoot,
    input.gitBinary ?? "git",
    timeoutMs,
    input.signal,
  );
  const exclusions = resolveExclusions(
    canonicalWorkspace,
    input.controlRoot,
    input.excludedPaths ?? [],
  );
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "ai-sdlc-changeset-"));
  const temporaryIndex = path.join(temporaryRoot, "index");
  const temporaryObjects = path.join(temporaryRoot, "objects");
  await mkdir(temporaryObjects, { mode: 0o700 });
  try {
    const baseEnvironment = gitEnvironment(process.env, temporaryRoot);
    const probeContext: GitContext = {
      cwd: canonicalWorkspace,
      binary: input.gitBinary ?? "git",
      environment: baseEnvironment,
      timeoutMs,
      signal: input.signal,
    };
    const gitObjectPath = decodeSingleLine((await runGit(
      probeContext,
      ["rev-parse", "--git-path", "objects"],
      metadataOutputLimit,
    )).stdout);
    const canonicalObjects = path.resolve(canonicalWorkspace, gitObjectPath);
    const environment = {
      ...baseEnvironment,
      GIT_INDEX_FILE: temporaryIndex,
      GIT_OBJECT_DIRECTORY: temporaryObjects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: canonicalObjects,
    };
    const context = { ...probeContext, environment };
    await runGit(context, ["cat-file", "-e", `${baseRevision}^{commit}`], metadataOutputLimit);
    const headRevision = gitRevisionSchema.parse(decodeSingleLine((await runGit(
      context,
      ["rev-parse", "--verify", "HEAD"],
      metadataOutputLimit,
    )).stdout)).toLowerCase();
    await runGit(context, ["read-tree", baseRevision], metadataOutputLimit);
    const pathspecs = [
      ".",
      ...exclusions.map((excluded) => `:(exclude,top)${excluded}`),
    ];
    await runGit(context, ["add", "-A", "--", ...pathspecs], metadataOutputLimit);

    const diffBaseArgs = [
      "--cached",
      "--find-renames",
      "--find-copies",
      baseRevision,
      "--",
    ];
    const nameStatus = (await runGit(
      context,
      ["diff", "--name-status", "-z", ...diffBaseArgs],
      metadataOutputLimit,
    )).stdout;
    const files = parseNameStatus(nameStatus);
    if (files.length > maxFiles) {
      throw new AppError(
        `Changeset 文件数超过 ${maxFiles} 项限制`,
        422,
        "CHANGESET_FILE_LIMIT_EXCEEDED",
        { limit: maxFiles, observedAtLeast: files.length },
      );
    }
    const numstat = (await runGit(
      context,
      ["diff", "--numstat", "-z", ...diffBaseArgs],
      metadataOutputLimit,
    )).stdout;
    const binaryPaths = parseBinaryPaths(numstat);
    const materializedFiles = files.map((file) => ({
      ...file,
      binary: binaryPaths.has(file.path),
    }));

    let patch: Buffer = Buffer.alloc(0);
    let downloadAvailable = false;
    if (materializedFiles.length > 0) {
      try {
        patch = (await runGit(
          context,
          [
            "diff",
            "--cached",
            "--binary",
            "--full-index",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--find-renames",
            "--find-copies",
            baseRevision,
            "--",
          ],
          maxPatchBytes,
        )).stdout;
        downloadAvailable = patch.length > 0;
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== "CHANGESET_PATCH_TOO_LARGE") throw error;
      }
    }
    const patchSha256 = createHash("sha256").update(patch).digest("hex");
    const dto = changesetSchema.parse({
      runId: input.runId,
      baseRevision,
      headRevision,
      dirty: materializedFiles.length > 0,
      files: materializedFiles,
      patchBytes: patch.length,
      patchSha256,
      generatedAt: new Date().toISOString(),
      downloadAvailable,
    });
    return { ...dto, patch };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function canonicalRepositoryRoot(
  requestedRoot: string,
  binary: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  let canonical: string;
  try {
    const requestedStats = await lstat(requestedRoot);
    if (!requestedStats.isDirectory() || requestedStats.isSymbolicLink()) {
      throw new Error("workspace root is not a physical directory");
    }
    canonical = await realpath(requestedRoot);
  } catch {
    throw new AppError("Run Workspace 不存在或不可读取", 409, "CHANGESET_WORKSPACE_INVALID");
  }
  const context: GitContext = {
    cwd: canonical,
    binary,
    environment: gitEnvironment(process.env, tmpdir()),
    timeoutMs,
    signal,
  };
  const topLevel = await realpath(path.resolve(decodeSingleLine((await runGit(
    context,
    ["rev-parse", "--show-toplevel"],
    metadataOutputLimit,
  )).stdout)));
  if (topLevel !== canonical) {
    throw new AppError(
      "Run Workspace 必须等于 Git repository 根目录",
      409,
      "CHANGESET_WORKSPACE_INVALID",
    );
  }
  return canonical;
}

function resolveExclusions(
  workspaceRoot: string,
  controlRoot: string | undefined,
  requestedPaths: string[],
): string[] {
  const values = [...requestedPaths];
  if (controlRoot) {
    const resolvedControl = path.resolve(controlRoot);
    if (isWithin(workspaceRoot, resolvedControl)) values.push(resolvedControl);
  }
  const result = new Set<string>();
  for (const value of values) {
    const absolute = path.isAbsolute(value)
      ? path.resolve(value)
      : path.resolve(workspaceRoot, ...value.split("/"));
    if (!isWithin(workspaceRoot, absolute) || absolute === workspaceRoot) {
      throw new AppError("Changeset 排除路径无效", 400, "CHANGESET_EXCLUSION_INVALID");
    }
    const relative = path.relative(workspaceRoot, absolute).split(path.sep).join("/");
    assertSafeRepositoryPath(relative);
    result.add(relative);
  }
  return [...result].sort((left, right) => left.localeCompare(right));
}

function parseNameStatus(output: Buffer): Array<Omit<ChangesetFileDto, "binary">> {
  const fields = splitNullFields(output);
  const files: Array<Omit<ChangesetFileDto, "binary">> = [];
  let index = 0;
  while (index < fields.length) {
    const first = decodePathField(fields[index++]!);
    if (!first) continue;
    const tab = first.indexOf("\t");
    const statusToken = tab >= 0 ? first.slice(0, tab) : first;
    const inlinePath = tab >= 0 ? first.slice(tab + 1) : undefined;
    const status = changesetStatus(statusToken[0]);
    if (status === "renamed" || status === "copied") {
      const oldPath = inlinePath ?? decodeRequiredField(fields[index++]);
      const nextPath = decodeRequiredField(fields[index++]);
      assertSafeRepositoryPath(oldPath);
      assertSafeRepositoryPath(nextPath);
      files.push({ path: nextPath, status, oldPath });
    } else {
      const filePath = inlinePath ?? decodeRequiredField(fields[index++]);
      assertSafeRepositoryPath(filePath);
      files.push({ path: filePath, status, oldPath: null });
    }
  }
  return files;
}

function parseBinaryPaths(output: Buffer): Set<string> {
  const fields = splitNullFields(output);
  const result = new Set<string>();
  let index = 0;
  while (index < fields.length) {
    const header = decodePathField(fields[index++]!);
    if (!header) continue;
    const firstTab = header.indexOf("\t");
    const secondTab = firstTab < 0 ? -1 : header.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) {
      throw invalidGitOutput();
    }
    const additions = header.slice(0, firstTab);
    const deletions = header.slice(firstTab + 1, secondTab);
    const inlinePath = header.slice(secondTab + 1);
    let finalPath: string;
    if (inlinePath) {
      finalPath = inlinePath;
    } else {
      decodeRequiredField(fields[index++]);
      finalPath = decodeRequiredField(fields[index++]);
    }
    assertSafeRepositoryPath(finalPath);
    if (additions === "-" && deletions === "-") result.add(finalPath);
  }
  return result;
}

function changesetStatus(value: string | undefined): ChangesetFileStatus {
  const status = value?.toUpperCase();
  if (status === "A") return "added";
  if (status === "M") return "modified";
  if (status === "D") return "deleted";
  if (status === "R") return "renamed";
  if (status === "C") return "copied";
  if (status === "T") return "type_changed";
  if (status === "U") return "unmerged";
  throw invalidGitOutput();
}

function splitNullFields(output: Buffer): Buffer[] {
  const fields: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) continue;
    fields.push(output.subarray(start, index));
    start = index + 1;
  }
  if (start < output.length) throw invalidGitOutput();
  while (fields.at(-1)?.length === 0) fields.pop();
  return fields;
}

function decodeRequiredField(value: Buffer | undefined): string {
  if (!value) throw invalidGitOutput();
  const decoded = decodePathField(value);
  if (!decoded) throw invalidGitOutput();
  return decoded;
}

function decodePathField(value: Buffer): string {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new AppError(
      "Changeset 包含不是 UTF-8 的仓库路径",
      422,
      "CHANGESET_PATH_UNSUPPORTED",
    );
  }
  return decoded;
}

function assertSafeRepositoryPath(value: string): void {
  if (
    !value
    || value.startsWith("/")
    || /^[A-Za-z]:/u.test(value)
    || value.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(value)
    || value.split("/").some((component) => !component || component === "." || component === "..")
  ) {
    throw new AppError(
      "Changeset 包含无法安全展示的仓库路径",
      422,
      "CHANGESET_PATH_UNSUPPORTED",
    );
  }
}

async function runGit(
  context: GitContext,
  args: string[],
  maxOutputBytes: number,
): Promise<GitResult> {
  context.signal?.throwIfAborted();
  return new Promise<GitResult>((resolve, reject) => {
    const child = spawn(context.binary, [...gitConfigArgs, ...args], {
      cwd: context.cwd,
      env: context.environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputExceeded = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const finish = (error?: unknown, result?: GitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(result!);
    };
    const abort = () => {
      aborted = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, context.timeoutMs);
    timer.unref();
    context.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += bytes.length;
      if (stdoutBytes > maxOutputBytes) {
        outputExceeded = true;
        child.kill("SIGKILL");
        return;
      }
      stdout.push(bytes);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      if (stderrBytes >= stderrLimit) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const bounded = bytes.subarray(0, stderrLimit - stderrBytes);
      stderr.push(bounded);
      stderrBytes += bounded.length;
    });
    child.once("error", () => finish(new AppError(
      "Git Changeset 工具不可用",
      503,
      "CHANGESET_GIT_UNAVAILABLE",
    )));
    child.once("close", (exitCode) => {
      if (aborted) {
        finish(new AppError("Changeset 生成已取消", 400, "CHANGESET_ABORTED"));
        return;
      }
      if (timedOut) {
        finish(new AppError("Git Changeset 命令超时", 504, "CHANGESET_GIT_TIMEOUT"));
        return;
      }
      if (outputExceeded) {
        finish(new AppError(
          "Changeset patch 超过平台限制",
          422,
          "CHANGESET_PATCH_TOO_LARGE",
          { limit: maxOutputBytes },
        ));
        return;
      }
      if (exitCode !== 0) {
        const diagnostic = Buffer.concat(stderr);
        finish(new AppError(
          "无法从 Run Workspace 生成可信 Changeset",
          422,
          "CHANGESET_GIT_FAILED",
          {
            exitCode,
            diagnosticBytes: diagnostic.length,
            diagnosticHash: diagnostic.length > 0
              ? createHash("sha256").update(diagnostic).digest("hex")
              : null,
          },
        ));
        return;
      }
      finish(undefined, { stdout: Buffer.concat(stdout), exitCode: exitCode ?? 0 });
    });
  });
}

function gitEnvironment(source: NodeJS.ProcessEnv, isolatedHome: string): NodeJS.ProcessEnv {
  const allowed = ["PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL"];
  return {
    ...Object.fromEntries(
      allowed.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]]),
    ),
    HOME: isolatedHome,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    LANG: "C",
    LC_ALL: "C",
  };
}

function decodeSingleLine(output: Buffer): string {
  const value = output.toString("utf8").trim();
  if (!value || /[\r\n\u0000]/u.test(value)) throw invalidGitOutput();
  return value;
}

function invalidGitOutput(): AppError {
  return new AppError(
    "Git Changeset 返回了无法验证的结果",
    422,
    "CHANGESET_GIT_OUTPUT_INVALID",
  );
}

function boundedPositiveInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new AppError(`${label} 无效`, 400, "CHANGESET_LIMIT_INVALID");
  }
  return value;
}
