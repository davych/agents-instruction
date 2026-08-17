import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  figmaIntegrationStatusSchema,
  figmaPlanCapabilitiesSchema,
} from "@ai-sdlc/contracts";
import type pg from "pg";

import { buildApp } from "../src/app.ts";
import { FigmaMcpIntegration } from "../src/services/figma-mcp-integration.ts";

const roots: string[] = [];
test.after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

test("checks MCP and Desktop connectors in the same sanitized Codex context", async () => {
  const root = await temporaryRoot();
  const capturePath = path.join(root, "capture.json");
  const binary = await createStub(root, "unconfigured", { stdout: "[]", capturePath });
  const integration = new FigmaMcpIntegration({
    binary,
    environment: {
      PATH: process.env.PATH,
      HOME: "/safe/home",
      CODEX_HOME: "/safe/codex-home",
      SECRET_THAT_MUST_NOT_PASS: "do-not-expose",
    },
  });

  const status = figmaIntegrationStatusSchema.parse(await integration.status(root));
  assert.deepEqual(status, {
    provider: "figma",
    state: "not_configured",
    serverName: null,
    message: "Codex 中尚未配置官方 Figma MCP，也未检测到可用的 Figma App connector。",
    authorizationUrl:
      "https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/#codex",
  });
  assert.deepEqual(JSON.parse(await readFile(`${capturePath}.mcp.json`, "utf8")), {
    args: ["mcp", "list", "--json"],
    home: "/safe/home",
    codexHome: "/safe/codex-home",
    cwd: await realpath(root),
    leakedSecret: null,
    requests: [],
  });
  const appCapture = JSON.parse(await readFile(`${capturePath}.app.json`, "utf8")) as {
    args: string[];
    home: string;
    codexHome: string;
    cwd: string;
    leakedSecret: string | null;
    requests: Array<Record<string, unknown>>;
  };
  assert.deepEqual(
    {
      args: appCapture.args,
      home: appCapture.home,
      codexHome: appCapture.codexHome,
      cwd: appCapture.cwd,
      leakedSecret: appCapture.leakedSecret,
    },
    {
      args: ["app-server", "--stdio"],
      home: "/safe/home",
      codexHome: "/safe/codex-home",
      cwd: await realpath(root),
      leakedSecret: null,
    },
  );
  assert.deepEqual(appCapture.requests, [
    {
      id: 1,
      method: "initialize",
      optOutNotificationMethods: ["app/list/updated"],
      experimentalApi: true,
      forceRefetch: null,
      limit: null,
      cursor: null,
    },
    {
      id: null,
      method: "initialized",
      optOutNotificationMethods: null,
      experimentalApi: null,
      forceRefetch: null,
      limit: null,
      cursor: null,
    },
    {
      id: 2,
      method: "app/list",
      optOutNotificationMethods: null,
      experimentalApi: null,
      forceRefetch: false,
      limit: 3,
      cursor: null,
    },
  ]);

  await integration.status(root, { force: true });
  const forcedAppCapture = JSON.parse(await readFile(`${capturePath}.app.json`, "utf8")) as {
    requests: Array<{ method: string; forceRefetch: boolean | null }>;
  };
  assert.equal(
    forcedAppCapture.requests.find((request) => request.method === "app/list")?.forceRefetch,
    true,
  );
});

test("recognizes an authorized Codex Desktop Figma App connector", async () => {
  const root = await temporaryRoot();
  const binary = await createStub(root, "desktop-ready", {
    stdout: "[]",
    appEntries: [figmaApp({ isAccessible: true, isEnabled: true })],
  });

  const status = figmaIntegrationStatusSchema.parse(
    await new FigmaMcpIntegration({ binary }).status(root),
  );

  assert.equal(status.state, "ready");
  assert.equal(status.serverName, "figma");
  assert.equal(status.authorizationUrl, null);
  assert.match(status.message, /Desktop.*connector/u);
});

test("paginates Desktop Apps until it finds the official Figma connector", async () => {
  const root = await temporaryRoot();
  const capturePath = path.join(root, "paginated-capture");
  const binary = await createStub(root, "desktop-ready-paginated", {
    stdout: "[]",
    capturePath,
    appPages: [
      [{ id: "connector_other_1", name: "Other" }],
      [{ id: "connector_other_2", name: "Other 2" }],
      [figmaApp({ isAccessible: true, isEnabled: true })],
    ],
  });

  const status = figmaIntegrationStatusSchema.parse(
    await new FigmaMcpIntegration({ binary }).status(root),
  );

  assert.equal(status.state, "ready");
  const capture = JSON.parse(await readFile(`${capturePath}.app.json`, "utf8")) as {
    requests: Array<{ method: string; cursor: string | null; limit: number | null }>;
  };
  assert.deepEqual(
    capture.requests.filter((request) => request.method === "app/list"),
    [
      { id: 2, method: "app/list", optOutNotificationMethods: null, experimentalApi: null, forceRefetch: false, limit: 3, cursor: null },
      { id: 3, method: "app/list", optOutNotificationMethods: null, experimentalApi: null, forceRefetch: false, limit: 3, cursor: "cursor-1" },
      { id: 4, method: "app/list", optOutNotificationMethods: null, experimentalApi: null, forceRefetch: false, limit: 3, cursor: "cursor-2" },
    ],
  );
});

test("maps Desktop Figma connector accessibility and enabled state", async (context) => {
  const cases = [
    {
      name: "authorization required",
      app: figmaApp({ isAccessible: false, isEnabled: true }),
      expectedState: "authorization_required",
    },
    {
      name: "disabled",
      app: figmaApp({ isAccessible: true, isEnabled: false }),
      expectedState: "unavailable",
    },
  ] as const;

  for (const item of cases) {
    await context.test(item.name, async () => {
      const root = await temporaryRoot();
      const binary = await createStub(root, item.name.replaceAll(" ", "-"), {
        stdout: "[]",
        appEntries: [item.app],
      });
      const status = figmaIntegrationStatusSchema.parse(
        await new FigmaMcpIntegration({ binary }).status(root),
      );
      assert.equal(status.state, item.expectedState);
      assert.equal(status.serverName, "figma");
      assert.match(status.message, /Desktop.*connector/u);
    });
  }
});

test("requires both the official connector id and Figma display identity", async (context) => {
  const cases = [
    {
      name: "wrong connector id",
      app: { ...figmaApp({ isAccessible: true, isEnabled: true }), id: "connector_fake" },
      expectedState: "not_configured",
    },
    {
      name: "wrong display identity",
      app: {
        ...figmaApp({ isAccessible: true, isEnabled: true }),
        name: "Not Figma",
        pluginDisplayNames: ["Not Figma"],
      },
      expectedState: "unavailable",
    },
  ] as const;

  for (const item of cases) {
    await context.test(item.name, async () => {
      const root = await temporaryRoot();
      const binary = await createStub(root, item.name.replaceAll(" ", "-"), {
        stdout: "[]",
        appEntries: [item.app],
      });
      const status = figmaIntegrationStatusSchema.parse(
        await new FigmaMcpIntegration({ binary }).status(root),
      );
      assert.equal(status.state, item.expectedState);
    });
  }
});

test("serves the normalized readiness contract from the integration route", async () => {
  const root = await temporaryRoot();
  const binary = await createStub(root, "route-ready", {
    stdout: JSON.stringify([
      {
        name: "figma",
        enabled: true,
        transport: { type: "streamable_http", url: "https://mcp.figma.com/mcp" },
        auth_status: "o_auth",
      },
    ]),
  });
  const app = await buildApp({ pool: {} as pg.Pool, codexBinary: binary });
  try {
    const response = await app.inject({ method: "GET", url: "/api/integrations/figma" });
    assert.equal(response.statusCode, 200);
    const status = figmaIntegrationStatusSchema.parse(response.json());
    assert.equal(status.state, "ready");
    assert.equal(status.serverName, "figma");
  } finally {
    await app.close();
  }
});

test("run-scoped force detection bypasses the readiness cache", async () => {
  const root = await temporaryRoot();
  const projectRoot = await realpath(root);
  const statusPath = path.join(projectRoot, "mcp-status.json");
  await writeFile(statusPath, "[]", "utf8");
  const binary = await createStub(root, "force-route", { stdoutPath: statusPath });
  const runId = randomUUID();
  const projectId = randomUUID();
  const now = new Date();
  const pool = {
    async query(sql: string) {
      if (sql.includes("FROM workflow_runs wr")) {
        return { rows: [{
          id: runId,
          project_id: projectId,
          title: "Figma readiness run",
          objective: "Refresh Figma readiness",
          status: "active",
          created_at: now,
          updated_at: now,
          p_id: projectId,
          p_name: "Figma demo",
          p_summary: "Figma demo",
          p_root_path: projectRoot,
          p_config_path: path.join(projectRoot, "ai-native.yaml"),
          p_created_at: now,
          p_updated_at: now,
        }] };
      }
      if (sql.includes("FROM phase_runs")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as pg.Pool;
  const app = await buildApp({
    pool,
    allowedProjectRoots: [projectRoot],
    codexBinary: binary,
  });

  const readStatus = async (suffix = "") => {
    const response = await app.inject({
      method: "GET",
      url: `/api/runs/${runId}/integrations/figma${suffix}`,
    });
    assert.equal(response.statusCode, 200);
    return figmaIntegrationStatusSchema.parse(response.json());
  };

  try {
    assert.equal((await readStatus()).state, "not_configured");
    await writeFile(statusPath, JSON.stringify([
      {
        name: "figma",
        enabled: true,
        transport: { type: "streamable_http", url: "https://mcp.figma.com/mcp" },
        auth_status: "o_auth",
      },
    ]), "utf8");

    assert.equal((await readStatus()).state, "not_configured");
    assert.equal((await readStatus("?force=true")).state, "ready");
    assert.equal((await readStatus()).state, "ready");

    const invalid = await app.inject({
      method: "GET",
      url: `/api/runs/${runId}/integrations/figma?force=1`,
    });
    assert.equal(invalid.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("maps Codex MCP OAuth states to a safe Figma readiness contract", async (context) => {
  const cases = [
    {
      name: "authorized",
      authStatus: "o_auth",
      expectedState: "ready",
      expectedAuthorizationUrl: null,
    },
    {
      name: "not logged in",
      authStatus: "not_logged_in",
      expectedState: "authorization_required",
      expectedAuthorizationUrl:
        "https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/#codex",
    },
    {
      name: "unsupported auth discovery",
      authStatus: "unsupported",
      expectedState: "unavailable",
      expectedAuthorizationUrl:
        "https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/#codex",
    },
  ] as const;

  for (const item of cases) {
    await context.test(item.name, async () => {
      const root = await temporaryRoot();
      const stdout = JSON.stringify([
        {
          name: "figma",
          enabled: true,
          transport: { type: "streamable_http", url: "https://mcp.figma.com/mcp" },
          auth_status: item.authStatus,
        },
      ]);
      const binary = await createStub(root, item.name.replaceAll(" ", "-"), { stdout });
      const status = figmaIntegrationStatusSchema.parse(
        await new FigmaMcpIntegration({ binary }).status(),
      );
      assert.equal(status.state, item.expectedState);
      assert.equal(status.serverName, "figma");
      assert.equal(status.authorizationUrl, item.expectedAuthorizationUrl);
    });
  }
});

test("requires the enabled official Figma MCP server before reporting ready", async (context) => {
  const cases = [
    {
      name: "wrong URL",
      server: {
        name: "figma",
        enabled: true,
        transport: { type: "streamable_http", url: "https://example.com/mcp" },
        auth_status: "o_auth",
      },
    },
    {
      name: "disabled",
      server: {
        name: "figma",
        enabled: false,
        transport: { type: "streamable_http", url: "https://mcp.figma.com/mcp" },
        auth_status: "o_auth",
      },
    },
    {
      name: "wrong transport",
      server: {
        name: "figma",
        enabled: true,
        transport: { type: "stdio" },
        auth_status: "o_auth",
      },
    },
  ] as const;

  for (const item of cases) {
    await context.test(item.name, async () => {
      const root = await temporaryRoot();
      const binary = await createStub(root, item.name.replaceAll(" ", "-"), {
        stdout: JSON.stringify([item.server]),
      });
      const status = figmaIntegrationStatusSchema.parse(
        await new FigmaMcpIntegration({ binary }).status(),
      );
      assert.equal(status.state, "unavailable");
      assert.equal(status.serverName, "figma");
    });
  }
});

test("bounds command time and output and never exposes raw MCP data", async (context) => {
  const secret = "super-secret-token-value";
  const cases = [
    {
      name: "secret-bearing malformed response",
      stub: { stdout: `{not-json:${secret}}` },
      options: {},
    },
    {
      name: "nonzero command",
      stub: { stdout: secret, exitCode: 9 },
      options: {},
    },
    {
      name: "oversized response",
      stub: { stdout: JSON.stringify([{ padding: secret.repeat(200) }]) },
      options: { maxOutputBytes: 128 },
    },
    {
      name: "timed out command",
      stub: { stdout: "[]", delayMs: 500 },
      options: { timeoutMs: 30 },
    },
  ] as const;

  for (const item of cases) {
    await context.test(item.name, async () => {
      const root = await temporaryRoot();
      const binary = await createStub(root, item.name.replaceAll(" ", "-"), item.stub);
      const status = figmaIntegrationStatusSchema.parse(
        await new FigmaMcpIntegration({ binary, ...item.options }).status(),
      );
      assert.equal(status.state, "unavailable");
      assert.doesNotMatch(JSON.stringify(status), new RegExp(secret, "u"));
    });
  }
});

test("bounds Desktop connector output and never exposes signed or secret App data", async () => {
  const root = await temporaryRoot();
  const secret = "signed-url-secret-that-must-never-leak";
  const binary = await createStub(root, "app-oversized", {
    stdout: "[]",
    appRawOutput: secret.repeat(100),
  });

  const status = figmaIntegrationStatusSchema.parse(
    await new FigmaMcpIntegration({ binary, maxOutputBytes: 256 }).status(root),
  );

  assert.equal(status.state, "unavailable");
  assert.doesNotMatch(JSON.stringify(status), new RegExp(secret, "u"));
});

test("keeps a verified legacy MCP ready result when the App probe is unavailable", async () => {
  const root = await temporaryRoot();
  const binary = await createStub(root, "mcp-ready-app-timeout", {
    stdout: JSON.stringify([
      {
        name: "figma",
        enabled: true,
        transport: { type: "streamable_http", url: "https://mcp.figma.com/mcp" },
        auth_status: "o_auth",
      },
    ]),
    appHang: true,
  });

  const status = figmaIntegrationStatusSchema.parse(
    await new FigmaMcpIntegration({ binary, appTimeoutMs: 30 }).status(root),
  );

  assert.equal(status.state, "ready");
  assert.match(status.message, /CLI/u);
});

test("reads multiple Figma plans through an ephemeral read-only app-server thread", async () => {
  const root = await temporaryRoot();
  const capturePath = path.join(root, "plan-capture");
  const secretEmail = "secret-user@example.test";
  const binary = await createStub(root, "plans", {
    capturePath,
    whoami: {
      handle: "private handle",
      email: secretEmail,
      plans: [
        { key: "team::100", name: "Personal", seat: "Full", tier: "starter" },
        { key: "organization::200", name: "Company", seat: "Dev", tier: "professional" },
        { key: "team::300", name: "View only", seat: "View", tier: "starter" },
      ],
    },
  });

  const capabilities = figmaPlanCapabilitiesSchema.parse(
    await new FigmaMcpIntegration({ binary }).plans(root),
  );

  assert.deepEqual(capabilities, {
    provider: "figma",
    plans: [
      { key: "team::100", name: "Personal", seat: "Full", tier: "starter", writable: true },
      { key: "organization::200", name: "Company", seat: "Dev", tier: "professional", writable: true },
      { key: "team::300", name: "View only", seat: "View", tier: "starter", writable: false },
    ],
  });
  assert.doesNotMatch(JSON.stringify(capabilities), new RegExp(secretEmail, "u"));
  assert.doesNotMatch(JSON.stringify(capabilities), /private handle/u);

  const capture = JSON.parse(await readFile(`${capturePath}.app.json`, "utf8")) as {
    requests: Array<Record<string, unknown>>;
  };
  assert.deepEqual(capture.requests, [
    {
      id: 1,
      method: "initialize",
      optOutNotificationMethods: ["app/list/updated"],
      experimentalApi: true,
      forceRefetch: null,
      limit: null,
      cursor: null,
    },
    {
      id: null,
      method: "initialized",
      optOutNotificationMethods: null,
      experimentalApi: null,
      forceRefetch: null,
      limit: null,
      cursor: null,
    },
    {
      id: 2,
      method: "thread/start",
      optOutNotificationMethods: null,
      experimentalApi: null,
      forceRefetch: null,
      limit: null,
      cursor: null,
      cwd: root,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
    },
    {
      id: 3,
      method: "mcpServer/tool/call",
      optOutNotificationMethods: null,
      experimentalApi: null,
      forceRefetch: null,
      limit: null,
      cursor: null,
      threadId: "ephemeral-thread",
      server: "codex_apps",
      tool: "figma.whoami",
      arguments: {},
    },
  ]);
});

test("serializes concurrent readiness and plan probes in the same Codex context", async () => {
  const root = await temporaryRoot();
  const binary = await createStub(root, "serialized-probes", {
    stdout: "[]",
    appEntries: [figmaApp({ isAccessible: true, isEnabled: true })],
    whoami: {
      plans: [{ key: "team::100", name: "Personal", seat: "Full", tier: "starter" }],
    },
    appLockPath: path.join(root, "app-server.lock"),
  });
  const integration = new FigmaMcpIntegration({ binary, cacheTtlMs: 0 });

  const [status, capabilities] = await Promise.all([
    integration.status(root, { force: true }),
    integration.plans(root, { force: true }),
  ]);

  assert.equal(status.state, "ready");
  assert.deepEqual(capabilities.plans, [
    { key: "team::100", name: "Personal", seat: "Full", tier: "starter", writable: true },
  ]);
});

test("serves only sanitized Figma plan capabilities from the run-scoped route", async () => {
  const root = await temporaryRoot();
  const projectRoot = await realpath(root);
  const secretEmail = "route-secret@example.test";
  const binary = await createStub(root, "plan-route", {
    stdout: JSON.stringify([{
      name: "figma",
      enabled: true,
      transport: { type: "streamable_http", url: "https://mcp.figma.com/mcp" },
      auth_status: "o_auth",
    }]),
    appEntries: [figmaApp({ isAccessible: true, isEnabled: true })],
    whoami: {
      email: secretEmail,
      plans: [
        { key: "team::100", name: "Personal", seat: "Full", tier: "starter" },
        { key: "team::200", name: "Readonly", seat: "View", tier: "starter" },
      ],
    },
  });
  const runId = randomUUID();
  const projectId = randomUUID();
  const now = new Date();
  const pool = {
    async query(sql: string) {
      if (sql.includes("FROM workflow_runs wr")) {
        return { rows: [{
          id: runId,
          project_id: projectId,
          title: "Figma plan run",
          objective: "Choose a Figma plan",
          status: "active",
          created_at: now,
          updated_at: now,
          p_id: projectId,
          p_name: "Figma demo",
          p_summary: "Figma demo",
          p_root_path: projectRoot,
          p_config_path: path.join(projectRoot, "ai-native.yaml"),
          p_created_at: now,
          p_updated_at: now,
        }] };
      }
      if (sql.includes("FROM phase_runs")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as pg.Pool;
  const app = await buildApp({
    pool,
    allowedProjectRoots: [projectRoot],
    codexBinary: binary,
  });

  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/runs/${runId}/integrations/figma/plans?force=true`,
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(figmaPlanCapabilitiesSchema.parse(response.json()), {
      provider: "figma",
      plans: [
        { key: "team::100", name: "Personal", seat: "Full", tier: "starter", writable: true },
        { key: "team::200", name: "Readonly", seat: "View", tier: "starter", writable: false },
      ],
    });
    assert.doesNotMatch(response.body, new RegExp(secretEmail, "u"));
  } finally {
    await app.close();
  }
});

test("bounds Figma whoami output without exposing connector secrets", async () => {
  const root = await temporaryRoot();
  const secret = "whoami-secret-that-must-not-leak";
  const binary = await createStub(root, "plans-oversized", {
    whoamiRawOutput: `${JSON.stringify({
      id: 3,
      result: { content: [{ type: "text", text: secret.repeat(100) }], isError: false },
    })}\n`,
  });
  const integration = new FigmaMcpIntegration({
    binary,
    appMaxOutputBytes: 256,
    appMaxLineBytes: 128,
  });

  let caught: unknown;
  try {
    await integration.plans(root);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.doesNotMatch(String(caught), new RegExp(secret, "u"));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-figma-mcp-"));
  roots.push(root);
  return root;
}

async function createStub(
  root: string,
  name: string,
  options: {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    delayMs?: number;
    capturePath?: string;
    stdoutPath?: string;
    appEntries?: unknown[];
    appPages?: unknown[][];
    appRawOutput?: string;
    appResponseError?: boolean;
    appHang?: boolean;
    whoami?: unknown;
    whoamiRawOutput?: string;
    appLockPath?: string;
  },
): Promise<string> {
  const target = path.join(root, `${name}.mjs`);
  const appPages = options.appPages ?? [options.appEntries ?? []];
  await writeFile(
    target,
    [
      "#!/usr/bin/env node",
      'import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";',
      `const captureBase = ${JSON.stringify(options.capturePath ?? null)};`,
      `const stdoutPath = ${JSON.stringify(options.stdoutPath ?? null)};`,
      `const appPages = ${JSON.stringify(appPages)};`,
      `const whoami = ${JSON.stringify(options.whoami ?? null)};`,
      `const appLockPath = ${JSON.stringify(options.appLockPath ?? null)};`,
      'const mode = process.argv[2] === "app-server" ? "app" : "mcp";',
      "let appLockFd = null;",
      "if (mode === 'app' && appLockPath) {",
      "  try { appLockFd = openSync(appLockPath, 'wx'); } catch { process.exit(73); }",
      "  process.on('exit', () => {",
      "    if (appLockFd !== null) closeSync(appLockFd);",
      "    try { unlinkSync(appLockPath); } catch {}",
      "  });",
      "}",
      "const requests = [];",
      "const capture = () => {",
      "  if (!captureBase) return;",
      "  writeFileSync(`${captureBase}.${mode}.json`, JSON.stringify({",
      "    args: process.argv.slice(2),",
      "    home: process.env.HOME ?? null,",
      "    codexHome: process.env.CODEX_HOME ?? null,",
      "    cwd: process.cwd(),",
      "    leakedSecret: process.env.SECRET_THAT_MUST_NOT_PASS ?? null,",
      "    requests,",
      '  }), "utf8");',
      "};",
      'if (mode === "mcp") {',
      "  capture();",
      "  const emit = () => {",
      ...(options.stderr ? [`    process.stderr.write(${JSON.stringify(options.stderr)});`] : []),
      `    const stdout = stdoutPath ? readFileSync(stdoutPath, "utf8") : ${JSON.stringify(options.stdout ?? "[]")};`,
      `    process.stdout.write(stdout, () => process.exit(${options.exitCode ?? 0}));`,
      "  };",
      `  setTimeout(emit, ${options.delayMs ?? 0});`,
      "} else {",
      '  process.stdin.setEncoding("utf8");',
      '  let buffer = "";',
      "  let appPageIndex = 0;",
      '  process.stdin.on("data", (chunk) => {',
      "    buffer += chunk;",
      "    for (;;) {",
      '      const newline = buffer.indexOf("\\n");',
      "      if (newline < 0) break;",
      "      const line = buffer.slice(0, newline);",
      "      buffer = buffer.slice(newline + 1);",
      "      if (!line.trim()) continue;",
      "      const request = JSON.parse(line);",
      "      requests.push({",
      "        id: request.id ?? null,",
      "        method: request.method ?? null,",
      "        optOutNotificationMethods:",
      "          request.params?.capabilities?.optOutNotificationMethods ?? null,",
      "        experimentalApi: request.params?.capabilities?.experimentalApi ?? null,",
      "        forceRefetch: request.params?.forceRefetch ?? null,",
      "        limit: request.params?.limit ?? null,",
      "        cursor: request.params?.cursor ?? null,",
      "        ...(request.method === 'thread/start' ? {",
      "          cwd: request.params?.cwd ?? null,",
      "          approvalPolicy: request.params?.approvalPolicy ?? null,",
      "          sandbox: request.params?.sandbox ?? null,",
      "          ephemeral: request.params?.ephemeral ?? null,",
      "        } : {}),",
      "        ...(request.method === 'mcpServer/tool/call' ? {",
      "          threadId: request.params?.threadId ?? null,",
      "          server: request.params?.server ?? null,",
      "          tool: request.params?.tool ?? null,",
      "          arguments: request.params?.arguments ?? null,",
      "        } : {}),",
      "      });",
      "      capture();",
      `      if (${options.appHang === true ? "true" : "false"}) continue;`,
      '      if (request.method === "initialize") {',
      '        process.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\\n`);',
      '      } else if (request.method === "app/list") {',
      ...(options.appRawOutput
        ? [`        process.stdout.write(${JSON.stringify(options.appRawOutput)});`]
        : []),
      ...(options.appResponseError
        ? [
            '        process.stdout.write(`${JSON.stringify({ id: 2, error: { message: "secret error" } })}\\n`);',
          ]
        : [
            "        const data = appPages[appPageIndex] ?? [];",
            '        const nextCursor = appPageIndex + 1 < appPages.length ? `cursor-${appPageIndex + 1}` : null;',
            "        appPageIndex += 1;",
            '        process.stdout.write(`${JSON.stringify({ id: request.id, result: { data, nextCursor } })}\\n`);',
          ]),
      '      } else if (request.method === "thread/start") {',
      '        process.stdout.write(`${JSON.stringify({ id: request.id, result: { thread: { id: "ephemeral-thread", ephemeral: true } } })}\n`);',
      '      } else if (request.method === "mcpServer/tool/call") {',
      ...(options.whoamiRawOutput
        ? [`        process.stdout.write(${JSON.stringify(options.whoamiRawOutput)});`]
        : [
            "        const result = whoami === null",
            '          ? { isError: true, content: [{ type: "text", text: "not configured" }] }',
            '          : { isError: false, content: [{ type: "text", text: JSON.stringify(whoami) }] };',
            '        process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);',
          ]),
      "      }",
      "    }",
      "  });",
      "  process.stdin.resume();",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(target, 0o755);
  return target;
}

function figmaApp(state: { isAccessible: boolean; isEnabled: boolean }) {
  return {
    id: "connector_68df038e0ba48191908c8434991bbac2",
    name: "Figma",
    pluginDisplayNames: ["Figma"],
    ...state,
  };
}
