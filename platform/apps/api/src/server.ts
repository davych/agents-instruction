import "dotenv/config";

import path from "node:path";

import { codexReasoningEffortSchema } from "@ai-sdlc/contracts";

import { buildApp } from "./app.js";
import { createPool, migrate } from "./db/pool.js";
import { createSandboxBlueprintRegistryFromEnv } from "./services/agent/sandbox-blueprint-registry.js";
import {
  assertSafeNetworkBinding,
  normalizeAccessToken,
  parseAllowedOrigins,
} from "./services/access-control.js";
import { runCloudStartupPreflight } from "./services/cloud-startup-preflight.js";
import { createAskProviderRegistryFromEnv } from "./services/llm/provider-registry.js";
import { createGitCredentialRegistryFromEnv } from "./services/git-credential-registry.js";
import { RepositoryPolicy } from "./services/repository-policy.js";
import { createWorkItemMcpRegistryFromEnv } from "./services/work-item/work-item-mcp-registry.js";
import { parsePositiveIntegerSetting } from "./services/environment-config.js";

const connectionString = process.env.DATABASE_URL
  ?? "postgresql://ai_sdlc:ai_sdlc_dev@127.0.0.1:54329/ai_sdlc";
const pool = createPool(connectionString);

try {
  const host = process.env.HOST ?? "127.0.0.1";
  const accessToken = normalizeAccessToken(process.env.AI_SDLC_ACCESS_TOKEN);
  assertSafeNetworkBinding(host, accessToken);
  const managedRoot = path.resolve(
    process.cwd(),
    process.env.AI_SDLC_MANAGED_WORKSPACE_ROOT?.trim() || ".data/cloud-workspaces",
  );
  const gitAllowedOrigins = parseCommaSeparated(process.env.AI_SDLC_GIT_ALLOWED_ORIGINS)
    ?? ["https://github.com", "https://gitlab.com", "https://bitbucket.org"];
  const gitCredentials = createGitCredentialRegistryFromEnv(process.env);
  const fakeCodex = parseFakeCodex(process.env.AI_SDLC_CODEX_FAKE);
  const dockerWorkerUser = resolveWorkerUser(process.env.AI_SDLC_WORKER_USER);
  const repositoryPolicy = new RepositoryPolicy({
    allowedOrigins: gitAllowedOrigins,
    allowPrivateAddresses: parseStrictFlag(
      process.env.AI_SDLC_GIT_ALLOW_PRIVATE_NETWORKS,
      "AI_SDLC_GIT_ALLOW_PRIVATE_NETWORKS",
    ),
  });
  const cloudPreflight = await runCloudStartupPreflight({
    managedRoot,
    dockerBinary: process.env.AI_SDLC_DOCKER_BIN,
    workerImage: process.env.AI_SDLC_WORKER_IMAGE,
    fakeCodex,
    skipDocker: parseStrictFlag(
      process.env.AI_SDLC_CLOUD_SKIP_DOCKER_PREFLIGHT,
      "AI_SDLC_CLOUD_SKIP_DOCKER_PREFLIGHT",
    ),
  });
  await migrate(pool);
  const app = await buildApp({
    pool,
    logger: true,
    allowedProjectRoots: parseAllowedRoots(process.env.AI_SDLC_ALLOWED_PROJECT_ROOTS),
    codexBinary: process.env.AI_SDLC_CODEX_BIN,
    fakeCodex,
    codexTimeoutMs: parsePositiveIntegerSetting(
      process.env.AI_SDLC_CODEX_TIMEOUT_MS,
      "AI_SDLC_CODEX_TIMEOUT_MS",
    ),
    codexAllowedModels: parseCommaSeparated(process.env.AI_SDLC_CODEX_MODELS),
    codexAllowedReasoningEfforts: parseCommaSeparated(process.env.AI_SDLC_CODEX_REASONING_EFFORTS)
      ?.map((value) => codexReasoningEffortSchema.parse(value)),
    codexDefaultModel: process.env.AI_SDLC_CODEX_DEFAULT_MODEL?.trim() || undefined,
    codexDefaultReasoningEffort: process.env.AI_SDLC_CODEX_DEFAULT_REASONING_EFFORT
      ? codexReasoningEffortSchema.parse(process.env.AI_SDLC_CODEX_DEFAULT_REASONING_EFFORT)
      : undefined,
    codexHome: process.env.CODEX_HOME,
    dockerWorkerImage: cloudPreflight.docker.workerImage ?? undefined,
    dockerDeploymentId: cloudPreflight.docker.deploymentId,
    dockerWorkerUser,
    trustedExecutionRepositories: parseCommaSeparated(
      process.env.AI_SDLC_REAL_EXECUTION_TRUSTED_REPOSITORIES,
    ),
    maxConcurrentPhases: parsePositiveIntegerSetting(
      process.env.AI_SDLC_MAX_CONCURRENT_PHASES,
      "AI_SDLC_MAX_CONCURRENT_PHASES",
    ),
    recoverChatAgentRuntimeOnStart: true,
    cliPath: process.env.AI_SDLC_CLI_PATH
      ? path.resolve(process.cwd(), process.env.AI_SDLC_CLI_PATH)
      : undefined,
    askProviders: createAskProviderRegistryFromEnv(process.env),
    sandboxBlueprintRegistry: createSandboxBlueprintRegistryFromEnv(
      process.env,
      cloudPreflight.docker.workerImage ?? undefined,
    ),
    workItemAdapters: createWorkItemMcpRegistryFromEnv(process.env, {
      timeoutMs: parsePositiveIntegerSetting(
        process.env.AI_SDLC_WORK_ITEM_MCP_TIMEOUT_MS,
        "AI_SDLC_WORK_ITEM_MCP_TIMEOUT_MS",
      ),
      maxOutputBytes: parsePositiveIntegerSetting(
        process.env.AI_SDLC_WORK_ITEM_MCP_MAX_OUTPUT_BYTES,
        "AI_SDLC_WORK_ITEM_MCP_MAX_OUTPUT_BYTES",
      ),
      maxConcurrent: parsePositiveIntegerSetting(
        process.env.AI_SDLC_WORK_ITEM_MCP_MAX_CONCURRENT,
        "AI_SDLC_WORK_ITEM_MCP_MAX_CONCURRENT",
      ),
    }),
    accessToken,
    allowedOrigins: parseAllowedOrigins(process.env.AI_SDLC_ALLOWED_ORIGINS),
    cloud: {
      managedRoot,
      repositoryPolicy,
      credentials: gitCredentials,
      gitBrokerOptions: {
        timeoutMs: parsePositiveIntegerSetting(
          process.env.AI_SDLC_GIT_TIMEOUT_MS,
          "AI_SDLC_GIT_TIMEOUT_MS",
        ),
        maxOutputBytes: parsePositiveIntegerSetting(
          process.env.AI_SDLC_GIT_MAX_OUTPUT_BYTES,
          "AI_SDLC_GIT_MAX_OUTPUT_BYTES",
        ),
        maxBytes: parsePositiveIntegerSetting(
          process.env.AI_SDLC_GIT_MAX_REPOSITORY_BYTES,
          "AI_SDLC_GIT_MAX_REPOSITORY_BYTES",
        ),
        maxFiles: parsePositiveIntegerSetting(
          process.env.AI_SDLC_GIT_MAX_FILES,
          "AI_SDLC_GIT_MAX_FILES",
        ),
      },
    },
  });
  app.addHook("onClose", async () => pool.end());
  await app.listen({
    host,
    port: Number(process.env.PORT ?? 4100)
  });
} catch (error) {
  await pool.end();
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function parseAllowedRoots(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const roots = value.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
  return roots.length > 0 ? roots : undefined;
}

function parseCommaSeparated(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  return entries.length > 0 ? entries : undefined;
}

function parseFakeCodex(value: string | undefined): boolean {
  const normalized = value?.trim();
  if (!normalized || normalized === "0") return false;
  if (normalized === "1") return true;
  throw new Error("AI_SDLC_CODEX_FAKE 只允许设置为 0（真实执行）或 1（模拟执行）");
}

function parseStrictFlag(value: string | undefined, label: string): boolean {
  const normalized = value?.trim();
  if (!normalized || normalized === "0") return false;
  if (normalized === "1") return true;
  throw new Error(`${label} 只允许设置为 0 或 1`);
}

function resolveWorkerUser(configured: string | undefined): string {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    if (!configured?.trim()) {
      throw new Error("非 POSIX Cloud Host 必须显式配置 AI_SDLC_WORKER_USER");
    }
    return configured.trim();
  }
  const apiIdentity = `${process.getuid()}:${process.getgid()}`;
  const selected = configured?.trim() || apiIdentity;
  if (!/^[1-9][0-9]*:[1-9][0-9]*$/u.test(selected)) {
    throw new Error("AI_SDLC_WORKER_USER 必须是非 root 的 uid:gid");
  }
  if (selected !== apiIdentity) {
    throw new Error(
      `AI_SDLC_WORKER_USER (${selected}) 必须与 API 进程 uid:gid (${apiIdentity}) 一致，` +
      "否则 Worker 无法安全写入 Run Workspace",
    );
  }
  return selected;
}
