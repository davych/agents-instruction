import assert from "node:assert/strict";
import test from "node:test";

import type { AskAnswerDto, AskThreadDto } from "@ai-sdlc/contracts";
import type pg from "pg";

import { PgWorkflowStore } from "../src/db/store.ts";
import { AppError } from "../src/domain/errors.ts";
import { AskThreadService } from "../src/services/ask/ask-thread-service.ts";
import type { AskService } from "../src/services/ask/ask-service.ts";

const projectId = "11111111-1111-4111-8111-111111111111";
const threadId = "22222222-2222-4222-8222-222222222222";
const sourceRevision = "a".repeat(40);
const threadRevision = `git:${sourceRevision}:clean`;
const now = "2026-08-28T00:00:00.000Z";

test("Ask capacity preflight locks the Thread and rejects a turn that cannot fit", async () => {
  const queries: string[] = [];
  const client = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("SELECT * FROM ask_threads")) {
        return { rows: [{ id: threadId, status: "active", revision: threadRevision }] };
      }
      if (sql.includes("next_sequence")) return { rows: [{ next_sequence: 200 }] };
      return { rows: [] };
    },
    release() {},
  };
  const store = new PgWorkflowStore({
    async connect() { return client; },
  } as unknown as pg.Pool);

  await assert.rejects(
    () => store.assertAskThreadTurnCapacity(threadId, threadRevision),
    (error: unknown) => {
      assert.equal((error as { statusCode?: number }).statusCode, 409);
      assert.equal((error as { code?: string }).code, "ASK_THREAD_LIMIT");
      assert.match((error as Error).message, /新建对话/u);
      return true;
    },
  );

  assert.ok(queries.some((sql) => /SELECT \* FROM ask_threads[\s\S]*FOR UPDATE/u.test(sql)));
  assert.equal(queries.includes("COMMIT"), false);
  assert.equal(queries.at(-1), "ROLLBACK");
});

test("Ask final append keeps the transactional capacity defense", async () => {
  const queries: string[] = [];
  const client = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("SELECT * FROM ask_threads")) {
        return { rows: [{ id: threadId, status: "active", revision: threadRevision }] };
      }
      if (sql.includes("next_sequence")) return { rows: [{ next_sequence: 200 }] };
      return { rows: [] };
    },
    release() {},
  };
  const store = new PgWorkflowStore({
    async connect() { return client; },
  } as unknown as pg.Pool);

  await assert.rejects(
    () => store.appendAskThreadTurn({
      threadId,
      question: "这个问题不应在已满的 Thread 中落库",
      answer: answerFixture(),
    }),
    (error: unknown) => (error as { code?: string }).code === "ASK_THREAD_LIMIT",
  );

  assert.equal(queries.some((sql) => sql.includes("INSERT INTO ask_messages")), false);
  assert.equal(queries.at(-1), "ROLLBACK");
});

test("two in-process sends at the last turn budget call the model only once", async () => {
  let persistedMessages = 198;
  let modelCalls = 0;
  let appendCalls = 0;
  const thread = (): AskThreadDto => ({
    id: threadId,
    projectId,
    providerId: "openai",
    revision: threadRevision,
    sourceRevision,
    title: "Nearly full Thread",
    status: "active",
    messageCount: persistedMessages,
    messages: [],
    createdAt: now,
    updatedAt: now,
  });
  const store = {
    getAskThread: async () => thread(),
    assertAskThreadTurnCapacity: async () => {
      if (persistedMessages + 2 > 200) throw limitError();
    },
    getProject: async () => ({
      id: projectId,
      sourceKind: "remote-git",
      rootPath: "/managed/current",
    }),
    getKnowledgeWorkspaceByRevision: async () => ({ rootPath: "/managed/pinned" }),
    appendAskThreadTurn: async () => {
      // This repeats the database's final FOR UPDATE defense for the fake.
      if (persistedMessages + 2 > 200) throw limitError();
      appendCalls += 1;
      persistedMessages += 2;
      return thread();
    },
  } as unknown as PgWorkflowStore;
  const ask = {
    answerFromSnapshot: async () => {
      modelCalls += 1;
      return answerFixture();
    },
  } as unknown as AskService;
  const service = new AskThreadService(store, ask);

  const results = await Promise.allSettled([
    service.send(threadId, { question: "first", expectedRevision: threadRevision }),
    service.send(threadId, { question: "second", expectedRevision: threadRevision }),
  ]);

  assert.equal(
    results.filter(({ status }) => status === "fulfilled").length,
    1,
    results.map((result) => result.status === "rejected"
      ? `${(result.reason as { code?: string }).code}:${String(result.reason)}`
      : "fulfilled").join(" | "),
  );
  const rejection = results.find(({ status }) => status === "rejected");
  assert.equal(rejection?.status, "rejected");
  if (rejection?.status === "rejected") {
    assert.equal((rejection.reason as { code?: string }).code, "ASK_THREAD_LIMIT");
  }
  assert.equal(modelCalls, 1);
  assert.equal(appendCalls, 1);
  assert.equal(persistedMessages, 200);
});

function answerFixture(): AskAnswerDto {
  return {
    answer: "回答",
    citations: [],
    invalidCitationIds: [],
    uncertainties: [],
    suggestedQuestions: [],
    workItemDraft: null,
    provider: { id: "openai", label: "OpenAI", model: "test-model" },
    revision: threadRevision,
    dirty: false,
    usage: { inputTokens: 1, outputTokens: 1 },
    durationMs: 1,
    answeredAt: now,
  };
}

function limitError(): AppError {
  return new AppError(
    "这个 Ask 对话已达到 200 条消息上限，请新建对话后继续。",
    409,
    "ASK_THREAD_LIMIT",
  );
}
