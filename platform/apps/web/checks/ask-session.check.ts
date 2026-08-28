import assert from "node:assert/strict";
import test from "node:test";

import {
  ASK_HISTORY_MAX_CHARACTERS,
  ASK_HISTORY_MAX_MESSAGES,
  ASK_SESSION_MAX_MESSAGES,
  appendAskExchange,
  askAnswerToCreateRunInput,
  askHistory,
  emptyAskSession,
  loadAskSession,
  saveAskSession,
  workItemDraftMissingFields,
  type AskStorage,
} from "../src/lib/ask-session.ts";
import type { AskAnswer } from "../src/lib/types.ts";

class MemoryStorage implements AskStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

test("Ask browser sessions keep bounded complete exchanges for one revision", () => {
  const storage = new MemoryStorage();
  let session = emptyAskSession("ollama");
  for (let index = 0; index < 20; index += 1) {
    session = appendAskExchange(session, `问题 ${index}`, answerFixture("rev-one", index));
  }

  assert.equal(session.messages.length, ASK_SESSION_MAX_MESSAGES);
  saveAskSession("project-1", session, storage);
  const restored = loadAskSession("project-1", storage);

  assert.equal(restored.providerId, "ollama");
  assert.equal(restored.revision, "rev-one");
  assert.equal(restored.messages.length, ASK_SESSION_MAX_MESSAGES);
  assert.equal(restored.messages[0]?.role, "user");
  assert.equal(restored.messages.at(-1)?.role, "assistant");
});

test("Ask storage parsing fails closed and drops a mixed-revision exchange", () => {
  const storage = new MemoryStorage();
  storage.setItem("ai-sdlc:ask:v1:broken", "{not-json");
  assert.deepEqual(loadAskSession("broken", storage), emptyAskSession());

  const first = appendAskExchange(emptyAskSession("openai"), "旧问题", answerFixture("rev-old", 1));
  const mixed = {
    ...first,
    messages: [
      ...first.messages,
      ...appendAskExchange(emptyAskSession("custom"), "新问题", answerFixture("rev-new", 2)).messages,
    ],
  };
  saveAskSession("mixed", mixed, storage);
  const restored = loadAskSession("mixed", storage);

  assert.equal(restored.revision, "rev-old");
  assert.equal(restored.messages.length, 2);
  assert.equal(restored.messages[0]?.content, "旧问题");
});

test("Ask storage preserves a bounded citation excerpt instead of silently shortening its lines", () => {
  const storage = new MemoryStorage();
  const answer = answerFixture("rev-lines", 3);
  answer.citations[0]!.excerpt = Array.from(
    { length: 240 },
    (_, index) => `${index + 12}: const value${index} = ${index};`,
  ).join("\n");
  const session = appendAskExchange(emptyAskSession("ollama"), "查看完整依据", answer);

  saveAskSession("citation-lines", session, storage);
  const restored = loadAskSession("citation-lines", storage);
  const restoredExcerpt = restored.messages[1]?.answer?.citations[0]?.excerpt;

  assert.equal(restoredExcerpt, answer.citations[0]!.excerpt);
});

test("Ask history enforces both the message and total-character API budgets", () => {
  let session = emptyAskSession("lmstudio");
  for (let index = 0; index < 12; index += 1) {
    session = appendAskExchange(
      session,
      `问题-${index}-${"问".repeat(3_000)}`,
      { ...answerFixture("rev-one", index), answer: `回答-${index}-${"答".repeat(3_000)}` },
    );
  }
  const history = askHistory(session.messages);

  assert.ok(history.length <= ASK_HISTORY_MAX_MESSAGES);
  assert.ok(
    history.reduce((total, message) => total + message.content.length, 0)
      <= ASK_HISTORY_MAX_CHARACTERS,
  );
  assert.equal(history.at(-1)?.role, "assistant");
});

test("Ask work-item confirmation builds a full feature Change Contract with revision evidence", () => {
  const answer = answerFixture("abc123", 1);
  answer.dirty = true;
  const draft = {
    workType: "feature" as const,
    title: "增加订单查询入口",
    objective: "用户能够按订单号查询订单状态。",
    acceptanceCriteria: ["输入有效订单号时展示当前状态", "找不到订单时给出白话提示"],
    currentBehavior: "目前没有订单号查询入口。",
    inScope: ["增加查询入口"],
    outOfScope: [],
    regressionScope: ["订单列表", "订单详情"],
    riskFlags: [],
  };

  assert.deepEqual(workItemDraftMissingFields(draft), []);
  const input = askAnswerToCreateRunInput(draft, answer);
  assert.ok("changeContract" in input && input.changeContract);
  if (!("changeContract" in input) || !input.changeContract) return;

  assert.equal(input.changeContract.workType, "feature");
  assert.deepEqual(input.changeContract.acceptanceCriteria, draft.acceptanceCriteria);
  assert.deepEqual(input.changeContract.evidenceRefs, [
    "repo://abc123/src/orders/read.ts#L12-L24",
  ]);
  assert.equal(input.changeContract.riskFlags.length, 1);
});

function answerFixture(revision: string, index: number): AskAnswer {
  return {
    answer: `这是回答 ${index}`,
    citations: [{
      sourceId: `S${index}`,
      path: "src/orders/read.ts",
      startLine: 12,
      endLine: 24,
      sha256: "a".repeat(64),
      revision,
      excerpt: "export function readOrder() {}",
      summary: "订单读取入口",
    }],
    invalidCitationIds: [],
    uncertainties: [],
    suggestedQuestions: [],
    workItemDraft: {
      title: "增加订单查询入口",
      objective: "用户能够按订单号查询订单状态。",
      acceptanceCriteria: ["输入有效订单号时展示当前状态"],
    },
    provider: { id: "ollama", label: "Ollama", model: "qwen3" },
    revision,
    dirty: false,
    usage: { inputTokens: null, outputTokens: null },
    durationMs: 120,
    answeredAt: "2026-08-27T10:00:00.000Z",
  };
}
