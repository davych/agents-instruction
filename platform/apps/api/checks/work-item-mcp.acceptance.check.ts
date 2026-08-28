import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type pg from "pg";

import { buildApp } from "../src/app.ts";
import { renderChangeContract } from "../src/domain/change-routing.ts";
import { AppError } from "../src/domain/errors.ts";
import { createWorkItemMcpRegistryFromEnv } from "../src/services/work-item/work-item-mcp-registry.ts";

const fixture = fileURLToPath(new URL("./fixtures/fake-work-item-mcp.mjs", import.meta.url));
const fixedNow = new Date("2026-08-27T08:00:00.000Z");

function adapterConfig() {
  return [{
    id: "jira-main",
    label: "Jira",
    command: process.execPath,
    args: [fixture],
    toolName: "get_issue",
    referenceArgument: "issueId",
    fixedArguments: { cloudId: "cloud-42" },
    secretEnv: { MCP_TEST_TOKEN: "MCP_SOURCE_SECRET" },
    mapping: {
      title: "issue.title",
      description: "issue.description",
      externalId: "issue.identifier",
      url: "issue.url",
      acceptanceCriteria: "issue.acceptance",
      labels: "issue.labels",
      suggestedWorkType: "issue.kind",
    },
    defaultWorkType: "feature",
  }];
}

function registryEnvironment(secret = "server-side-token") {
  return {
    AI_SDLC_WORK_ITEM_MCP_ADAPTERS: JSON.stringify(adapterConfig()),
    MCP_SOURCE_SECRET: secret,
    MCP_UNMAPPED_SECRET: "must-not-reach-adapter",
    PATH: process.env.PATH,
  };
}

test("operator-configured MCP adapter normalizes structured and JSON text tool results", async () => {
  const registry = createWorkItemMcpRegistryFromEnv(registryEnvironment(), {
    clock: () => fixedNow,
  });
  assert.deepEqual(registry.summaries(), [{
    id: "jira-main",
    label: "Jira",
    kind: "mcp-stdio",
    configured: true,
    message: null,
  }]);

  const structured = await registry.resolve({ adapterId: "jira-main", reference: "ENG-142" });
  assert.equal(structured.title, "Issue ENG-142");
  assert.equal(structured.description, "Plain description");
  assert.equal(structured.suggestedWorkType, "bug");
  assert.deepEqual(structured.labels, ["backend", "cloud"]);
  assert.deepEqual(structured.acceptanceCriteria, [
    "Returns a normalized draft",
    "Keeps credentials on the server",
  ]);
  assert.deepEqual(structured.source, {
    kind: "mcp",
    adapterId: "jira-main",
    adapterLabel: "Jira",
    reference: "ENG-142",
    externalId: "ENG-142",
    url: "https://issues.example.test/browse/ENG-142",
    fetchedAt: fixedNow.toISOString(),
    fingerprint: structured.source.fingerprint,
  });
  assert.match(structured.source.fingerprint, /^[a-f0-9]{64}$/u);

  const text = await registry.resolve({ adapterId: "jira-main", reference: "TEXT-1" });
  assert.equal(text.title, "Issue TEXT-1");
  assert.equal(text.source.externalId, "TEXT-1");
});

test("Jira, Linear, and generic adapters preserve their configured safe reference argument", async () => {
  const jira = adapterConfig()[0]!;
  const configs = [
    jira,
    {
      ...jira,
      id: "linear-main",
      label: "Linear",
      referenceArgument: "identifier",
    },
    {
      ...jira,
      id: "generic-readonly",
      label: "Generic",
      referenceArgument: "reference",
    },
  ];
  const registry = createWorkItemMcpRegistryFromEnv({
    ...registryEnvironment(),
    AI_SDLC_WORK_ITEM_MCP_ADAPTERS: JSON.stringify(configs),
  }, { clock: () => fixedNow });

  for (const [adapterId, reference] of [
    ["jira-main", "JIRA-1"],
    ["linear-main", "LIN-2"],
    ["generic-readonly", "GEN-3"],
  ] as const) {
    const draft = await registry.resolve({ adapterId, reference });
    assert.equal(draft.title, `Issue ${reference}`);
    assert.equal(draft.source.adapterId, adapterId);
    assert.equal(draft.source.reference, reference);
  }
});

test("operator configuration rejects object meta keys as reference arguments", () => {
  for (const referenceArgument of ["__proto__", "prototype", "constructor"]) {
    assert.throws(() => createWorkItemMcpRegistryFromEnv({
      AI_SDLC_WORK_ITEM_MCP_ADAPTERS: JSON.stringify([{
        ...adapterConfig()[0],
        referenceArgument,
      }]),
    }), /配置无效/u, referenceArgument);
  }
});

test("environment JSON rejects top-level object meta keys in fixedArguments before Zod normalization", () => {
  for (const propertyName of ["__proto__", "prototype", "constructor"]) {
    const fixedArguments = Object.fromEntries([[propertyName, "operator-controlled-value"]]);
    assert.equal(Object.hasOwn(fixedArguments, propertyName), true);
    assert.throws(() => createWorkItemMcpRegistryFromEnv({
      AI_SDLC_WORK_ITEM_MCP_ADAPTERS: JSON.stringify([{
        ...adapterConfig()[0],
        fixedArguments,
      }]),
    }), /配置无效/u, propertyName);
  }
});

test("adapter secrets, command, args, and fixed arguments stay server-owned", async () => {
  const unavailable = createWorkItemMcpRegistryFromEnv(registryEnvironment(""));
  assert.equal(unavailable.summaries()[0]?.configured, false);
  await assert.rejects(
    unavailable.resolve({ adapterId: "jira-main", reference: "ENG-142" }),
    (error: unknown) => error instanceof AppError
      && error.code === "WORK_ITEM_ADAPTER_NOT_CONFIGURED"
      && !error.message.includes("MCP_SOURCE_SECRET"),
  );

  assert.throws(() => createWorkItemMcpRegistryFromEnv({
    AI_SDLC_WORK_ITEM_MCP_ADAPTERS: JSON.stringify([{
      ...adapterConfig()[0],
      command: "node",
    }]),
  }), /配置无效/u);
  assert.throws(() => createWorkItemMcpRegistryFromEnv({
    AI_SDLC_WORK_ITEM_MCP_ADAPTERS: JSON.stringify([{
      ...adapterConfig()[0],
      fixedArguments: { cloudId: "cloud-42", issueId: "server-must-not-set-this" },
    }]),
  }), /配置无效/u);
});

test("MCP failures are bounded and never return stderr or environment secrets", async () => {
  const registry = createWorkItemMcpRegistryFromEnv(registryEnvironment(), {
    timeoutMs: 1_000,
    maxOutputBytes: 16 * 1024,
  });
  await assert.rejects(
    registry.resolve({ adapterId: "jira-main", reference: "ERROR-1" }),
    (error: unknown) => error instanceof AppError
      && error.code === "WORK_ITEM_MCP_TOOL_ERROR"
      && !error.message.includes("server-side-token")
      && !String(JSON.stringify(error.details)).includes("server-side-token"),
  );
  await assert.rejects(
    registry.resolve({ adapterId: "jira-main", reference: "TOO-LARGE-1" }),
    (error: unknown) => error instanceof AppError
      && error.code === "WORK_ITEM_MCP_OUTPUT_LIMIT",
  );
  await assert.rejects(
    registry.resolve({ adapterId: "jira-main", reference: "HANG-1" }),
    (error: unknown) => error instanceof AppError
      && error.code === "WORK_ITEM_MCP_TIMEOUT",
  );
});

test("MCP process concurrency is capped instead of building an unbounded queue", async () => {
  const registry = createWorkItemMcpRegistryFromEnv(registryEnvironment(), {
    timeoutMs: 2_000,
    maxConcurrent: 1,
  });
  const controller = new AbortController();
  const occupied = registry.resolve(
    { adapterId: "jira-main", reference: "HANG-1" },
    controller.signal,
  );
  await assert.rejects(
    registry.resolve({ adapterId: "jira-main", reference: "ENG-142" }),
    (error: unknown) => error instanceof AppError
      && error.statusCode === 429
      && error.code === "WORK_ITEM_MCP_BUSY",
  );
  controller.abort();
  await assert.rejects(occupied, (error: unknown) => (
    error instanceof AppError && error.code === "WORK_ITEM_MCP_ABORTED"
  ));
});

test("MCP concurrency stays reserved until a SIGTERM-resistant adapter is gone", async () => {
  const registry = createWorkItemMcpRegistryFromEnv(registryEnvironment(), {
    timeoutMs: 3_000,
    maxConcurrent: 1,
  });
  const startedAt = Date.now();
  const terminating = registry.resolve({ adapterId: "jira-main", reference: "SLOW-TERM-1" });
  await assert.rejects(
    registry.resolve({ adapterId: "jira-main", reference: "ENG-142" }),
    (error: unknown) => error instanceof AppError
      && error.code === "WORK_ITEM_MCP_BUSY",
  );
  const result = await terminating;
  assert.equal(result.source.externalId, "SLOW-TERM-1");
  assert.equal(Date.now() - startedAt >= 900, true, "slot released before SIGKILL/close confirmation");
  assert.equal(
    (await registry.resolve({ adapterId: "jira-main", reference: "ENG-142" })).title,
    "Issue ENG-142",
  );
});

test("authenticated HTTP endpoints expose summaries and resolve only strict browser input", async () => {
  const token = "work-item-test-token-1234567890";
  const registry = createWorkItemMcpRegistryFromEnv(registryEnvironment(), {
    clock: () => fixedNow,
  });
  const app = await buildApp({
    pool: {} as pg.Pool,
    workItemAdapters: registry,
    accessToken: token,
  });
  try {
    const unauthorized = await app.inject({ method: "GET", url: "/api/work-item-adapters" });
    assert.equal(unauthorized.statusCode, 401);

    const headers = { authorization: `Bearer ${token}` };
    const list = await app.inject({ method: "GET", url: "/api/work-item-adapters", headers });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().adapters[0].id, "jira-main");
    assert.equal(JSON.stringify(list.json()).includes(process.execPath), false);
    assert.equal(JSON.stringify(list.json()).includes("MCP_SOURCE_SECRET"), false);

    const rejected = await app.inject({
      method: "POST",
      url: "/api/work-items/resolve",
      headers,
      payload: { adapterId: "jira-main", reference: "ENG-142", command: "/bin/sh" },
    });
    assert.equal(rejected.statusCode, 400);

    const resolved = await app.inject({
      method: "POST",
      url: "/api/work-items/resolve",
      headers,
      payload: { adapterId: "jira-main", reference: "ENG-142" },
    });
    assert.equal(resolved.statusCode, 200);
    assert.equal(resolved.json().workItem.title, "Issue ENG-142");
  } finally {
    await app.close();
  }
});

test("Change Contract rendering keeps the immutable Work Item source snapshot readable", () => {
  const markdown = renderChangeContract({
    workType: "bug",
    workItem: {
      kind: "mcp",
      adapterId: "jira-main",
      adapterLabel: "Jira",
      reference: "ENG-142",
      externalId: "ENG-142",
      url: "https://issues.example.test/browse/ENG-142",
      fetchedAt: fixedNow.toISOString(),
      fingerprint: "a".repeat(64),
    },
    summary: "Fix export",
    currentBehavior: "Export fails.",
    expectedBehavior: "Export succeeds.",
    inScope: ["Export"],
    outOfScope: [],
    acceptanceCriteria: ["Export succeeds"],
    regressionScope: ["Export filters"],
    riskFlags: [],
    evidenceRefs: ["jira:ENG-142"],
  });
  assert.match(markdown, /## Work item source/u);
  assert.match(markdown, /外部工作项是未信任资料/u);
  assert.match(markdown, /"adapterLabel": "Jira"/u);
  assert.match(markdown, /"reference": "ENG-142"/u);
  assert.match(markdown, /"fingerprint": "a{64}"/u);
  assert.doesNotMatch(markdown, /- Source: Jira/u);
});
