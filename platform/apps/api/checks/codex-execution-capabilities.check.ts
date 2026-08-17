import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type pg from "pg";

import { buildApp } from "../src/app.ts";
import { AppError } from "../src/domain/errors.ts";
import {
  CodexExecutionCapabilities,
  readEffectiveCodexConfig,
  readInstalledCodexModels
} from "../src/services/codex-execution-capabilities.ts";

const roots: string[] = [];
test.after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

async function fixture(): Promise<{ codexHome: string; projectRoot: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-codex-capabilities-"));
  roots.push(root);
  const codexHome = path.join(root, "codex-home");
  const projectRoot = path.join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  return { codexHome: await realpath(codexHome), projectRoot: await realpath(projectRoot) };
}

const catalog = [
  {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    defaultReasoningEffort: "low" as const,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] as const
  },
  {
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    defaultReasoningEffort: "medium" as const,
    reasoningEfforts: ["low", "medium", "high"] as const
  }
];

const appServerModels = [
  ...catalog.map((model) => ({
    id: model.id,
    model: model.id,
    displayName: model.name,
    hidden: false,
    defaultReasoningEffort: model.defaultReasoningEffort,
    supportedReasoningEfforts: model.reasoningEfforts.map((reasoningEffort) => ({
      reasoningEffort,
      description: `${reasoningEffort} reasoning`
    }))
  })),
  {
    id: "codex-auto-review",
    model: "codex-auto-review",
    displayName: "Internal auto review",
    hidden: true,
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: [{ reasoningEffort: "high", description: "internal" }]
  }
];

async function writeCodexStub(
  projectRoot: string,
  config: { model: string | null; model_reasoning_effort: string | null },
  fileName = `codex-stub-${crypto.randomUUID()}.mjs`
): Promise<{ binary: string; requestLog: string }> {
  const binary = path.join(projectRoot, fileName);
  const requestLog = path.join(projectRoot, `${fileName}.request.json`);
  await writeFile(binary, [
    "#!/usr/bin/env node",
    'import { writeFileSync } from "node:fs";',
    'import readline from "node:readline";',
    "const messages = [];",
    "const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
    "for await (const line of lines) {",
    "  if (!line.trim()) continue;",
    "  const message = JSON.parse(line);",
    "  messages.push(message);",
    `  writeFileSync(${JSON.stringify(requestLog)}, JSON.stringify({ cwd: process.cwd(), home: process.env.HOME ?? null, codexHome: process.env.CODEX_HOME ?? null, messages }), "utf8");`,
    '  if (message.method === "initialize") {',
    '    process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: "stub" } }) + "\\n");',
    "  }",
    '  if (message.method === "config/read") {',
    `    process.stdout.write(JSON.stringify({ id: message.id, result: { config: { ...${JSON.stringify(config)}, mcp_servers: { private: { token: "must-not-escape" } } }, origins: {} } }) + "\\n");`,
    "  }",
    '  if (message.method === "model/list") {',
    `    process.stdout.write(JSON.stringify({ id: message.id, result: { data: ${JSON.stringify(appServerModels)}, nextCursor: null } }) + "\\n");`,
    "  }",
    "}",
    ""
  ].join("\n"), "utf8");
  await chmod(binary, 0o755);
  return { binary, requestLog };
}

async function writeStandaloneStub(projectRoot: string, source: readonly string[]): Promise<string> {
  const binary = path.join(projectRoot, `codex-probe-${crypto.randomUUID()}.mjs`);
  await writeFile(binary, ["#!/usr/bin/env node", ...source, ""].join("\n"), "utf8");
  await chmod(binary, 0o755);
  return binary;
}

test("reads only sanitized run-scoped effective fields through app-server config/read", async () => {
  const { codexHome, projectRoot } = await fixture();
  const { binary, requestLog } = await writeCodexStub(projectRoot, {
    model: "gpt-5.6-sol",
    model_reasoning_effort: "ultra"
  });
  const effective = await readEffectiveCodexConfig(projectRoot, {
    binary,
    environment: { PATH: process.env.PATH, HOME: "/safe/home", CODEX_HOME: codexHome },
    timeoutMs: 10_000
  });
  assert.deepEqual(effective, { model: "gpt-5.6-sol", reasoningEffort: "ultra" });
  assert.doesNotMatch(JSON.stringify(effective), /must-not-escape/u);

  const request = JSON.parse(await readFile(requestLog, "utf8")) as {
    cwd: string;
    home: string;
    codexHome: string;
    messages: Array<{ method: string; params?: { cwd?: string; includeLayers?: boolean } }>;
  };
  assert.equal(request.cwd, projectRoot);
  assert.equal(request.home, "/safe/home");
  assert.equal(request.codexHome, codexHome);
  assert.deepEqual(request.messages.map((message) => message.method), [
    "initialize", "initialized", "config/read"
  ]);
  assert.deepEqual(request.messages[2]?.params, { cwd: projectRoot, includeLayers: false });

  const service = new CodexExecutionCapabilities({
    binary,
    codexHome,
    catalog,
    timeoutMs: 10_000
  });
  assert.deepEqual(await service.resolve(projectRoot, {}), {
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra"
  });
});

test("reads the picker catalog through model/list and never exposes hidden internal models", async () => {
  const { codexHome, projectRoot } = await fixture();
  const { binary, requestLog } = await writeCodexStub(projectRoot, {
    model: "gpt-5.6-sol",
    model_reasoning_effort: "ultra"
  });
  assert.deepEqual(await readInstalledCodexModels(projectRoot, {
    binary,
    environment: { PATH: process.env.PATH, HOME: "/safe/home", CODEX_HOME: codexHome },
    timeoutMs: 10_000
  }), catalog);

  const request = JSON.parse(await readFile(requestLog, "utf8")) as {
    messages: Array<{ method: string; params?: unknown }>;
  };
  assert.deepEqual(request.messages.map((message) => message.method), [
    "initialize", "initialized", "model/list"
  ]);
  assert.deepEqual(request.messages[2]?.params, {
    cursor: null,
    limit: 100,
    includeHidden: false
  });
});

test("app-server config probe enforces timeout and output limits", async () => {
  const { projectRoot } = await fixture();
  const hangingBinary = await writeStandaloneStub(projectRoot, [
    "process.stdin.resume();",
    "setInterval(() => undefined, 1_000);"
  ]);
  await assert.rejects(
    () => readEffectiveCodexConfig(projectRoot, { binary: hangingBinary, timeoutMs: 200 }),
    (error: unknown) => error instanceof AppError && error.code === "CODEX_CONFIG_READ_TIMEOUT"
  );

  const noisyBinary = await writeStandaloneStub(projectRoot, [
    'process.stdout.write("x".repeat(1_024));',
    "process.stdin.resume();"
  ]);
  await assert.rejects(
    () => readEffectiveCodexConfig(projectRoot, {
      binary: noisyBinary,
      timeoutMs: 10_000,
      maxOutputBytes: 64
    }),
    (error: unknown) => error instanceof AppError && error.code === "CODEX_CONFIG_READ_OUTPUT_LIMIT"
  );
});

test("model and reasoning selections must be an installed catalog combination", async () => {
  const { projectRoot } = await fixture();
  const service = new CodexExecutionCapabilities({
    catalog,
    defaultModel: "gpt-5.6-sol",
    defaultReasoningEffort: "high",
    allowedModels: ["gpt-5.6-sol", "gpt-5.6-terra"]
  });
  assert.deepEqual(
    await service.resolve(projectRoot, { model: "gpt-5.6-terra" }),
    { model: "gpt-5.6-terra", reasoningEffort: "medium" }
  );
  await assert.rejects(
    () => service.resolve(projectRoot, { model: "gpt-unknown" }),
    (error: unknown) => error instanceof AppError && error.code === "CODEX_MODEL_NOT_ALLOWED"
  );
  await assert.rejects(
    () => service.resolve(projectRoot, { model: "gpt-5.6-terra", reasoningEffort: "ultra" }),
    (error: unknown) => error instanceof AppError && error.code === "CODEX_REASONING_EFFORT_NOT_ALLOWED"
  );
});

test("a server model override uses that model's default effort unless effort is also overridden", async () => {
  const { codexHome, projectRoot } = await fixture();
  const { binary } = await writeCodexStub(projectRoot, {
    model: "gpt-5.6-sol",
    model_reasoning_effort: "ultra"
  });
  const service = new CodexExecutionCapabilities({
    binary,
    codexHome,
    catalog,
    defaultModel: "gpt-5.6-terra",
    timeoutMs: 10_000
  });
  const status = await service.status(projectRoot);
  assert.equal(status.defaultModel, "gpt-5.6-terra");
  assert.equal(status.defaultReasoningEffort, "medium");
});

test("server allowlists intersect the installed catalog and validate configured defaults", async () => {
  const { projectRoot } = await fixture();
  const service = new CodexExecutionCapabilities({
    catalog,
    allowedModels: ["gpt-5.6-sol"],
    allowedReasoningEfforts: ["low", "high"],
    defaultModel: "gpt-5.6-sol",
    defaultReasoningEffort: "high"
  });
  const status = await service.status(projectRoot);
  assert.deepEqual(status.models, [{
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    defaultReasoningEffort: "low",
    reasoningEfforts: ["low", "high"]
  }]);
  assert.equal(status.defaultReasoningEffort, "high");

  const narrowed = new CodexExecutionCapabilities({
    catalog,
    allowedModels: ["gpt-5.6-sol"],
    allowedReasoningEfforts: ["high"],
    defaultModel: "gpt-5.6-sol",
    defaultReasoningEffort: "high"
  });
  assert.deepEqual((await narrowed.status(projectRoot)).models, [{
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    defaultReasoningEffort: "high",
    reasoningEfforts: ["high"]
  }]);
  assert.throws(
    () => new CodexExecutionCapabilities({
      allowedModels: ["gpt-5.6-sol"],
      defaultModel: "gpt-other"
    }),
    /必须包含/u
  );
});

test("unresolvable or unsupported effective defaults fail explicitly", async () => {
  const { codexHome, projectRoot } = await fixture();
  const missingStub = await writeCodexStub(projectRoot, {
    model: null,
    model_reasoning_effort: null
  });
  const missing = new CodexExecutionCapabilities({
    binary: missingStub.binary,
    codexHome,
    catalog,
    timeoutMs: 10_000
  });
  await assert.rejects(
    () => missing.status(projectRoot),
    (error: unknown) => error instanceof AppError && error.code === "CODEX_DEFAULT_MODEL_UNAVAILABLE"
  );

  const unsupportedStub = await writeCodexStub(projectRoot, {
    model: "gpt-5.6-terra",
    model_reasoning_effort: "ultra"
  });
  const unsupported = new CodexExecutionCapabilities({
    binary: unsupportedStub.binary,
    codexHome,
    catalog,
    timeoutMs: 10_000
  });
  await assert.rejects(
    () => unsupported.status(projectRoot),
    (error: unknown) => error instanceof AppError
      && error.code === "CODEX_DEFAULT_REASONING_EFFORT_NOT_ALLOWED"
  );
});

test("serves installed run-scoped Codex capabilities from the API", async () => {
  const { codexHome, projectRoot } = await fixture();
  const { binary } = await writeCodexStub(projectRoot, {
    model: "gpt-5.6-sol",
    model_reasoning_effort: "ultra"
  });
  const runId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const now = new Date();
  const pool = {
    async query(sql: string) {
      if (sql.includes("FROM workflow_runs wr")) {
        return { rows: [{
          id: runId,
          project_id: projectId,
          title: "Capability run",
          objective: "Read the current Codex selection",
          status: "active",
          created_at: now,
          updated_at: now,
          p_id: projectId,
          p_name: "Demo",
          p_summary: "Demo",
          p_root_path: projectRoot,
          p_config_path: path.join(projectRoot, "ai-native.yaml"),
          p_created_at: now,
          p_updated_at: now
        }] };
      }
      if (sql.includes("FROM phase_runs")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    }
  } as unknown as pg.Pool;
  const app = await buildApp({
    pool,
    allowedProjectRoots: [projectRoot],
    codexBinary: binary,
    codexHome
  });
  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/runs/${runId}/codex/capabilities`
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      models: catalog,
      defaultModel: "gpt-5.6-sol",
      defaultReasoningEffort: "ultra"
    });
  } finally {
    await app.close();
  }
});
