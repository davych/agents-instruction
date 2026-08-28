import { spawn } from "node:child_process";
import { mkdtemp, mkdir, lstat, opendir, realpath, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";

import { gitRevisionSchema, type GitRevision } from "@ai-sdlc/contracts";

import { AppError } from "../domain/errors.js";
import type { GitCredentialRegistry, ResolvedGitCredential } from "./git-credential-registry.js";
import type { RepositoryPolicy } from "./repository-policy.js";

export interface GitBrokerOptions {
  policy: RepositoryPolicy;
  credentials: GitCredentialRegistry;
  gitBinary?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxFiles?: number;
  maxBytes?: number;
}

export interface MaterializeGitRepositoryInput {
  repositoryUrl: string;
  requestedRef: string;
  credentialProfileId?: string | null;
  destination: string;
  signal?: AbortSignal;
}

export interface GitMaterialization {
  rootPath: string;
  revision: GitRevision;
  fileCount: number;
  totalBytes: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_MAX_FILES = 100_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_TREE_PATH_BYTES = 4_096;
const SAFE_GIT_CONFIG = [
  "-c", "protocol.file.allow=never",
  "-c", "protocol.ext.allow=never",
  "-c", "http.followRedirects=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "submodule.recurse=false",
  "-c", "filter.lfs.smudge=",
  "-c", "filter.lfs.required=false",
] as const;

export class GitBroker {
  private readonly policy: RepositoryPolicy;
  private readonly credentials: GitCredentialRegistry;
  private readonly gitBinary: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly maxFiles: number;
  private readonly maxBytes: number;

  constructor(options: GitBrokerOptions) {
    this.policy = options.policy;
    this.credentials = options.credentials;
    this.gitBinary = options.gitBinary ?? "git";
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "Git timeout");
    this.maxOutputBytes = positiveInteger(
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      "Git output limit",
    );
    this.maxFiles = positiveInteger(options.maxFiles ?? DEFAULT_MAX_FILES, "Git file limit");
    this.maxBytes = positiveInteger(options.maxBytes ?? DEFAULT_MAX_BYTES, "Git byte limit");
  }

  async materialize(input: MaterializeGitRepositoryInput): Promise<GitMaterialization> {
    assertActive(input.signal);
    const initial = await this.policy.validate(
      input.repositoryUrl,
      input.requestedRef,
      input.signal,
    );
    const credential = this.credentials.resolve(input.credentialProfileId, initial);
    await assertDestinationMissing(input.destination);
    await mkdir(path.dirname(input.destination), { recursive: true });
    await this.run(["init", "--quiet", input.destination], {
      stage: "初始化仓库",
      signal: input.signal,
    });
    try {
      await this.run(["-C", input.destination, "remote", "add", "origin", initial.url], {
        stage: "登记仓库来源",
        signal: input.signal,
      });
      // Resolve DNS again immediately before the untrusted network operations.
      const current = await this.policy.validate(initial.url, initial.requestedRef, input.signal);
      if (current.origin !== initial.origin || current.url !== initial.url) {
        throw new AppError("仓库身份在拉取前发生变化", 409, "REPOSITORY_IDENTITY_CHANGED");
      }
      const pinnedAddress = curlResolveConfig(current);
      await this.withCredential(credential, (credentialEnvironment) => this.run(
        [
          ...(pinnedAddress ? ["-c", pinnedAddress] : []),
          "-C", input.destination,
          "fetch", "--quiet", "--no-tags", "--depth=1", "--filter=blob:none",
          "origin", current.requestedRef,
        ],
        {
          stage: "拉取仓库",
          signal: input.signal,
          environment: credentialEnvironment,
        },
      ));
      await this.preflightTreeFileCount(input.destination, input.signal);
      // A blobless fetch lets the file-count gate run before checkout. Blob
      // materialization may still use the network, so it reuses the pinned DNS
      // and short-lived credential boundary.
      await this.withCredential(credential, (credentialEnvironment) => this.run(
        [
          ...(pinnedAddress ? ["-c", pinnedAddress] : []),
          "-C", input.destination,
          "checkout", "--quiet", "--detach", "--force", "FETCH_HEAD",
        ],
        {
          stage: "建立源码快照",
          signal: input.signal,
          environment: credentialEnvironment,
        },
      ));
      const revision = await this.resolveRevision(input.destination, input.signal);
      const status = await this.run(
        ["-C", input.destination, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
        { stage: "验证源码快照", signal: input.signal },
      );
      if (status.stdout.length > 0) {
        throw new AppError(
          "Git Broker 生成的源码快照不是干净状态",
          422,
          "REPOSITORY_SNAPSHOT_DIRTY",
        );
      }
      const usage = await inspectWorkspaceUsage(
        input.destination,
        this.maxFiles,
        this.maxBytes,
        input.signal,
      );
      return { rootPath: await realpath(input.destination), revision, ...usage };
    } catch (error) {
      throw sanitizeGitError(error);
    }
  }

  async materializeFromSnapshot(input: {
    sourceRoot: string;
    revision: GitRevision;
    destination: string;
    signal?: AbortSignal;
  }): Promise<GitMaterialization> {
    assertActive(input.signal);
    const revision = gitRevisionSchema.parse(input.revision);
    const sourceRoot = await realpath(input.sourceRoot);
    await assertDestinationMissing(input.destination);
    await mkdir(path.dirname(input.destination), { recursive: true });
    try {
      await this.run(
        [
          "-c", "protocol.file.allow=always",
          "clone", "--quiet", "--no-hardlinks", "--no-local", "--no-checkout",
          "--", sourceRoot, input.destination,
        ],
        { stage: "复制 Run Workspace", signal: input.signal },
      );
      await this.run(
        ["-C", input.destination, "checkout", "--quiet", "--detach", "--force", revision],
        { stage: "固定 Run revision", signal: input.signal },
      );
      const resolved = await this.resolveRevision(input.destination, input.signal);
      if (resolved !== revision) {
        throw new AppError(
          "Run Workspace 没有固定到请求的 baseRevision",
          409,
          "RUN_REVISION_MISMATCH",
        );
      }
      const usage = await inspectWorkspaceUsage(
        input.destination,
        this.maxFiles,
        this.maxBytes,
        input.signal,
      );
      return { rootPath: await realpath(input.destination), revision: resolved, ...usage };
    } catch (error) {
      throw sanitizeGitError(error);
    }
  }

  async resolveRevision(workspaceRoot: string, signal?: AbortSignal): Promise<GitRevision> {
    const result = await this.run(
      ["-C", workspaceRoot, "rev-parse", "--verify", "HEAD"],
      { stage: "解析 Git revision", signal },
    );
    try {
      return gitRevisionSchema.parse(result.stdout.toString("utf8").trim());
    } catch {
      throw new AppError("Git 返回了无效 revision", 422, "REPOSITORY_REVISION_INVALID");
    }
  }

  private async preflightTreeFileCount(
    workspaceRoot: string,
    signal?: AbortSignal,
  ): Promise<void> {
    let fileCount = 0;
    let currentPathBytes = 0;
    await this.run(
      ["-C", workspaceRoot, "ls-tree", "-r", "--name-only", "-z", "FETCH_HEAD"],
      {
        stage: "预检仓库文件清单",
        signal,
        onStdoutChunk: (chunk) => {
          for (const byte of chunk) {
            if (byte === 0) {
              fileCount += 1;
              currentPathBytes = 0;
              if (fileCount > this.maxFiles) {
                throw new AppError(
                  "仓库超过管理员配置的文件数限制",
                  413,
                  "REPOSITORY_SIZE_LIMIT",
                );
              }
              continue;
            }
            currentPathBytes += 1;
            if (currentPathBytes > MAX_TREE_PATH_BYTES) {
              throw new AppError(
                "仓库包含过长的文件路径",
                413,
                "REPOSITORY_SIZE_LIMIT",
              );
            }
          }
        },
      },
    );
    if (currentPathBytes !== 0) {
      throw new AppError(
        "Git 文件清单格式无效",
        422,
        "GIT_OPERATION_FAILED",
      );
    }
  }

  private async withCredential<T>(
    credential: ResolvedGitCredential | null,
    operation: (environment: NodeJS.ProcessEnv) => Promise<T>,
  ): Promise<T> {
    if (!credential) return await operation({});
    const directory = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-git-credential-"));
    const secretPath = path.join(directory, "secret");
    const askpassPath = path.join(directory, "askpass.sh");
    try {
      await writeFile(secretPath, credential.secret, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await writeFile(
        askpassPath,
        [
          "#!/bin/sh",
          "case \"$1\" in",
          "  *[Uu]sername*) printf '%s\\n' \"$AI_SDLC_GIT_USERNAME\" ;;",
          "  *) /bin/cat \"$AI_SDLC_GIT_SECRET_FILE\"; printf '\\n' ;;",
          "esac",
          "",
        ].join("\n"),
        { encoding: "utf8", mode: 0o700, flag: "wx" },
      );
      return await operation({
        GIT_ASKPASS: askpassPath,
        GIT_ASKPASS_REQUIRE: "force",
        AI_SDLC_GIT_USERNAME: credential.username,
        AI_SDLC_GIT_SECRET_FILE: secretPath,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private run(
    args: readonly string[],
    options: {
      stage: string;
      signal?: AbortSignal;
      environment?: NodeJS.ProcessEnv;
      onStdoutChunk?: (chunk: Buffer) => void;
    },
  ): Promise<{ stdout: Buffer; stderr: Buffer }> {
    assertActive(options.signal);
    const environment = gitEnvironment(options.environment);
    return new Promise((resolve, reject) => {
      const child = spawn(this.gitBinary, [...SAFE_GIT_CONFIG, ...args], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: environment,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      let failure: AppError | undefined;
      const stop = (error: AppError) => {
        if (failure) return;
        failure = error;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(() => stop(new AppError(
        `${options.stage}超时`,
        504,
        "GIT_OPERATION_TIMEOUT",
      )), this.timeoutMs);
      const abort = () => stop(new AppError(
        "Git 操作已取消",
        499,
        "GIT_OPERATION_CANCELLED",
      ));
      options.signal?.addEventListener("abort", abort, { once: true });
      const collect = (target: Buffer[], chunk: Buffer | string) => {
        if (failure) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outputBytes += buffer.length;
        if (outputBytes > this.maxOutputBytes) {
          stop(new AppError(
            `${options.stage}输出超过限制`,
            422,
            "GIT_OUTPUT_LIMIT",
          ));
          return;
        }
        target.push(buffer);
      };
      child.stdout.on("data", (chunk: Buffer | string) => {
        if (!options.onStdoutChunk) {
          collect(stdout, chunk);
          return;
        }
        if (failure) return;
        try {
          options.onStdoutChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        } catch (error) {
          stop(error instanceof AppError
            ? error
            : new AppError(`${options.stage}输出无法解析`, 422, "GIT_OPERATION_FAILED"));
        }
      });
      child.stderr.on("data", (chunk) => collect(stderr, chunk));
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });
      child.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (failure) {
          reject(failure);
          return;
        }
        if (code !== 0) {
          reject(new AppError(
            `${options.stage}失败`,
            422,
            "GIT_OPERATION_FAILED",
            { exitCode: code, signal: signal ?? null },
          ));
          return;
        }
        resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      });
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
      };
    });
  }
}

function gitEnvironment(extra: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: "C",
    LC_ALL: "C",
    TMPDIR: process.env.TMPDIR,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
  };
  return { ...base, ...extra };
}

function curlResolveConfig(repository: {
  url: string;
  addresses: Array<{ address: string; family: 4 | 6 }>;
}): string | null {
  const parsed = new URL(repository.url);
  const hostname = parsed.hostname.replace(/^\[|\]$/gu, "");
  // A literal IP has no DNS lookup/rebinding window and cannot be represented
  // as the host component of CURLOPT_RESOLVE when it is IPv6.
  if (isIP(hostname)) return null;
  const selected = repository.addresses.find(({ family }) => family === 4)
    ?? repository.addresses[0];
  if (!selected) throw new AppError("仓库 DNS 地址不可用", 422, "REPOSITORY_DNS_EMPTY");
  const address = selected.family === 6 ? `[${selected.address}]` : selected.address;
  return `http.curloptResolve=${hostname}:${parsed.port || "443"}:${address}`;
}

async function assertDestinationMissing(destination: string): Promise<void> {
  if (!path.isAbsolute(destination)) {
    throw new AppError("Managed Workspace 必须使用绝对路径", 500, "WORKSPACE_PATH_INVALID");
  }
  try {
    await lstat(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new AppError("Managed Workspace 目标已经存在", 409, "WORKSPACE_PATH_EXISTS");
}

async function inspectWorkspaceUsage(
  rootPath: string,
  maxFiles: number,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ fileCount: number; totalBytes: number }> {
  const stack = [rootPath];
  let fileCount = 0;
  let totalBytes = 0;
  while (stack.length > 0) {
    assertActive(signal);
    const current = stack.pop()!;
    const directory = await opendir(current);
    for await (const entry of directory) {
      assertActive(signal);
      const target = path.join(current, entry.name);
      const stats = await lstat(target);
      if (stats.isDirectory()) {
        stack.push(target);
        continue;
      }
      fileCount += 1;
      totalBytes += stats.size;
      if (fileCount > maxFiles || totalBytes > maxBytes) {
        throw new AppError(
          "仓库超过管理员配置的文件数或字节限制",
          413,
          "REPOSITORY_SIZE_LIMIT",
        );
      }
    }
  }
  return { fileCount, totalBytes };
}

function sanitizeGitError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") {
    return new AppError("服务端没有可用的 Git Broker", 503, "GIT_NOT_AVAILABLE");
  }
  return new AppError("Git Broker 暂时失败", 502, "GIT_BROKER_FAILED");
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} 必须是正整数`);
  return value;
}

function assertActive(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new AppError("Git 操作已取消", 499, "GIT_OPERATION_CANCELLED");
}
