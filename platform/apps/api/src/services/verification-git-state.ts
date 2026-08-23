import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { AppError } from "../domain/errors.js";
import { isWithin } from "./project-paths.js";
import {
  VERIFICATION_RUNTIME_EVIDENCE_PATHS,
  VERIFICATION_SNAPSHOT_EXCLUDED_DIRECTORY_NAMES,
  VERIFICATION_SNAPSHOT_EXCLUDED_RELATIVE_DIRECTORIES,
} from "./verification-workspace.js";

export type VerificationGitState =
  | {
    kind: "head";
    repositoryRoot: string;
    gitDirectory: string;
    gitCommonDirectory: string;
    head: string;
  }
  | {
    kind: "unborn";
    repositoryRoot: string;
    gitDirectory: string;
    gitCommonDirectory: string;
    symbolicHead: string;
  }
  | { kind: "not_repository" };

interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Captures Git identity without treating command or repository corruption as non-Git. */
export async function captureVerificationGitState(
  projectRoot: string,
): Promise<VerificationGitState> {
  let worktree: GitCommandResult;
  try {
    worktree = await runGit(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
  } catch (error) {
    const reason = (error as { details?: { reason?: unknown } }).details?.reason;
    if (reason === "ENOENT" && !await hasGitMetadataAtOrAbove(projectRoot)) {
      return { kind: "not_repository" };
    }
    throw error;
  }
  if (worktree.exitCode !== 0) {
    if (worktree.exitCode === 128 && /not a git repository/iu.test(worktree.stderr)) {
      if (!await hasGitMetadataAtOrAbove(projectRoot)) return { kind: "not_repository" };
      throw gitStateError("Verification .git 元数据存在但不是可读取的 repository", worktree);
    }
    throw gitStateError("无法判断 Verification 项目的 Git 状态", worktree);
  }
  if (worktree.stdout.trim() !== "true") {
    throw gitStateError("Verification 项目必须是普通 Git worktree，而不是 bare repository", worktree);
  }

  const rootResult = await runGit(projectRoot, ["rev-parse", "--show-toplevel"]);
  if (rootResult.exitCode !== 0 || !rootResult.stdout.trim()) {
    throw gitStateError("无法解析 Verification Git worktree 根目录", rootResult);
  }
  let repositoryRoot: string;
  let projectCanonical: string;
  try {
    [repositoryRoot, projectCanonical] = await Promise.all([
      realpath(rootResult.stdout.trim()),
      realpath(projectRoot),
    ]);
  } catch {
    throw gitStateError("Verification Git worktree 根目录不存在或不可读取", rootResult);
  }
  if (repositoryRoot !== projectCanonical) {
    throw gitStateError(
      "Verification 项目根必须等于 Git worktree 根；父仓库中的嵌套项目不受支持",
      rootResult,
    );
  }

  const gitDirResult = await runGit(projectRoot, ["rev-parse", "--absolute-git-dir"]);
  const commonDirResult = await runGit(projectRoot, ["rev-parse", "--git-common-dir"]);
  const [gitDir, commonDir] = await Promise.all([
    canonicalGitDirectory(projectRoot, gitDirResult, "git-dir"),
    canonicalGitDirectory(projectRoot, commonDirResult, "git common-dir"),
  ]);
  const gitDirProtected = isProtectedGitDirectory(projectCanonical, gitDir);
  const commonDirProtected = isProtectedGitDirectory(projectCanonical, commonDir);
  if (!gitDirProtected || !commonDirProtected) {
    throw gitStateError(
      "Verification Git 元数据必须完整位于受保护的项目树内；linked worktree 或外置 git-dir 不受支持",
      !gitDirProtected ? gitDirResult : commonDirResult,
    );
  }

  const headResult = await runGit(projectRoot, ["rev-parse", "--verify", "HEAD"]);
  const head = headResult.stdout.trim().toLowerCase();
  if (headResult.exitCode === 0) {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(head)) {
      throw gitStateError("Verification Git HEAD 不是有效的完整 SHA", headResult);
    }
    return { kind: "head", repositoryRoot, gitDirectory: gitDir, gitCommonDirectory: commonDir, head };
  }

  const symbolicResult = await runGit(projectRoot, ["symbolic-ref", "-q", "HEAD"]);
  const symbolicHead = symbolicResult.stdout.trim();
  if (symbolicResult.exitCode !== 0 || !/^refs\/heads\/[A-Za-z0-9._/-]+$/u.test(symbolicHead)) {
    throw gitStateError("Verification Git HEAD 损坏或无法解析", symbolicResult);
  }
  const referenceResult = await runGit(projectRoot, [
    "show-ref",
    "--verify",
    "--quiet",
    symbolicHead,
  ]);
  if (referenceResult.exitCode === 1) {
    return {
      kind: "unborn",
      repositoryRoot,
      gitDirectory: gitDir,
      gitCommonDirectory: commonDir,
      symbolicHead,
    };
  }
  throw gitStateError("Verification Git HEAD 引用存在但无法解析提交", referenceResult);
}

async function hasGitMetadataAtOrAbove(projectRoot: string): Promise<boolean> {
  let cursor = path.resolve(projectRoot);
  while (true) {
    try {
      await lstat(path.join(cursor, ".git"));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new AppError(
          "Verification Git 元数据探测失败",
          422,
          "VERIFICATION_GIT_STATE_FAILED",
        );
      }
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
}

async function canonicalGitDirectory(
  projectRoot: string,
  result: GitCommandResult,
  label: string,
): Promise<string> {
  const value = result.stdout.trim();
  if (result.exitCode !== 0 || !value) {
    throw gitStateError(`无法解析 Verification ${label}`, result);
  }
  try {
    return await realpath(path.isAbsolute(value) ? value : path.resolve(projectRoot, value));
  } catch {
    throw gitStateError(`Verification ${label} 不存在或不可读取`, result);
  }
}

function isProtectedGitDirectory(projectRoot: string, candidate: string): boolean {
  if (!isWithin(projectRoot, candidate) || candidate === projectRoot) return false;
  const components = path.relative(projectRoot, candidate).split(path.sep);
  if (components.some((component) => (
    (VERIFICATION_SNAPSHOT_EXCLUDED_DIRECTORY_NAMES as readonly string[]).includes(component)
  ))) return false;
  if ((VERIFICATION_RUNTIME_EVIDENCE_PATHS as readonly string[]).includes(components[0] ?? "")) {
    return false;
  }
  const normalized = components.join("/");
  return !(VERIFICATION_SNAPSHOT_EXCLUDED_RELATIVE_DIRECTORIES as readonly string[]).some(
    (excluded) => normalized === excluded || normalized.startsWith(`${excluded}/`),
  );
}

function runGit(projectRoot: string, args: string[]): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", projectRoot, ...args],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 5_000,
        env: gitEnvironment(process.env),
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ exitCode: 0, stdout, stderr });
          return;
        }
        const code = (error as NodeJS.ErrnoException & { code?: string | number }).code;
        if (typeof code === "number") {
          resolve({ exitCode: code, stdout, stderr });
          return;
        }
        reject(new AppError(
          "无法安全读取 Verification Git 状态",
          422,
          "VERIFICATION_GIT_STATE_FAILED",
          { reason: typeof code === "string" ? code : "command_failed" },
        ));
      },
    );
  });
}

function gitEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const filtered = Object.fromEntries(
    Object.entries(source).filter(([key]) => !key.startsWith("GIT_")),
  );
  return { ...filtered, LC_ALL: "C", LANG: "C", GIT_OPTIONAL_LOCKS: "0" };
}

function gitStateError(message: string, result: GitCommandResult): AppError {
  return new AppError(message, 422, "VERIFICATION_GIT_STATE_FAILED", {
    exitCode: result.exitCode,
    stderrBytes: Buffer.byteLength(result.stderr),
  });
}
