import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const workerImageLabel = "com.ai-sdlc.worker";
const managedWorkerLabel = "ai-sdlc.managed=true";
const deploymentWorkerLabel = "ai-sdlc.deployment";

export interface CloudStartupPreflightOptions {
  managedRoot: string;
  dockerBinary?: string;
  workerImage?: string;
  fakeCodex: boolean;
  skipDocker?: boolean;
  dockerCommand?: DockerCommand;
}

export interface CloudStartupPreflightResult {
  managedRoot: string;
  docker: {
    checked: boolean;
    serverVersion: string | null;
    /** Immutable local Docker image ID used by every Worker after this check. */
    workerImage: string | null;
    deploymentId: string;
    recoveredContainers: number;
  };
}

export type DockerCommand = (binary: string, args: readonly string[]) => Promise<string>;

/**
 * Verifies the two resources a real remote Run cannot safely discover late:
 * a writable/deletable managed root, and a reachable Docker daemon containing
 * an explicitly labelled Worker image. Real mode cannot bypass this gate.
 */
export async function runCloudStartupPreflight(
  options: CloudStartupPreflightOptions,
): Promise<CloudStartupPreflightResult> {
  const managedRoot = await verifyManagedWorkspaceRoot(options.managedRoot);
  const deploymentId = createHash("sha256").update(managedRoot).digest("hex").slice(0, 32);
  if (options.skipDocker) {
    if (!options.fakeCodex) {
      throw new Error(
        "真实 Cloud Run 不允许跳过 Docker 启动检查；只有 AI_SDLC_CODEX_FAKE=1 可使用跳过开关",
      );
    }
    return {
      managedRoot,
      docker: {
        checked: false,
        serverVersion: null,
        workerImage: null,
        deploymentId,
        recoveredContainers: 0,
      },
    };
  }

  const dockerBinary = safeDockerToken(options.dockerBinary?.trim() || "docker", "Docker binary");
  const configuredWorkerImage = options.workerImage?.trim();
  if (!configuredWorkerImage) {
    throw new Error("真实 Cloud Run 必须配置 AI_SDLC_WORKER_IMAGE，且镜像必须在启动前构建完成");
  }
  const workerImage = safeDockerToken(configuredWorkerImage, "Worker image");
  const command = options.dockerCommand ?? boundedDockerCommand;
  let serverVersion: string;
  try {
    serverVersion = (await command(
      dockerBinary,
      ["version", "--format", "{{.Server.Version}}"],
    )).trim();
  } catch {
    throw new Error(
      "Cloud 启动检查无法访问 Docker daemon/version；请检查 Docker socket、权限和 AI_SDLC_DOCKER_BIN",
    );
  }
  if (!/^\d+\.\d+(?:\.\d+)?(?:[-+._A-Za-z0-9]*)?$/u.test(serverVersion)) {
    throw new Error("Docker daemon 返回了无效 Server Version，Cloud API 拒绝启动");
  }

  let imageInspection: string;
  try {
    imageInspection = (await command(
      dockerBinary,
      [
        "image",
        "inspect",
        "--format",
        `{{.Id}}|{{ index .Config.Labels \"${workerImageLabel}\" }}`,
        workerImage,
      ],
    )).trim();
  } catch {
    throw new Error(
      "Cloud 启动检查找不到已批准的 Worker 镜像；请先构建 AI_SDLC_WORKER_IMAGE",
    );
  }
  const imageMatch = /^(sha256:[a-f0-9]{64})\|(.*)$/u.exec(imageInspection);
  if (!imageMatch || imageMatch[2] !== "true") {
    throw new Error(
      `Worker 镜像缺少 ${workerImageLabel}=true 标签，Cloud API 拒绝使用不明镜像`,
    );
  }
  const workerImageId = imageMatch[1]!;

  let recoveredContainers = 0;
  try {
    const listed = await command(dockerBinary, [
      "ps",
      "--all",
      "--quiet",
      "--filter", `label=${managedWorkerLabel}`,
      "--filter", `label=${deploymentWorkerLabel}=${deploymentId}`,
    ]);
    const containerIds = listed.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
    if (containerIds.length > 1_000 || containerIds.some((id) => !/^[a-f0-9]{12,64}$/u.test(id))) {
      throw new Error("invalid managed container identity list");
    }
    if (containerIds.length > 0) {
      await command(dockerBinary, ["rm", "--force", ...containerIds]);
      recoveredContainers = containerIds.length;
    }
  } catch {
    throw new Error(
      "Cloud 启动检查无法回收本部署遗留的 Worker 容器；API 拒绝启动以避免孤儿任务继续运行",
    );
  }

  return {
    managedRoot,
    docker: {
      checked: true,
      serverVersion,
      workerImage: workerImageId,
      deploymentId,
      recoveredContainers,
    },
  };
}

export async function verifyManagedWorkspaceRoot(requestedRoot: string): Promise<string> {
  const configured = requestedRoot.trim();
  if (!configured || isExampleManagedRoot(configured)) {
    throw new Error(
      "AI_SDLC_MANAGED_WORKSPACE_ROOT 必须是专用目录，不能使用 .env.cloud.example 的示例路径",
    );
  }
  const resolved = path.resolve(configured);
  if (resolved === path.parse(resolved).root) {
    throw new Error("Managed Workspace Root 不能是文件系统根目录");
  }
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  const canonical = await realpath(resolved);
  if (canonical === path.parse(canonical).root) {
    throw new Error("Managed Workspace Root 不能解析为文件系统根目录");
  }
  const stats = await lstat(canonical);
  if (!stats.isDirectory()) throw new Error("Managed Workspace Root 必须是目录");

  const nonce = randomUUID();
  const sentinel = path.join(canonical, `.ai-sdlc-startup-${nonce}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(sentinel, "wx", 0o600);
    await handle.writeFile(nonce, "utf8");
    await handle.close();
    handle = undefined;
    if (await readFile(sentinel, "utf8") !== nonce) {
      throw new Error("Managed Workspace Root 读回检查失败");
    }
    await unlink(sentinel);
    const remains = await lstat(sentinel).then(() => true).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    if (remains) throw new Error("Managed Workspace Root 删除检查失败");
  } catch {
    throw new Error(
      "Managed Workspace Root 必须允许 API 进程创建、读取并删除私有 sentinel 文件",
    );
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(sentinel).catch(() => undefined);
  }
  return canonical;
}

function isExampleManagedRoot(value: string): boolean {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/u, "").toLocaleLowerCase("en-US");
  return normalized === "/absolute/path/to/ai-sdlc-cloud-workspaces"
    || normalized === "/path/to/ai-sdlc-cloud-workspaces"
    || normalized.includes("/你在_ai_sdlc_host_workspace_root_里填写的绝对路径");
}

function safeDockerToken(value: string, label: string): string {
  if (
    !value
    || value.length > 512
    || value.startsWith("-")
    || /[\u0000-\u001f\u007f\s]/u.test(value)
  ) {
    throw new Error(`${label} 配置无效`);
  }
  return value;
}

async function boundedDockerCommand(binary: string, args: readonly string[]): Promise<string> {
  const result = await execFile(binary, [...args], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 16 * 1024,
    windowsHide: true,
  });
  return result.stdout;
}
