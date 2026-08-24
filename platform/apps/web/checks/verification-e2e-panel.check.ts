import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  verificationE2ePrimaryAction,
  verificationE2eStandardGate,
  type VerificationE2eActionKind,
} from "../src/lib/verification-e2e-workflow.js";

const panelPath = fileURLToPath(
  new URL("../src/components/verification-e2e-panel.tsx", import.meta.url),
);
const apiPath = fileURLToPath(new URL("../src/lib/api.ts", import.meta.url));
const runPagePath = fileURLToPath(new URL("../src/pages/run-page.tsx", import.meta.url));
const testerWorkflowPath = fileURLToPath(new URL("../src/lib/tester-workflow.ts", import.meta.url));

test("Verification E2E panel maps every flow state to one safe primary action", () => {
  const cases = new Map<string, VerificationE2eActionKind>([
    ["unconfigured", "configure"],
    ["preflight_blocked", "preflight"],
    ["needs_authoring", "author"],
    ["awaiting_script_review", "review_script"],
    ["ready_to_execute", "execute"],
    ["awaiting_verification_review", "review_verification"],
  ]);
  for (const [state, expected] of cases) {
    assert.equal(
      verificationE2ePrimaryAction(state as Parameters<typeof verificationE2ePrimaryAction>[0]).kind,
      expected,
      state,
    );
  }
  assert.equal(verificationE2ePrimaryAction("authoring").kind, "wait");
  assert.equal(verificationE2ePrimaryAction("executing").kind, "wait");
  assert.equal(verificationE2ePrimaryAction("failed").kind, "execute");
});

test("ordinary Tester stays fail-closed until an unconfigured workspace is proven", () => {
  assert.deepEqual(verificationE2eStandardGate({
    flowLoaded: false,
    flowHasWorkspace: false,
    workspaceLoaded: false,
    workspaceConfigured: false,
  }), {
    explicitlyUnconfigured: false,
    stateUncertain: true,
    standardTesterLocked: true,
  });
  assert.deepEqual(verificationE2eStandardGate({
    flowLoaded: false,
    flowHasWorkspace: false,
    workspaceLoaded: true,
    workspaceConfigured: false,
  }), {
    explicitlyUnconfigured: true,
    stateUncertain: false,
    standardTesterLocked: false,
  });
  assert.equal(verificationE2eStandardGate({
    flowLoaded: true,
    flowState: "unconfigured",
    flowHasWorkspace: false,
    workspaceLoaded: false,
    workspaceConfigured: false,
  }).standardTesterLocked, false);
  assert.deepEqual(verificationE2eStandardGate({
    flowLoaded: false,
    flowHasWorkspace: false,
    workspaceLoaded: true,
    workspaceConfigured: true,
  }), {
    explicitlyUnconfigured: false,
    stateUncertain: true,
    standardTesterLocked: true,
  });
  assert.equal(verificationE2eStandardGate({
    flowLoaded: true,
    flowState: "needs_authoring",
    flowHasWorkspace: false,
    workspaceLoaded: true,
    workspaceConfigured: false,
  }).standardTesterLocked, true);
});

test("Verification E2E panel distinguishes Chromium from MCP and jsdom", async () => {
  const source = await readFile(panelPath, "utf8");
  assert.match(source, /独立 E2E 项目 · 真实 Chromium/u);
  assert.match(source, /MCP 只用于探索/u);
  assert.match(source, /Vitest\/jsdom[\s\S]{0,80}不能替代真实浏览器证据/u);
  assert.match(source, /实际会执行的整套 tests\/\*\* 与 fixtures\/\*\*/u);
  assert.match(source, /必须逐一看过全部文件内容和每个 hash/u);
  assert.match(source, /不批准 Verification、合并或发布/u);
  assert.match(source, /E2E 环境预检结果/u);
  assert.match(source, /Chromium 启动/u);
  assert.match(source, /显式准备 Playwright \/ Chromium/u);
  assert.match(source, /平台建议/u);
  assert.match(source, /重新生成或更新脚本/u);
  assert.match(source, /无法确认 linked 状态，请重试加载/u);
  assert.match(source, /重试加载 linked 状态/u);
  assert.match(source, /flow\.execution\.error/u);
  assert.match(source, /真实 E2E 执行失败/u);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/u);
  assert.doesNotMatch(source, /E2E crystallization request:/u);
  assert.match(source, /无需手写特殊评论或 Markdown/u);
});

test("Verification E2E API uses structured actions instead of shell text", async () => {
  const source = await readFile(apiPath, "utf8");
  assert.match(source, /\/api\/projects\/\$\{encodeURIComponent\(projectId\)\}\/e2e-workspace/u);
  assert.match(source, /\/api\/runs\/\$\{encodeURIComponent\(runId\)\}\/verification\/e2e-flow/u);
  assert.match(source, /action: "preflight"/u);
  assert.match(source, /action: "execute", \.\.\.input/u);
  assert.match(source, /verification\/e2e-flow\/author/u);
  assert.match(source, /verification\/e2e-flow\/script-review/u);
  assert.match(source, /e2e-workspace\/prepare/u);
  assert.doesNotMatch(source, /shellCommand|rawCommand/u);
});

test("Run page connects every E2E state action without a review-comment marker", async () => {
  const [runPage, testerWorkflow] = await Promise.all([
    readFile(runPagePath, "utf8"),
    readFile(testerWorkflowPath, "utf8"),
  ]);
  assert.match(runPage, /<VerificationE2ePanel[\s\S]*onConfigureWorkspace[\s\S]*onPrepareWorkspace[\s\S]*onPreflight/iu);
  assert.match(runPage, /verificationAction: "author_e2e"/u);
  assert.match(runPage, /verificationAction: "run_e2e"/u);
  assert.match(runPage, /api\.authorVerificationE2e\(runId, e2eSelection\)/u);
  assert.match(runPage, /api\.executeVerificationE2e\(runId, e2eSelection\)/u);
  assert.match(runPage, /人工审核 · 完整 E2E 可执行脚本基线/u);
  assert.match(runPage, /不是只展示本次变更/u);
  assert.match(runPage, /当前没有完整展示整套文件，不能批准或执行/u);
  assert.match(runPage, /completeBaselineReviewed/u);
  assert.match(runPage, /批准脚本并允许运行/u);
  assert.match(runPage, /配置独立 E2E workspace/u);
  assert.match(runPage, /Playwright 精确版本/u);
  assert.match(runPage, /普通验证（无需真实浏览器 E2E）/u);
  assert.match(runPage, /既有非 E2E Run 不必配置 workspace/u);
  assert.match(runPage, /最终 test-report[\s\S]*缺少必需证据时不会放行/u);
  assert.match(runPage, /api\.getE2eWorkspace\(runQuery\.data!\.run\.projectId\)/u);
  assert.match(runPage, /verificationE2eStandardGate\(\{[\s\S]*flowLoaded:[\s\S]*workspaceLoaded:/u);
  assert.match(runPage, /verificationE2eStateUncertain=\{linkedStateUncertain\}/u);
  assert.match(runPage, /无法确认 linked 状态，请重试加载/u);
  assert.match(runPage, /本 Run 已启动 linked E2E[\s\S]*不能再用普通 Tester 报告覆盖[\s\S]*不提供取消/iu);
  assert.match(runPage, /canExecute && !standardVerificationExecutionLocked/u);
  assert.match(runPage, /canReview && !linkedVerificationReviewLocked/u);
  assert.match(runPage, /isAbsoluteFilePath\(rootPath\)/u);
  assert.match(runPage, /\^\[A-Za-z0-9\]\[A-Za-z0-9:_-\]\{0,79\}\$/u);
  assert.match(runPage, /!parsed\.username[\s\S]*!parsed\.password[\s\S]*!parsed\.hash/u);
  assert.match(runPage, /不允许点号、空格或 shell 语法/u);
  assert.doesNotMatch(`${runPage}\n${testerWorkflow}`, /E2E crystallization request:/u);
  assert.match(testerWorkflow, /旧 Run[\s\S]*已批准[\s\S]*不用手写特殊评论或 Markdown/u);
});
