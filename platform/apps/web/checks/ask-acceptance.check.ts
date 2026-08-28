import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PHASE_IDS, createRunSchema } from "../../../packages/contracts/src/index.ts";
import {
  ASK_HISTORY_MAX_CHARACTERS,
  ASK_HISTORY_MAX_MESSAGES,
  appendAskExchange,
  askAnswerToCreateRunInput,
  askHistory,
  clearAskSession,
  emptyAskSession,
  isAskThreadIdentityLoaded,
  loadAskSession,
  pendingAskThreadSession,
  safeAskThreadTitle,
  saveAskSession,
  type AskStorage,
} from "../src/lib/ask-session.ts";
import {
  isAskNewThreadRequiredError,
  isAskRevisionConflictError,
} from "../src/lib/ask-error.ts";
import type { AskAnswer } from "../src/lib/types.ts";

/**
 * Independent acceptance tests (isolation Tier A): Web behavior is exercised
 * through exported session/rendering contracts, with a narrow source-level
 * wiring check where this repository has no browser DOM test dependency.
 */

const askPagePath = fileURLToPath(new URL("../src/pages/ask-page.tsx", import.meta.url));
const markdownPreviewPath = fileURLToPath(
  new URL("../src/components/markdown-preview.tsx", import.meta.url),
);

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

function answerFixture(
  revision = "revision-one",
  providerId: AskAnswer["provider"]["id"] = "custom",
): AskAnswer {
  return {
    answer: "直接结论。\n\n[模型生成的链接](https://attacker.invalid) 不是已验证证据。",
    citations: [{
      sourceId: "S1",
      path: "src/orders/read.ts",
      startLine: 12,
      endLine: 24,
      sha256: "a".repeat(64),
      revision,
      excerpt: "export function readOrder() {}",
      summary: "订单读取入口",
    }],
    invalidCitationIds: ["S999"],
    uncertainties: ["仓库无法证明线上运行状态。"],
    suggestedQuestions: ["还需要查看哪些调用方？"],
    workItemDraft: {
      title: "增加订单查询入口",
      objective: "用户能够按订单号查询订单状态。",
      acceptanceCriteria: ["输入有效订单号时展示当前状态"],
    },
    provider: { id: providerId, label: "Team endpoint", model: "team-model" },
    revision,
    dirty: false,
    usage: { inputTokens: 20, outputTokens: 10 },
    durationMs: 30,
    answeredAt: "2026-08-27T10:00:00.000Z",
  };
}

test("ASK-AC-02/10: a restored session keeps its selected Provider even after that Provider becomes unconfigured", async () => {
  const storage = new MemoryStorage();
  const priorSession = appendAskExchange(
    emptyAskSession("custom"),
    "Explain order lookup",
    answerFixture("revision-one", "custom"),
  );
  saveAskSession("project-one", priorSession, storage);

  const restored = loadAskSession("project-one", storage);
  assert.equal(restored.providerId, "custom");
  assert.equal(restored.revision, "revision-one");

  const askPage = await readFile(askPagePath, "utf8");
  assert.match(
    askPage,
    /const selectedProviderId = session\.providerId \?\? configuredProviders\[0\]\?\.id/u,
    "stored explicit selection must take precedence over any currently configured Provider",
  );
  assert.match(
    askPage,
    /if \(session\.providerId \|\| !selectedProviderId\) return/u,
    "default selection must never overwrite a restored Provider",
  );
  assert.match(askPage, /selectedProvider\?\.configured === true/u);
  assert.match(askPage, /reportedModel=\{selectedProvider\?\.configured/u);
  assert.match(askPage, /上游报告模型：\{reportedModel\}/u);
});

test("ASK-AC-05: the first question becomes one bounded single-line server thread title", () => {
  assert.deepEqual(
    safeAskThreadTitle("  第一行\n第二行\t带控制符\u0000  "),
    { title: "第一行 第二行 带控制符" },
  );
  assert.equal(safeAskThreadTitle("问".repeat(240)).title?.length, 200);
  assert.deepEqual(safeAskThreadTitle("\n\t\u0000"), {});
});

test("Ask only treats explicit revision conflicts as revision changes", async () => {
  assert.equal(
    isAskRevisionConflictError({ status: 409, code: "ASK_REVISION_MISMATCH" }),
    true,
  );
  assert.equal(
    isAskRevisionConflictError({ status: 409, code: "ASK_THREAD_REVISION_MISMATCH" }),
    true,
  );
  for (const code of [
    "ASK_THREAD_LIMIT",
    "ASK_THREAD_ARCHIVED",
    "ASK_SNAPSHOT_GONE",
    "ASK_THREAD_IDENTITY_PENDING",
  ]) {
    assert.equal(isAskRevisionConflictError({ status: 409, code }), false, code);
  }
  assert.equal(
    isAskRevisionConflictError({ status: 503, code: "ASK_THREAD_REVISION_MISMATCH" }),
    false,
  );

  const askPage = await readFile(askPagePath, "utf8");
  assert.match(askPage, /if \(isAskRevisionConflictError\(error\)\)/u);
  assert.doesNotMatch(
    askPage,
    /if \(error instanceof ApiError && error\.status === 409\)/u,
    "a recoverable 409 must keep its exact API message instead of pretending the revision changed",
  );
  assert.match(
    askPage,
    /message: error instanceof Error \? error\.message : "暂时没有拿到回答，请重试。"/u,
    "non-revision conflicts must show the server's actionable recovery message",
  );
});

test("full or archived Ask Threads offer a new conversation instead of a doomed retry", async () => {
  for (const code of ["ASK_THREAD_LIMIT", "ASK_THREAD_ARCHIVED"]) {
    assert.equal(isAskNewThreadRequiredError({ status: 409, code }), true, code);
  }
  for (const candidate of [
    { status: 409, code: "ASK_REVISION_MISMATCH" },
    { status: 409, code: "ASK_SNAPSHOT_GONE" },
    { status: 503, code: "ASK_THREAD_LIMIT" },
  ]) {
    assert.equal(isAskNewThreadRequiredError(candidate), false, JSON.stringify(candidate));
  }

  const askPage = await readFile(askPagePath, "utf8");
  assert.match(askPage, /if \(isAskNewThreadRequiredError\(error\)\)/u);
  assert.match(
    askPage,
    /failure\.newThreadRequired[\s\S]*clearConversation\(false\)[\s\S]*新建对话/u,
    "terminal Thread conflicts must render the new-conversation recovery action",
  );
});

test("ASK-AC-05/10: switching Cloud threads pins the visible Provider before sending", () => {
  const summary = {
    id: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    providerId: "openai" as const,
    revision: "thread-revision",
    sourceRevision: "a".repeat(40),
    title: "OpenAI thread",
    status: "active" as const,
    messageCount: 2,
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
  };
  const pending = pendingAskThreadSession(summary);
  assert.equal(pending.providerId, "openai");
  assert.equal(pending.revision, summary.revision);
  assert.equal(pending.sourceRevision, summary.sourceRevision);
  assert.equal(isAskThreadIdentityLoaded(summary.id, "openai", summary.revision, undefined), false);
  assert.equal(isAskThreadIdentityLoaded(summary.id, "ollama", summary.revision, {
    id: summary.id,
    providerId: "openai",
    revision: summary.revision,
  }), false);
  assert.equal(isAskThreadIdentityLoaded(summary.id, "openai", summary.revision, {
    id: summary.id,
    providerId: "openai",
    revision: summary.revision,
  }), true);
});

test("ASK-AC-05: the first Cloud question uses the canonical revision returned by thread creation", async () => {
  const askPage = await readFile(askPagePath, "utf8");
  assert.match(askPage, /const created = await api\.createAskThread/u);
  assert.match(askPage, /threadRevision = created\.revision/u);
  assert.match(
    askPage,
    /api\.askThread\([\s\S]*expectedRevision: threadRevision/u,
    "the raw snapshot SHA must not be reused after the server canonicalizes the thread revision",
  );
  assert.match(askPage, /setActiveThreadId\(created\.id\)/u);
  assert.match(askPage, /setSession\(askThreadToSession\(created\)\)/u);
});

test("ASK-AC-08: untrusted Ask Markdown renders links and images without navigable or fetchable URLs", async () => {
  const [askPage, markdownPreview] = await Promise.all([
    readFile(askPagePath, "utf8"),
    readFile(markdownPreviewPath, "utf8"),
  ]);
  const untrustedStart = markdownPreview.indexOf("const untrustedMarkdownComponents");
  const untrustedEnd = markdownPreview.indexOf("export function MarkdownPreview");
  assert.ok(untrustedStart >= 0 && untrustedEnd > untrustedStart);
  const untrustedMapping = markdownPreview.slice(untrustedStart, untrustedEnd);
  assert.match(untrustedMapping, /a:\s*\([^)]*children[^)]*\)\s*=>\s*<span>\{children\}<\/span>/u);
  assert.match(untrustedMapping, /img:\s*\([^)]*alt[^)]*\)\s*=>[\s\S]*?<span[\s\S]*?外部图片已省略/u);
  assert.doesNotMatch(untrustedMapping, /<a\b|<img\b|\bhref\b|\bsrc\b/u);
  assert.match(markdownPreview, /mode\?: "trusted" \| "untrusted"/u);
  assert.match(
    markdownPreview,
    /components=\{mode === "untrusted" \? untrustedMarkdownComponents : markdownComponents\}/u,
  );
  assert.match(markdownPreview, /skipHtml/u);
  assert.match(
    askPage,
    /<MarkdownPreview\s+content=\{answer\.answer\}[\s\S]*?mode="untrusted"/u,
    "Ask must opt into the no-navigation/no-image-fetch mode",
  );
  assert.match(askPage, /<CitationList[\s\S]*?citations=\{answer\.citations\}/u);
  assert.match(askPage, /\{citations\.map/u, "verified evidence remains in its separate citation panel");
});

test("ASK-AC-05/10: browser persistence is project-scoped, revision-bound, bounded, refreshable, and clearable", () => {
  const storage = new MemoryStorage();
  let first = emptyAskSession("ollama");
  for (let index = 0; index < 20; index += 1) {
    const answer = answerFixture("revision-one", "ollama");
    answer.answer = `回答-${index}-${"答".repeat(3_000)}`;
    first = appendAskExchange(first, `问题-${index}-${"问".repeat(3_000)}`, answer);
  }
  const second = appendAskExchange(
    emptyAskSession("openai"),
    "different project",
    answerFixture("revision-two", "openai"),
  );
  saveAskSession("project-one", first, storage);
  saveAskSession("project-two", second, storage);

  const restoredFirst = loadAskSession("project-one", storage);
  const restoredSecond = loadAskSession("project-two", storage);
  assert.equal(restoredFirst.providerId, "ollama");
  assert.equal(restoredFirst.revision, "revision-one");
  assert.equal(restoredSecond.providerId, "openai");
  assert.equal(restoredSecond.revision, "revision-two");
  assert.notDeepEqual(restoredFirst.messages, restoredSecond.messages);

  const boundedHistory = askHistory(restoredFirst.messages);
  assert.ok(boundedHistory.length <= ASK_HISTORY_MAX_MESSAGES);
  assert.ok(
    boundedHistory.reduce((total, message) => total + message.content.length, 0)
      <= ASK_HISTORY_MAX_CHARACTERS,
  );

  clearAskSession("project-one", storage);
  assert.deepEqual(loadAskSession("project-one", storage), emptyAskSession());
  assert.equal(loadAskSession("project-two", storage).revision, "revision-two");
});

test("ASK-AC-11/12: Ask work-item handoff is editable, explicitly confirmed, and preserves the existing six-phase Run contract", async () => {
  const answer = answerFixture("revision-handoff", "ollama");
  const editedDraft = {
    workType: "change" as const,
    title: "人工编辑后的订单查询任务",
    objective: "经用户确认后，订单查询返回稳定状态和白话错误。",
    acceptanceCriteria: [
      "有效订单号展示当前状态",
      "无效订单号展示白话错误",
    ],
    currentBehavior: "目前用户找不到订单查询入口。",
    inScope: ["增加订单号查询入口", "展示查询失败的白话提示"],
    outOfScope: ["不修改支付流程"],
    regressionScope: ["已有订单列表", "订单详情页"],
    riskFlags: ["需要保持旧订单链接可用"],
  };
  const runInput = askAnswerToCreateRunInput(editedDraft, answer);
  assert.equal(createRunSchema.safeParse(runInput).success, true);
  assert.equal(runInput.title, editedDraft.title);
  assert.ok("changeContract" in runInput && runInput.changeContract);
  if (!("changeContract" in runInput) || !runInput.changeContract) return;
  assert.deepEqual(runInput.changeContract.acceptanceCriteria, editedDraft.acceptanceCriteria);
  assert.equal(runInput.changeContract.workType, "change");
  assert.equal(runInput.changeContract.currentBehavior, editedDraft.currentBehavior);
  assert.deepEqual(runInput.changeContract.inScope, editedDraft.inScope);
  assert.deepEqual(runInput.changeContract.regressionScope, editedDraft.regressionScope);
  assert.deepEqual(runInput.changeContract.evidenceRefs, [
    "repo://revision-handoff/src/orders/read.ts#L12-L24",
  ]);
  assert.deepEqual(PHASE_IDS, [
    "discovery",
    "design",
    "architecture",
    "implementation",
    "verification",
    "release",
  ]);

  const askPage = await readFile(askPagePath, "utf8");
  assert.match(askPage, /整理成工作项/u);
  assert.match(askPage, /sourceRevision=\{draftSourceRevision\}/u);
  assert.match(
    askPage,
    /aria-label="选择云端 Ask 对话"[\s\S]*?onChange=\{\(event\) => \{[\s\S]*?pendingAskThreadSession\(nextThread\)[\s\S]*?setDraftSourceRevision\(undefined\)/u,
    "switching threads must immediately pin its Provider and clear the old handoff",
  );
  assert.match(askPage, /if \(!threadIdentityReady\)[\s\S]*?仍在读取/u);
  assert.match(
    askPage,
    /disabled=\{!providerReady \|\| !threadIdentityReady \|\| !question\.trim\(\)/u,
    "send must remain disabled until the selected thread identity is loaded",
  );
  assert.match(
    askPage,
    /setDraftSourceRevision\(remoteProject \? session\.sourceRevision : undefined\)/u,
    "opening a handoff must capture the revision belonging to the visible answer",
  );
  const handoffStart = askPage.indexOf("function WorkItemDraftDialog");
  assert.ok(handoffStart >= 0);
  const handoffSource = askPage.slice(handoffStart);
  assert.match(handoffSource, /value=\{draft\.title\}/u);
  assert.match(handoffSource, /value=\{draft\.objective\}/u);
  assert.match(handoffSource, /value=\{draft\.currentBehavior\}/u);
  assert.match(handoffSource, /value=\{inScopeText\}/u);
  assert.match(handoffSource, /value=\{regressionScopeText\}/u);
  assert.match(handoffSource, /确认并创建交付任务/u);
  assert.match(handoffSource, /api\.createRun/u);
  assert.match(handoffSource, /不会自动执行任何阶段/u);
  assert.equal(
    (askPage.match(/api\.createRun/g) ?? []).length,
    1,
    "receiving an Ask answer must not create a Run before the one confirmation handler",
  );
});
