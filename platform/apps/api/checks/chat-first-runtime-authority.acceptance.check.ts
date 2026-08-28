import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PgWorkflowStore } from "../src/db/store.ts";
import { createSandboxBlueprintRegistryFromEnv } from "../src/services/agent/sandbox-blueprint-registry.ts";

const root = new URL("../src/", import.meta.url);

test("CHAT-AC-05/10/12: one Session Sandbox is the Run workspace and its Blueprint uses the startup-approved image", async () => {
  const [session, workflow, store, blueprints] = await Promise.all([
    readFile(new URL("services/agent/agent-session-service.ts", root), "utf8"),
    readFile(new URL("services/workflow-service.ts", root), "utf8"),
    readFile(new URL("db/store.ts", root), "utf8"),
    readFile(new URL("services/agent/sandbox-blueprint-registry.ts", root), "utf8"),
  ]);

  assert.match(
    session,
    /createRun\(primary\.projectId,[\s\S]*?preparedSandbox,\s*\{[\s\S]*?sessionId,[\s\S]*?triggerMessageId:\s*userMessage\.id/u,
  );
  assert.match(workflow, /preparedAgentWorkspace\?: PreparedRunWorkspace/u);
  assert.match(store, /purpose IN \('run', 'sandbox'\) AND state = 'ready'/u);
  assert.match(
    store,
    /UPDATE agent_sandboxes[\s\S]*?SET state = 'busy'[\s\S]*?session_id = \$1 AND workspace_id = \$2/u,
  );
  assert.match(store, /INSERT INTO agent_session_runs[\s\S]*?await client\.query\("COMMIT"\)/u);
  assert.match(blueprints, /workerImage:\s*approvedWorkerImage/u);
  assert.match(blueprints, /omit\(\{ workerImage: true \}\)/u);
});

test("CHAT-AC-05/10: Blueprint summaries do not overstate a network policy they do not enforce", () => {
  const registry = createSandboxBlueprintRegistryFromEnv({
    AI_SDLC_WORKER_IMAGE: "registry.invalid/agent@sha256:abc123",
    AI_SDLC_WORKER_NETWORK: "bridge",
  });

  assert.equal(registry.default().capabilities.restrictedNetwork, false);
  assert.equal(registry.summaries()[0]?.capabilities.restrictedNetwork, false);
});

test("CHAT-AC-08/09: a selected MCP call is durably queued/running before the adapter executes", async () => {
  const session = await readFile(
    new URL("services/agent/agent-session-service.ts", root),
    "utf8",
  );
  const start = session.indexOf("private async executeReadOnlyTool");
  const queued = session.indexOf("createAgentToolCall", start);
  const running = session.indexOf("status: \"running\"", queued);
  const execute = session.indexOf("executeChoice(choice", running);
  const failed = session.indexOf("kind: \"tool.failed\"", execute);
  assert.ok(start >= 0 && queued > start && running > queued && execute > running && failed > execute);
});

test("CHAT-AC-09/10/15: startup recovery fails closed without replaying tools or LLM generations", async () => {
  const statements: string[] = [];
  const client = {
    async query(sql: string) {
      statements.push(sql.replace(/\s+/gu, " ").trim());
      return { rows: [], rowCount: /^(?:UPDATE)/iu.test(sql.trim()) ? 1 : null };
    },
    release() {},
  };
  const store = new PgWorkflowStore({
    async connect() { return client; },
  } as never);

  const result = await store.recoverChatAgentRuntimeAfterRestart();
  assert.deepEqual(result, {
    sessions: 1,
    messages: 1,
    toolCalls: 1,
    humanGates: 1,
    sandboxes: 1,
    deepWikiGenerations: 1,
  });
  const transcript = statements.join("\n");
  assert.match(transcript, /UPDATE agent_tool_calls SET status = 'failed'/u);
  assert.match(transcript, /平台没有自动重放/u);
  assert.match(transcript, /UPDATE deepwiki_generations SET status = 'failed'/u);
  assert.match(transcript, /UPDATE agent_sessions SET turn_state = 'idle'/u);
  assert.equal(statements.at(0), "BEGIN");
  assert.equal(statements.at(-1), "COMMIT");
});
