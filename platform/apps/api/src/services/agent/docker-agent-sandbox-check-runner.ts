import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants, existsSync, realpathSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  ProviderAgentToolError,
  type AgentSandboxCheckDefinition,
  type AgentSandboxCheckResult,
  type AgentSandboxCheckRunner,
} from "./rooted-agent-tool-host.js";

const dockerWorkspaceRoot = "/workspace";
const dockerManagedLabel = "ai-sdlc.agent-check=true";
const forbiddenCheckExecutables = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "fish",
  "powershell",
  "pwsh",
  "env",
  "sudo",
  "su",
  "doas",
  "docker",
  "podman",
  "nsenter",
  "unshare",
]);
const dockerClientEnvironmentKeys = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
] as const;

export interface DockerAgentSandboxCheck extends AgentSandboxCheckDefinition {
  /** Trusted operator/Blueprint argv. It is never serialized to the model. */
  argv: readonly string[];
}

export interface DockerAgentSandboxCheckRunnerOptions {
  /** Absolute, operator-verified Docker/Podman CLI path. */
  dockerBinary: string;
  deploymentId: string;
  image: string;
  user: string;
  cpus: number;
  memory: string;
  pidsLimit: number;
  tmpfsSize: string;
  checks: readonly DockerAgentSandboxCheck[];
  dockerEnvironment?: NodeJS.ProcessEnv;
}

export interface DockerAgentCheckRunSpec {
  containerName: string;
  args: readonly string[];
  environment: NodeJS.ProcessEnv;
}

/**
 * Runs only operator-declared check argv inside an ephemeral, networkless
 * container. No Provider, Git, MCP, proxy, or repository environment value is
 * forwarded. The model can select a check ID; it can never supply argv.
 */
export class DockerAgentSandboxCheckRunner implements AgentSandboxCheckRunner {
  readonly isolation = "container" as const;
  private readonly dockerBinary: string;
  private readonly checks: ReadonlyMap<string, DockerAgentSandboxCheck>;
  private readonly options: DockerAgentSandboxCheckRunnerOptions;

  constructor(options: DockerAgentSandboxCheckRunnerOptions) {
    validateDockerOptions(options);
    this.dockerBinary = resolveDockerBinary(options.dockerBinary);
    this.options = options;
    this.checks = new Map(options.checks.map((check) => [check.id, {
      ...check,
      argv: [...check.argv],
    }]));
  }

  definitions(): readonly AgentSandboxCheckDefinition[] {
    return [...this.checks.values()].map(({ id, label, timeoutMs }) => ({
      id,
      label,
      timeoutMs,
    }));
  }

  async run(input: {
    checkId: string;
    workspaceRoot: string;
    timeoutMs: number;
    maxOutputBytes: number;
    signal: AbortSignal;
  }): Promise<AgentSandboxCheckResult> {
    const check = this.checks.get(input.checkId);
    if (!check || check.timeoutMs !== input.timeoutMs) {
      throw new ProviderAgentToolError(
        "AGENT_CHECK_NOT_ALLOWED",
        "该检查不在当前 Sandbox Blueprint 的批准列表中",
      );
    }
    if (!Number.isSafeInteger(input.maxOutputBytes) || input.maxOutputBytes < 1_024 || input.maxOutputBytes > 1_000_000) {
      throw new ProviderAgentToolError("AGENT_CHECK_LIMIT_INVALID", "Sandbox 检查输出上限无效");
    }
    if (input.signal.aborted) {
      throw new ProviderAgentToolError("AGENT_CHECK_CANCELLED", "Sandbox 检查已取消");
    }

    const workspaceRoot = await realpath(path.resolve(input.workspaceRoot));
    const spec = buildDockerAgentCheckRunSpec({
      ...this.options,
      workspaceRoot,
      check,
      executionId: randomUUID(),
    });
    const startedAt = Date.now();
    const child = spawn(this.dockerBinary, [...spec.args], {
      cwd: workspaceRoot,
      env: spec.environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let outputExceeded = false;
    let timedOut = false;
    let spawnError = false;
    let settled = false;

    const collect = (chunk: Buffer | string): void => {
      if (outputExceeded) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = input.maxOutputBytes - outputBytes;
      if (remaining <= 0) {
        outputExceeded = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(bytes.subarray(0, remaining));
      outputBytes += Math.min(bytes.length, remaining);
      if (bytes.length > remaining) {
        outputExceeded = true;
        child.kill("SIGKILL");
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const cancel = (): void => {
      child.kill("SIGKILL");
    };
    input.signal.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, check.timeoutMs);
    timeout.unref();

    const exitCode = await new Promise<number>((resolve) => {
      const finish = (code: number): void => {
        if (settled) return;
        settled = true;
        resolve(code);
      };
      child.once("error", () => {
        spawnError = true;
        finish(1);
      });
      child.once("close", (code) => finish(code ?? 1));
    }).finally(() => {
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", cancel);
    });

    if (timedOut || outputExceeded || input.signal.aborted || spawnError) {
      await removeContainer(this.dockerBinary, spec.containerName, spec.environment);
    }
    if (input.signal.aborted) {
      throw new ProviderAgentToolError("AGENT_CHECK_CANCELLED", "Sandbox 检查已取消");
    }
    if (timedOut) {
      throw new ProviderAgentToolError("AGENT_CHECK_TIMEOUT", "Sandbox 检查达到时间上限，已停止");
    }
    if (outputExceeded) {
      throw new ProviderAgentToolError("AGENT_CHECK_OUTPUT_LIMIT", "Sandbox 检查输出过多，已停止");
    }
    if (spawnError) {
      throw new ProviderAgentToolError(
        "AGENT_CHECK_RUNNER_UNAVAILABLE",
        "无法启动隔离 Sandbox Runner；内部命令和环境未暴露",
      );
    }
    return {
      exitCode,
      output: Buffer.concat(chunks).toString("utf8"),
      durationMs: Date.now() - startedAt,
    };
  }
}

export function buildDockerAgentCheckRunSpec(input: {
  deploymentId: string;
  executionId: string;
  workspaceRoot: string;
  image: string;
  user: string;
  cpus: number;
  memory: string;
  pidsLimit: number;
  tmpfsSize: string;
  check: DockerAgentSandboxCheck;
  dockerEnvironment?: NodeJS.ProcessEnv;
}): DockerAgentCheckRunSpec {
  validateDockerToken(input.image, "Sandbox image");
  validateDeploymentId(input.deploymentId);
  validateDockerResources(input);
  validateCheck(input.check);
  const workspaceRoot = dockerBindSource(input.workspaceRoot);
  const executionIdentity = createHash("sha256")
    .update(input.executionId)
    .digest("hex")
    .slice(0, 32);
  const containerName = `ai-sdlc-agent-${executionIdentity}`;
  const args: string[] = [
    "run",
    "--rm",
    "--init",
    "--name", containerName,
    "--label", dockerManagedLabel,
    "--label", `ai-sdlc.deployment=${input.deploymentId}`,
    "--label", `ai-sdlc.execution=${executionIdentity}`,
    "--network", "none",
    "--user", input.user,
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true",
    "--pids-limit", String(input.pidsLimit),
    "--cpus", String(input.cpus),
    "--memory", input.memory,
    "--stop-timeout", "3",
    "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=${input.tmpfsSize},mode=1777`,
    "--workdir", dockerWorkspaceRoot,
    "--mount", dockerMount(workspaceRoot, dockerWorkspaceRoot, false),
  ];
  const gitPath = path.join(workspaceRoot, ".git");
  if (existsSync(gitPath)) {
    const canonicalGitPath = realpathSync(gitPath);
    if (!isWithin(workspaceRoot, canonicalGitPath)) {
      throw new Error("Sandbox Git metadata 超出 Workspace");
    }
    args.push("--mount", dockerMount(canonicalGitPath, `${dockerWorkspaceRoot}/.git`, true));
  }
  args.push(
    "--env", "CI=1",
    "--env", "NO_COLOR=1",
    "--env", "HOME=/tmp",
    input.image,
    ...input.check.argv,
  );
  return {
    containerName,
    args,
    environment: selectedDockerClientEnvironment(input.dockerEnvironment ?? process.env),
  };
}

function validateDockerOptions(options: DockerAgentSandboxCheckRunnerOptions): void {
  resolveDockerBinary(options.dockerBinary);
  validateDockerToken(options.image, "Sandbox image");
  validateDeploymentId(options.deploymentId);
  validateDockerResources(options);
  if (options.checks.length < 1 || options.checks.length > 32) {
    throw new Error("Sandbox check 数量无效");
  }
  const ids = new Set<string>();
  for (const check of options.checks) {
    validateCheck(check);
    if (ids.has(check.id)) throw new Error("Sandbox check ID 重复");
    ids.add(check.id);
  }
}

function resolveDockerBinary(candidate: string): string {
  if (
    !path.isAbsolute(candidate)
    || !["docker", "podman"].includes(path.basename(candidate).toLocaleLowerCase("en-US"))
  ) {
    throw new Error("Sandbox Runner 需要管理员验证的绝对 Docker/Podman CLI 路径");
  }
  const canonical = realpathSync(candidate);
  if (!statSync(canonical).isFile()) throw new Error("Sandbox Runner CLI 不是普通文件");
  accessSync(canonical, fsConstants.X_OK);
  return canonical;
}

function validateCheck(check: DockerAgentSandboxCheck): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u.test(check.id)
    || !check.label.trim()
    || check.label.length > 200
    || !Number.isSafeInteger(check.timeoutMs)
    || check.timeoutMs < 1_000
    || check.timeoutMs > 10 * 60_000
    || check.argv.length < 1
    || check.argv.length > 128
  ) {
    throw new Error("Sandbox check 定义无效");
  }
  for (const [index, token] of check.argv.entries()) {
    if (
      typeof token !== "string"
      || token.length < 1
      || token.length > 4_096
      || /[\u0000-\u001f\u007f]/u.test(token)
      || (index === 0 && (
        token.startsWith("-")
        || token.includes("/")
        || forbiddenCheckExecutables.has(token.toLocaleLowerCase("en-US"))
      ))
    ) {
      throw new Error("Sandbox check argv 无效");
    }
  }
}

function validateDockerResources(input: {
  user: string;
  cpus: number;
  memory: string;
  pidsLimit: number;
  tmpfsSize: string;
}): void {
  const userMatch = /^(\d+):(\d+)$/u.exec(input.user);
  if (!userMatch || Number(userMatch[1]) <= 0 || Number(userMatch[2]) <= 0) {
    throw new Error("Sandbox Runner 必须使用非 root uid:gid");
  }
  if (!Number.isFinite(input.cpus) || input.cpus <= 0 || input.cpus > 64) {
    throw new Error("Sandbox Runner CPU 限制无效");
  }
  if (!Number.isSafeInteger(input.pidsLimit) || input.pidsLimit < 16 || input.pidsLimit > 4_096) {
    throw new Error("Sandbox Runner PID 限制无效");
  }
  validateDockerSize(input.memory, "memory");
  validateDockerSize(input.tmpfsSize, "tmpfs");
}

function validateDeploymentId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(value)) {
    throw new Error("Sandbox deployment ID 无效");
  }
}

function validateDockerToken(value: string, label: string): void {
  if (
    !value
    || value.length > 512
    || /[\s\u0000-\u001f\u007f]/u.test(value)
    || value.startsWith("-")
  ) {
    throw new Error(`${label} 配置无效`);
  }
}

function validateDockerSize(value: string, label: string): void {
  if (!/^[1-9][0-9]*(?:[bkmg])?$/iu.test(value)) {
    throw new Error(`Sandbox ${label} 限制无效`);
  }
}

function dockerBindSource(value: string): string {
  const resolved = path.resolve(value);
  if (!path.isAbsolute(value) || /[,\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("Sandbox Workspace 不能安全挂载");
  }
  const canonical = realpathSync(resolved);
  if (!statSync(canonical).isDirectory()) throw new Error("Sandbox Workspace 不是目录");
  return canonical;
}

function dockerMount(source: string, destination: string, readonly: boolean): string {
  return [
    "type=bind",
    `src=${source}`,
    `dst=${destination}`,
    readonly ? "readonly" : null,
    "bind-propagation=rprivate",
  ].filter(Boolean).join(",");
}

function selectedDockerClientEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    dockerClientEnvironmentKeys.flatMap((key) => (
      source[key] === undefined ? [] : [[key, source[key]]]
    )),
  );
}

async function removeContainer(
  dockerBinary: string,
  containerName: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await runDockerCommand(dockerBinary, ["rm", "--force", containerName], environment);
    const inspection = await runDockerCommand(
      dockerBinary,
      ["container", "inspect", containerName],
      environment,
    );
    if (!inspection.spawnFailed && !inspection.timedOut && inspection.exitCode !== 0) return;
  }
  throw new ProviderAgentToolError(
    "AGENT_CHECK_CLEANUP_FAILED",
    "无法确认 Sandbox 检查容器已停止；Workspace 必须隔离后人工处理",
    true,
  );
}

async function runDockerCommand(
  dockerBinary: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<{ exitCode: number | null; spawnFailed: boolean; timedOut: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(dockerBinary, [...args], {
      env: environment,
      stdio: "ignore",
    });
    const finish = (result: {
      exitCode: number | null;
      spawnFailed: boolean;
      timedOut: boolean;
    }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ exitCode: null, spawnFailed: false, timedOut: true });
    }, 5_000);
    timer.unref();
    child.once("error", () => finish({ exitCode: null, spawnFailed: true, timedOut: false }));
    child.once("close", (exitCode) => finish({ exitCode, spawnFailed: false, timedOut: false }));
  });
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === ""
    || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
