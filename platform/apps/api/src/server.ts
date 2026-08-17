import "dotenv/config";

import path from "node:path";

import { codexReasoningEffortSchema } from "@ai-sdlc/contracts";

import { buildApp } from "./app.js";
import { createPool, migrate } from "./db/pool.js";

const connectionString = process.env.DATABASE_URL
  ?? "postgresql://ai_sdlc:ai_sdlc_dev@127.0.0.1:54329/ai_sdlc";
const pool = createPool(connectionString);

try {
  await migrate(pool);
  const app = await buildApp({
    pool,
    logger: true,
    allowedProjectRoots: parseAllowedRoots(process.env.AI_SDLC_ALLOWED_PROJECT_ROOTS),
    codexBinary: process.env.AI_SDLC_CODEX_BIN,
    fakeCodex: parseFakeCodex(process.env.AI_SDLC_CODEX_FAKE),
    codexTimeoutMs: parsePositiveNumber(process.env.AI_SDLC_CODEX_TIMEOUT_MS),
    codexAllowedModels: parseCommaSeparated(process.env.AI_SDLC_CODEX_MODELS),
    codexAllowedReasoningEfforts: parseCommaSeparated(process.env.AI_SDLC_CODEX_REASONING_EFFORTS)
      ?.map((value) => codexReasoningEffortSchema.parse(value)),
    codexDefaultModel: process.env.AI_SDLC_CODEX_DEFAULT_MODEL?.trim() || undefined,
    codexDefaultReasoningEffort: process.env.AI_SDLC_CODEX_DEFAULT_REASONING_EFFORT
      ? codexReasoningEffortSchema.parse(process.env.AI_SDLC_CODEX_DEFAULT_REASONING_EFFORT)
      : undefined,
    codexHome: process.env.CODEX_HOME,
    cliPath: process.env.AI_SDLC_CLI_PATH
      ? path.resolve(process.cwd(), process.env.AI_SDLC_CLI_PATH)
      : undefined
  });
  app.addHook("onClose", async () => pool.end());
  await app.listen({
    host: process.env.HOST ?? "127.0.0.1",
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

function parsePositiveNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
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
