import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  ArtifactDto,
  PhaseId,
  PhaseRunDto,
  ProjectDto,
  ReviewDto,
} from "@ai-sdlc/contracts";

import type { PgWorkflowStore } from "../src/db/store.ts";
import {
  assessDeferredDesignValidations,
  isDeferredDesignVerification,
} from "../src/domain/design-deferred-validation.ts";
import { assessPhaseHumanDecisionGate } from "../src/domain/human-decisions.ts";
import { CodexTerminalRunner } from "../src/services/codex-runner.ts";
import { initializeCodexProject } from "../src/services/project-initializer.ts";
import { ProjectPathPolicy } from "../src/services/project-paths.ts";
import { captureVerificationWorkspaceRevision } from "../src/services/verification-workspace.ts";
import { WorkflowService } from "../src/services/workflow-service.ts";

const now = "2026-08-20T12:00:00.000Z";

const validDeferredValidation = {
  id: "B-04",
  owner: "tester",
  phase: "verification",
  prerequisite: "实现完成且页面可运行后执行浏览器验证",
  targets: ["320x568", "650x800", "920x900", "1280x800"],
  checks: [
    "keyboard",
    "focus",
    "dynamic feedback",
    "naming progress",
    "non-color status",
    "contrast",
    "reduced-motion",
  ],
  pass_criteria: "关键操作无裁切且焦点顺序与恢复正确",
  evidence_required: "Playwright output and screenshot",
  evidence_types: ["browser-run", "screenshot"],
  on_fail: "block_verification",
  on_missing: "block_verification",
  status: "deferred",
  release_impact: "缺失或失败会阻止 Verification 通过",
} as const;

const declaredTargetsAndChecks = "320x568; 650x800; 920x900; 1280x800; keyboard; focus; dynamic feedback; naming progress; non-color status; contrast; reduced-motion";

test("AC-DES-LOOP-001/003: negated or unavailable implementation wording never creates a deferred obligation", () => {
  const negatedPrerequisites = [
    "Do not wait for implementation to be ready; validate the current prototype now.",
    "The implementation is unavailable, so inspect the existing design now.",
    "The implementation is not ready; this check remains Designer work.",
    "The implementation is never ready; validate the current prototype instead.",
    "Implementation ready is not required; validate the current prototype now.",
    "实现无需完成，现在验证现有设计稿。",
    "实现尚未完成，先验证当前原型。",
    "不必等页面可运行，现在完成键盘检查。",
  ];

  for (const nextAction of negatedPrerequisites) {
    assert.equal(
      isDeferredDesignVerification({
        id: "B-04",
        decision: "Validate responsive and accessibility behavior",
        owner: "Designer",
        nextAction,
      }),
      false,
      `must remain current Designer work: ${nextAction}`,
    );
    const assessment = assessDeferredDesignValidations([{
      ...validDeferredValidation,
      prerequisite: nextAction,
    }]);
    assert.equal(assessment.entries.length, 0, `negated prerequisite must not enter the ledger: ${nextAction}`);
    assert.equal(
      assessment.errors.some((issue) => /runnable implementation prerequisite/u.test(issue)),
      true,
      `ledger must fail closed for: ${nextAction}`,
    );
  }

  assert.equal(
    isDeferredDesignVerification({
      id: "B-04",
      decision: "验证响应式与无障碍行为",
      owner: "Designer",
      nextAction: "实现完成且页面可运行后执行浏览器验证",
    }),
    true,
  );
  const valid = assessDeferredDesignValidations([validDeferredValidation]);
  assert.deepEqual(valid.errors, []);
  assert.deepEqual(valid.entries.map(({ id }) => id), ["B-04"]);
});

test("AC-DES-LOOP-001: a Product decision cannot become deferred merely because its B-04 timing mentions implementation", () => {
  assert.equal(
    isDeferredDesignVerification({
      id: "B-04",
      owner: "Human product owner",
      decision: "Choose final launch copy",
      nextAction: "Decide when implementation is ready",
    }),
    false,
  );
});

test("AC-DES-LOOP-001: Product words containing test are not runtime verification obligations", () => {
  const decisions = [
    "Choose the latest launch copy",
    "Finalize contest copy",
    "Confirm protest policy",
    "Select the greatest asset",
  ];

  for (const decision of decisions) {
    const blocker = {
      id: "B-04",
      owner: "Human product owner",
      decision,
      next_action: "Decide when implementation is ready",
    };
    assert.equal(
      isDeferredDesignVerification({
        id: blocker.id,
        owner: blocker.owner,
        decision: blocker.decision,
        nextAction: blocker.next_action,
      }),
      false,
      decision,
    );
    const gate = assessPhaseHumanDecisionGate({
      phaseId: "design",
      phaseStatus: "awaiting_review",
      artifacts: [{
        artifactKey: "design-spec",
        content: `\`\`\`json\n${JSON.stringify({
          status: "blocked",
          blockers: [blocker],
          open_questions: [],
        })}\n\`\`\``,
      }],
    });
    const item = gate.items.find(({ id }) => id === "B-04");
    assert.equal(item?.kind, "dependency", decision);
    assert.equal(item?.blocking, true, decision);
  }
});

test("AC-DES-LOOP-001: a mixed now-and-later legacy B-04 keeps its current Designer work blocking", () => {
  const mixedTimingActions = [
    "现在用现有原型验证键盘与焦点；实现完成后再复测",
    "实现完成后再复测；现在用现有原型验证键盘与焦点",
    "After implementation is ready, rerun the checks; meanwhile test the current prototype now.",
  ];

  for (const nextAction of mixedTimingActions) {
    assert.equal(
      isDeferredDesignVerification({
        id: "B-04",
        decision: "验证键盘、焦点与最终实现一致性",
        owner: "Designer",
        nextAction,
      }),
      false,
      `a later retest must not erase the independently executable current validation: ${nextAction}`,
    );
  }
});

test("AC-DES-LOOP-001/003: explicit runnable prerequisites are not rejected merely for saying immediately or current page", () => {
  const legitimatePrerequisites = [
    "实现完成且页面可运行后立即验证键盘与焦点。",
    "When the implementation is ready, immediately verify keyboard and focus.",
    "Once the app is runnable, use the current page to test keyboard focus.",
  ];

  for (const prerequisite of legitimatePrerequisites) {
    assert.equal(
      isDeferredDesignVerification({
        id: "B-04",
        owner: "Designer",
        decision: "Verify keyboard and focus behavior",
        nextAction: prerequisite,
      }),
      true,
      `must remain deferred: ${prerequisite}`,
    );
    const assessment = assessDeferredDesignValidations([{
      ...validDeferredValidation,
      prerequisite,
    }]);
    assert.deepEqual(assessment.errors, [], `formal ledger must accept: ${prerequisite}`);
    assert.deepEqual(assessment.entries.map(({ id }) => id), ["B-04"]);
  }
});

test("AC-DES-LOOP-003: formal deferred ledgers require exact fail/missing dispositions and declared evidence types", () => {
  const invalidMachineFields: Array<[string, unknown]> = [
    ["on_fail", undefined],
    ["on_fail", "warn_only"],
    ["on_fail", "block_release"],
    ["on_missing", undefined],
    ["on_missing", "allow_approval"],
    ["on_missing", "block_release"],
    ["evidence_types", undefined],
    ["evidence_types", []],
    ["evidence_types", ["browser-run", "video"]],
    ["evidence_types", "browser-run"],
  ];

  for (const [field, value] of invalidMachineFields) {
    const candidate: Record<string, unknown> = { ...validDeferredValidation };
    if (value === undefined) delete candidate[field];
    else candidate[field] = value;
    const assessment = assessDeferredDesignValidations([candidate]);
    assert.equal(
      assessment.entries.length,
      0,
      `${field}=${JSON.stringify(value)} must not enter the formal ledger`,
    );
    assert.equal(assessment.errors.length > 0, true);
  }
});

test("AC-DES-LOOP-003: observable no-scroll and keyboard-only pass criteria are not filler negations", () => {
  const legitimatePassCriteria = [
    "No horizontal scrolling is required at 320px",
    "No mouse is required; all controls work by keyboard",
    "320px 下无需横向滚动",
    "无需鼠标；所有控件均可通过键盘操作",
  ];

  for (const passCriteria of legitimatePassCriteria) {
    const assessment = assessDeferredDesignValidations([{
      ...validDeferredValidation,
      pass_criteria: passCriteria,
    }]);
    assert.deepEqual(assessment.errors, [], passCriteria);
    assert.deepEqual(assessment.entries.map(({ id }) => id), ["B-04"], passCriteria);
  }
});

test("AC-DES-LOOP-003: placeholder ledger fields and a non-blocking release impact are rejected", () => {
  const placeholderFields = [
    ["targets", ["???"]],
    ["checks", ["???"]],
    ["pass_criteria", "???"],
    ["evidence_required", "???"],
    ["release_impact", "???"],
  ] as const;

  for (const [field, value] of placeholderFields) {
    const assessment = assessDeferredDesignValidations([{
      ...validDeferredValidation,
      [field]: value,
    }]);
    assert.equal(assessment.entries.length, 0, `${field}=??? must not enter the ledger`);
    assert.equal(assessment.errors.length > 0, true, `${field}=??? must explain the contract error`);
  }

  const negatedContracts: Array<[string, unknown]> = [
    ["targets", ["not applicable"]],
    ["targets", ["不适用"]],
    ["checks", ["none needed"]],
    ["checks", ["无需检查"]],
    ["pass_criteria", "No pass criteria required"],
    ["pass_criteria", "无需通过标准"],
    ["evidence_required", "No evidence required"],
    ["evidence_required", "无需证据"],
    ["evidence_required", "不需要证据"],
  ];
  for (const [field, value] of negatedContracts) {
    const assessment = assessDeferredDesignValidations([{
      ...validDeferredValidation,
      [field]: value,
    }]);
    assert.equal(assessment.entries.length, 0, `${field}=${JSON.stringify(value)} must be rejected`);
    assert.equal(assessment.errors.length > 0, true);
  }

  for (const releaseImpact of [
    "Record the result for awareness.",
    "结果供后续团队参考。",
    "Failure does not block Verification.",
    "Missing evidence will not block Release.",
    "失败不会阻止 Verification 通过。",
  ]) {
    const assessment = assessDeferredDesignValidations([{
      ...validDeferredValidation,
      release_impact: releaseImpact,
    }]);
    assert.equal(
      assessment.entries.length,
      0,
      `release impact must say that failure or absence blocks Verification/Release: ${releaseImpact}`,
    );
    assert.equal(assessment.errors.length > 0, true);
  }
});

test("AC-DES-LOOP-003: a current Design revision cannot silently drop a deferred obligation from its parent", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-deferred-design-lineage-"));
  try {
    const legacyDeferred = [
      "# Design Specification",
      "",
      "```json",
      JSON.stringify({
        status: "blocked",
        blockers: [{
          id: "B-04",
          owner: "Designer",
          decision: "验证响应式、键盘与焦点行为",
          next_action: "实现完成且页面可运行后执行浏览器验证",
        }],
        open_questions: [],
      }, null, 2),
      "```",
    ].join("\n");
    const fixture = await designLineageFixture(parent, designSpec([]), legacyDeferred);

    const summary = await fixture.service.getHumanDecisions(fixture.runId);
    const designGate = summary.phases.find(({ phaseId }) => phaseId === "design");
    assert.ok(designGate);
    const blockers = designGate.items.filter(({ blocking }) => blocking);
    assert.equal(blockers.length, 1, "lineage loss must create one formal-cleanup blocker");
    assert.equal(blockers[0]?.id, "DESIGN-DEFERRED-VALIDATION-LOST");
    assert.equal(blockers[0]?.kind, "work");
    assert.match(`${blockers[0]?.prompt} ${blockers[0]?.nextAction}`, /B-04|deferred_validations|恢复|保留/iu);

    await assert.rejects(
      () => fixture.service.reviewPhase(fixture.runId, "design", {
        decision: "approve",
        comment: "The current revision must not erase its inherited runtime obligation.",
        expectedArtifactIds: [fixture.currentDesign.id],
      }),
      (error: unknown) => {
        const appError = error as { statusCode?: number; code?: string };
        assert.equal(appError.statusCode, 409);
        assert.equal(appError.code, "PHASE_HUMAN_DECISIONS_REQUIRED");
        return true;
      },
    );
    assert.equal(fixture.reviewCalls.length, 0);

    fixture.currentDesign.content = designSpec([validDeferredValidation]);
    const retained = await fixture.service.getHumanDecisions(fixture.runId);
    const retainedGate = retained.phases.find(({ phaseId }) => phaseId === "design");
    assert.equal(retainedGate?.items.some(({ id }) => id === "DESIGN-DEFERRED-VALIDATION-LOST"), false);
    assert.equal(retainedGate?.blockingCount, 0);
    assert.equal(retainedGate?.items.find(({ id }) => id === "B-04")?.blocking, false);

    await fixture.service.reviewPhase(fixture.runId, "design", {
      decision: "approve",
      comment: "B-04 remains explicitly handed to Verification in the current ledger.",
      expectedArtifactIds: [fixture.currentDesign.id],
    });
    assert.equal(fixture.reviewCalls.length, 1);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("AC-DES-LOOP-006: Verification approval closes every deferred design ID exactly once with real passing evidence", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-deferred-verification-pass-"));
  try {
    const fixture = await verificationFixture(parent, designSpec([
      validDeferredValidation,
      {
        ...validDeferredValidation,
        id: "DES-V-02",
        targets: ["650x800", "920x900"],
        checks: ["动态反馈", "非颜色状态", "reduced-motion"],
      },
    ]), validTestReport());

    await fixture.service.reviewPhase(fixture.runId, "verification", {
      decision: "approve",
      comment: "Independent browser evidence passes every deferred design obligation.",
      expectedArtifactIds: [fixture.testReport.id],
    });

    assert.equal(fixture.reviewCalls.length, 1);
    assert.equal(fixture.reviewCalls[0]?.[2], "approve");
    assert.equal(fixture.verification.status, "approved");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("AC-DES-LOOP-006: the same browser or accessibility obligation may recover through an explicit evidenced rerun", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-deferred-verification-rerun-"));
  try {
    const fixture = await verificationFixture(parent, designSpec([
      validDeferredValidation,
    ]), deferredSection([
      evidenceRow(
        "B-04",
        "pass",
        "Initial B-04 browser-run 920 was unavailable. The same B-04 browser obligation rerun 921 after environment recovery completed every declared target and check with pass; Playwright browser-run output artifacts/b04-rerun.json and screenshot artifacts/b04-rerun.png",
      ),
    ]));

    await fixture.service.reviewPhase(fixture.runId, "verification", {
      decision: "approve",
      comment: "The same browser obligation has durable passing rerun evidence.",
      expectedArtifactIds: [fixture.testReport.id],
    });
    assert.equal(fixture.reviewCalls.length, 1);

    fixture.resetApproval();
    fixture.setTestReport(deferredSection([
      evidenceRow(
        "B-04",
        "pass",
        "Initial B-04 accessibility run found a critical violation. The same B-04 accessibility obligation rerun 923 after the fix passed with zero remaining violations; Playwright browser-run output artifacts/b04-a11y-rerun.json and screenshot artifacts/b04-a11y-rerun.png",
      ),
    ]));
    await fixture.service.reviewPhase(fixture.runId, "verification", {
      decision: "approve",
      comment: "The same accessibility obligation has durable passing rerun evidence after the fix.",
      expectedArtifactIds: [fixture.testReport.id],
    });
    assert.equal(fixture.reviewCalls.length, 1);

    fixture.resetApproval();
    fixture.setTestReport(deferredSection([
      evidenceRow(
        "B-04",
        "pass",
        "Playwright 浏览器运行 run-913；截图 artifacts/b04-zh.png；axe 无障碍报告 artifacts/axe-zh.json：无错误、零项错误、0项错误、无严重违规、未发现高危违规",
      ),
    ]));
    await fixture.service.reviewPhase(fixture.runId, "verification", {
      decision: "approve",
      comment: "中文零错误与无严重违规证据同样是明确的成功结果。",
      expectedArtifactIds: [fixture.testReport.id],
    });
    assert.equal(fixture.reviewCalls.length, 1);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("AC-DES-LOOP-006: explicit zero-error and no-violation browser evidence remains passing", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-deferred-verification-zero-errors-"));
  try {
    const fixture = await verificationFixture(parent, designSpec([
      validDeferredValidation,
    ]), deferredSection([
      evidenceRow(
        "B-04",
        "pass",
        "Playwright browser run 912 screenshot artifacts/b04.png; axe accessibility report artifacts/axe.json found zero errors and no critical violations",
      ),
    ]));

    await fixture.service.reviewPhase(fixture.runId, "verification", {
      decision: "approve",
      comment: "The browser and accessibility evidence explicitly reports zero errors and no critical violations.",
      expectedArtifactIds: [fixture.testReport.id],
    });
    assert.equal(fixture.reviewCalls.length, 1);

    fixture.resetApproval();
    fixture.setTestReport(deferredSection([
      evidenceRow(
        "B-04",
        "pass",
        "Playwright browser run 913 completed with no errors; output artifacts/b04-success.json and screenshot artifacts/b04-success.png",
      ),
    ]));
    await fixture.service.reviewPhase(fixture.runId, "verification", {
      decision: "approve",
      comment: "The browser run completed with no errors and durable output.",
      expectedArtifactIds: [fixture.testReport.id],
    });
    assert.equal(fixture.reviewCalls.length, 1);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("AC-DES-LOOP-006: missing, duplicate, non-passing, or placeholder deferred evidence fails before persistence", async (context) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-deferred-verification-reject-"));
  try {
    const fixture = await verificationFixture(parent, designSpec([
      validDeferredValidation,
      { ...validDeferredValidation, id: "DES-V-02" },
    ]), validTestReport());
    const invalidReports = new Map<string, string>([
      ["missing section", [
        "# Test Report",
        "## Acceptance and regression results",
        "| Criterion | Evidence | Result |",
        "|---|---|---|",
        "| CC-AC-001 | node --test passed with run 123 | pass |",
      ].join("\n")],
      ["missing ledger ID", deferredSection([
        evidenceRow("B-04", "pass"),
      ])],
      ["duplicate ledger ID", deferredSection([
        evidenceRow("B-04", "pass"),
        evidenceRow("B-04", "pass", "second independent screenshot artifacts/b04-duplicate.png"),
        evidenceRow("DES-V-02", "pass"),
      ])],
      ...["fail", "blocked", "untested", "passed", "pass with warnings", "通过（部分）"].map((result) => [
        `result=${result}`,
        deferredSection([
          evidenceRow("B-04", result),
          evidenceRow("DES-V-02", "pass"),
        ]),
      ] as [string, string]),
      ["empty evidence", deferredSection([
        evidenceRow("B-04", "pass", ""),
        evidenceRow("DES-V-02", "pass"),
      ])],
      ["TBD evidence", deferredSection([
        evidenceRow("B-04", "pass", "TBD"),
        evidenceRow("DES-V-02", "pass"),
      ])],
      ["template evidence", deferredSection([
        evidenceRow("B-04", "pass", "<screenshot or tool output>"),
        evidenceRow("DES-V-02", "pass"),
      ])],
      ["mustache evidence", deferredSection([
        evidenceRow("B-04", "pass", "{{ evidence }}"),
        evidenceRow("DES-V-02", "pass"),
      ])],
      ["embedded TODO evidence", deferredSection([
        evidenceRow("B-04", "pass", "TODO: attach the browser screenshot after the run"),
        evidenceRow("DES-V-02", "pass"),
      ])],
      ["TBD screenshot later", deferredSection([
        evidenceRow("B-04", "pass", "TBD screenshot later"),
        evidenceRow("DES-V-02", "pass"),
      ])],
      ["evidence pending", deferredSection([
        evidenceRow("B-04", "pass", "evidence pending"),
        evidenceRow("DES-V-02", "pass"),
      ])],
      ["question-mark evidence", deferredSection([
        evidenceRow("B-04", "pass", "????????"),
        evidenceRow("DES-V-02", "pass"),
      ])],
      ["not-run prose disguised as evidence", deferredSection([
        evidenceRow("B-04", "pass", "Not run because the browser environment is unavailable"),
        evidenceRow("DES-V-02", "pass"),
      ])],
      ["browser unavailable and zero checks", deferredSection([
        evidenceRow("B-04", "pass", "Browser unavailable; zero checks executed"),
        evidenceRow("DES-V-02", "pass"),
      ])],
      ["Playwright failed before checks", deferredSection([
        evidenceRow("B-04", "pass", "Playwright failed before checks ran"),
        evidenceRow("DES-V-02", "pass"),
      ])],
      ["exit 1", deferredSection([
        evidenceRow("B-04", "pass", "Playwright command exited with exit 1 before evidence capture"),
        evidenceRow("DES-V-02", "pass"),
      ])],
      ["critical violations", deferredSection([
        evidenceRow("B-04", "pass", "Browser audit found critical accessibility violations"),
        evidenceRow("DES-V-02", "pass"),
      ])],
      ["browser crashed", deferredSection([
        evidenceRow("B-04", "pass", "Browser crashed before responsive checks completed"),
        evidenceRow("DES-V-02", "pass"),
      ])],
      ["browser wasn't run", deferredSection([
        evidenceRow("B-04", "pass", "Playwright browser wasn't run because Chrome is absent; screenshot artifacts/b04.png"),
        evidenceRow("DES-V-02", "pass"),
      ])],
      ["browser could not start", deferredSection([
        evidenceRow("B-04", "pass", "Playwright browser could not start because Chrome is absent; screenshot artifacts/b04.png"),
        evidenceRow("DES-V-02", "pass"),
      ])],
      ["browser did not execute", deferredSection([
        evidenceRow("B-04", "pass", "Playwright browser did not execute; screenshot artifacts/b04.png"),
        evidenceRow("DES-V-02", "pass"),
      ])],
      ["browser execution was impossible", deferredSection([
        evidenceRow("B-04", "pass", "Browser execution was impossible; screenshot artifacts/b04.png"),
        evidenceRow("DES-V-02", "pass"),
      ])],
      ["browser failure hidden by unrelated unit rerun", deferredSection([
        evidenceRow(
          "B-04",
          "pass",
          "Browser unavailable; rerun unit tests passed. Playwright output artifacts/unit.json and screenshot artifacts/unit.png",
        ),
        evidenceRow("DES-V-02", "pass"),
      ])],
      ["critical a11y failure hidden by unrelated smoke rerun", deferredSection([
        evidenceRow(
          "B-04",
          "pass",
          "Critical accessibility violations; subsequently rerun unrelated smoke test passed. Playwright output artifacts/smoke.json and screenshot artifacts/smoke.png",
        ),
        evidenceRow("DES-V-02", "pass"),
      ])],
      ["token boundary 1320x568 and unfocused", deferredSection([
        evidenceRow(
          "B-04",
          "pass",
          "abcdefgh",
          declaredTargetsAndChecks
            .replace("320x568", "1320x568")
            .replace("focus", "unfocused"),
        ),
        evidenceRow("DES-V-02", "pass"),
      ])],
      ["token boundary 320x5680 and autofocus", deferredSection([
        evidenceRow(
          "B-04",
          "pass",
          "Playwright output artifacts/b04.json and screenshot artifacts/b04.png",
          declaredTargetsAndChecks
            .replace("320x568", "320x5680")
            .replace("focus", "autofocus"),
        ),
        evidenceRow("DES-V-02", "pass"),
      ])],
      ["weak evidence abcdefgh", deferredSection([
        evidenceRow("B-04", "pass", "abcdefgh"),
        evidenceRow("DES-V-02", "pass"),
      ])],
      ["weak evidence Looks good", deferredSection([
        evidenceRow("B-04", "pass", "Looks good"),
        evidenceRow("DES-V-02", "pass"),
      ])],
      ["weak evidence Manual check done", deferredSection([
        evidenceRow("B-04", "pass", "Manual check done"),
        evidenceRow("DES-V-02", "pass"),
      ])],
      ["missing declared screenshot evidence type", deferredSection([
        evidenceRow("B-04", "pass", "Playwright output artifacts/b04-results.json confirms every declared check passed"),
        evidenceRow("DES-V-02", "pass"),
      ])],
      ["missing declared browser-run evidence type", deferredSection([
        evidenceRow("B-04", "pass", "Screenshot artifacts/b04.png shows the final rendered page"),
        evidenceRow("DES-V-02", "pass"),
      ])],
      ["targets report says not tested", deferredSection([
        evidenceRow(
          "B-04",
          "pass",
          undefined,
          declaredTargetsAndChecks.replace("320x568", "320x568 not tested"),
        ),
        evidenceRow("DES-V-02", "pass"),
      ])],
      ["checks report says failed", deferredSection([
        evidenceRow(
          "B-04",
          "pass",
          undefined,
          declaredTargetsAndChecks.replace("focus", "focus failed"),
        ),
        evidenceRow("DES-V-02", "pass"),
      ])],
      ["placeholder targets", deferredSection([
        evidenceRow("B-04", "pass", undefined, "???"),
        evidenceRow("DES-V-02", "pass"),
      ])],
      ["missing declared target 320x568", deferredSection([
        evidenceRow(
          "B-04",
          "pass",
          undefined,
          "650x800; 920x900; 1280x800; keyboard; focus; dynamic feedback; naming progress; non-color status; contrast; reduced-motion",
        ),
        evidenceRow("DES-V-02", "pass"),
      ])],
      ["missing declared keyboard check", deferredSection([
        evidenceRow(
          "B-04",
          "pass",
          undefined,
          "320x568; 650x800; 920x900; 1280x800; focus; dynamic feedback; naming progress; non-color status; contrast; reduced-motion",
        ),
        evidenceRow("DES-V-02", "pass"),
      ])],
      ["missing declared focus check", deferredSection([
        evidenceRow(
          "B-04",
          "pass",
          undefined,
          "320x568; 650x800; 920x900; 1280x800; keyboard; dynamic feedback; naming progress; non-color status; contrast; reduced-motion",
        ),
        evidenceRow("DES-V-02", "pass"),
      ])],
    ]);

    for (const [label, content] of invalidReports) {
      await context.test(label, async () => {
        fixture.resetApproval();
        fixture.setTestReport(content);
        await assert.rejects(
          () => fixture.service.reviewPhase(fixture.runId, "verification", {
            decision: "approve",
            comment: `Must reject invalid deferred verification evidence: ${label}.`,
            expectedArtifactIds: [fixture.testReport.id],
          }),
          (error: unknown) => {
            assert.equal((error as { statusCode?: number }).statusCode, 409, label);
            assert.equal(
              (error as { code?: string }).code,
              "DEFERRED_DESIGN_VERIFICATION_GATE_FAILED",
              label,
            );
            return true;
          },
          label,
        );
        assert.equal(fixture.reviewCalls.length, 0, `${label} must fail before approval persistence`);
        assert.equal(fixture.verification.status, "awaiting_review", label);
      });
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("AC-DES-LOOP-006: an existing design-spec without its machine contract cannot masquerade as a valid Design skip", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-deferred-verification-no-envelope-"));
  try {
    const fixture = await verificationFixture(
      parent,
      "# Design Specification\n\nThe machine-readable handoff was accidentally omitted.\n",
      validTestReport(),
    );
    await assert.rejects(
      () => fixture.service.reviewPhase(fixture.runId, "verification", {
        decision: "approve",
        comment: "An existing Design artifact needs an explicit valid contract.",
        expectedArtifactIds: [fixture.testReport.id],
      }),
      (error: unknown) => {
        const appError = error as { statusCode?: number; code?: string };
        assert.equal(appError.statusCode, 409);
        assert.equal(appError.code, "DEFERRED_DESIGN_VERIFICATION_GATE_FAILED");
        return true;
      },
    );
    assert.equal(fixture.reviewCalls.length, 0);
    assert.equal(fixture.verification.status, "awaiting_review");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("AC-DES-LOOP-006: no applicable design-spec or an empty deferred ledger does not invent a Verification blocker", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-deferred-verification-empty-"));
  try {
    const fixture = await verificationFixture(parent, null, deferredSection([]));
    await fixture.service.reviewPhase(fixture.runId, "verification", {
      decision: "approve",
      comment: "The valid Design skip has no deferred design obligations.",
      expectedArtifactIds: [fixture.testReport.id],
    });
    assert.equal(fixture.reviewCalls.length, 1, "a valid Design skip has nothing to close");

    fixture.resetApproval();
    fixture.setDesignSpec(designSpec([]));
    await fixture.service.reviewPhase(fixture.runId, "verification", {
      decision: "approve",
      comment: "The explicit deferred ledger is empty.",
      expectedArtifactIds: [fixture.testReport.id],
    });
    assert.equal(fixture.reviewCalls.length, 1, "an empty ledger has nothing to close");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

function designSpec(deferredValidations: readonly object[]): string {
  return [
    "# Design Specification",
    "",
    "```json",
    JSON.stringify({
      status: "ready-for-engineering",
      blockers: [],
      open_questions: [],
      deferred_validations: deferredValidations,
    }, null, 2),
    "```",
  ].join("\n");
}

function validTestReport(): string {
  return deferredSection([
    evidenceRow(
      "B-04",
      "pass",
      "Playwright browser-run 912 output artifacts/b04-results.json and screenshot artifacts/b-04-320.png; focus order and restoration matched the declared sequence",
    ),
    evidenceRow(
      "DES-V-02",
      "通过",
      "Playwright browser-run 913 output artifacts/des-v-02.json and screenshot artifacts/des-v-02.png; live state and reduced-motion behavior matched the spec",
      "650x800; 920x900; 动态反馈; 非颜色状态; reduced-motion",
    ),
  ]);
}

function deferredSection(rows: string[]): string {
  return [
    "# Test Report",
    "",
    "## Status and recommendation",
    "",
    "- **Verification state:** Ready for release review",
    "- **Release recommendation:** Current evidence supports human release review.",
    "- **Current revision:** commit abc123def",
    "",
    "## E2E Stage 2: Crystallization",
    "",
    "- **E2E script required:** yes — deferred browser obligations require a durable repository check",
    "",
    "## E2E Stage 3: Execution",
    "",
    "| Execution | Exact command and working directory | Revision and environment | Result | Durable evidence |",
    "|---|---|---|---|---|",
    "| local standalone | `npx playwright test tests/e2e/deferred-design.spec.ts` from `/workspace/app` | commit abc123def; Chromium | pass; exit code 0 | artifacts/playwright-report/index.html; local run ID deferred-912 |",
    "",
    "## Deferred design verification",
    "",
    "| Obligation ID | Targets and checks | Real evidence | Result | Defect / owner / release impact |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    "## Coverage gaps",
    "",
    "- None",
  ].join("\n");
}

function bindDeferredReportToExecution(content: string, input: {
  projectRoot: string;
  executionId: string;
  workspaceRevisionToken: string;
  evidenceHash: string;
}): string {
  const revision = `git state:not-repository; workspace sha256:${input.workspaceRevisionToken}; platform execution ${input.executionId}`;
  return content
    .replace(
      "- **Current revision:** commit abc123def",
      `- **Current revision:** ${revision}\n- **Platform execution ID:** ${input.executionId}`,
    )
    .replaceAll("commit abc123def", revision)
    .replaceAll("/workspace/app", input.projectRoot)
    .replaceAll(
      "artifacts/playwright-report/index.html",
      `playwright-report/index.html sha256:${input.evidenceHash}`,
    );
}

function executionEvent(
  executionId: string,
  sequence: number,
  eventType: string,
  payload: unknown,
) {
  return {
    id: randomUUID(),
    executionId,
    sequence,
    eventType,
    payload,
    createdAt: now,
  };
}

function evidenceRow(
  id: string,
  result: string,
  evidence = "Playwright browser-run 912 output artifacts/browser-report.json and screenshot artifacts/screenshot.png; expected behavior observed",
  targetsAndChecks = declaredTargetsAndChecks,
): string {
  return `| ${id} | ${targetsAndChecks} | ${evidence} | ${result} | None |`;
}

async function designLineageFixture(
  parent: string,
  currentContent: string,
  parentContent: string,
) {
  const requestedRoot = path.join(parent, "sample");
  await initializeCodexProject(requestedRoot, "Deferred Design lineage", "Preserve runtime obligations across revisions");
  const rootPath = await realpath(requestedRoot);
  const project: ProjectDto = {
    id: randomUUID(),
    name: "Deferred Design lineage",
    summary: "Preserve runtime obligations across revisions",
    rootPath,
    configPath: path.join(rootPath, "ai-native.yaml"),
    runCount: 1,
    createdAt: now,
    updatedAt: now,
  };
  const run = {
    id: randomUUID(),
    projectId: project.id,
    title: "Preserve Design obligations",
    objective: "Prevent a revision from silently dropping deferred verification",
    status: "active" as const,
    createdAt: now,
    updatedAt: now,
  };
  const discovery = phase(run.id, "discovery", 0, "approved");
  const design = phase(run.id, "design", 1, "awaiting_review");
  const architecture = phase(run.id, "architecture", 2, "pending");
  const prd = artifact(discovery.id, "prd", "docs/prd.md", [
    "# Product Requirements",
    "",
    "**Status:** Ready for human review",
    "",
    "## Open questions for a human",
    "",
    "None.",
  ].join("\n"));
  prd.reviewStatus = "approved";
  const architectureArtifact = artifact(
    architecture.id,
    "architecture",
    "docs/architecture.md",
    "# Architecture\n\n**Status:** Ready for human acceptance\n",
  );
  const parentDesign = artifact(design.id, "design-spec", "docs/design-spec.md", parentContent);
  parentDesign.revision = 1;
  parentDesign.reviewStatus = "superseded";
  const currentDesign = artifact(design.id, "design-spec", "docs/design-spec.md", currentContent);
  currentDesign.revision = 2;
  currentDesign.reviewStatus = "pending";
  currentDesign.parentArtifactId = parentDesign.id;
  discovery.artifacts = [prd];
  design.artifacts = [currentDesign];
  architecture.artifacts = [architectureArtifact];
  const phases = [discovery, design, architecture];
  const artifactsById = new Map([
    [prd.id, prd],
    [architectureArtifact.id, architectureArtifact],
    [parentDesign.id, parentDesign],
    [currentDesign.id, currentDesign],
  ]);
  const reviewCalls: unknown[][] = [];
  const fakeStore = {
    getRun: async () => ({ project, run, phases, artifactPaths: {} }),
    getArtifact: async (id: string) => {
      const selected = artifactsById.get(id);
      assert.ok(selected, `missing fixture artifact ${id}`);
      return selected;
    },
    currentArtifactSnapshotsForPhase: async (_runId: string, phaseId: PhaseId) => {
      const selected = phases.find((candidate) => candidate.phaseId === phaseId);
      return selected?.artifacts.map((candidate) => ({
        ...candidate,
        content: candidate.content ?? "",
      })) ?? [];
    },
    reviewPhase: async (...args: unknown[]) => {
      reviewCalls.push(args);
      const selected = phases.find(({ phaseId }) => phaseId === args[1]);
      assert.ok(selected);
      const review: ReviewDto = {
        id: randomUUID(),
        phaseRunId: selected.id,
        decision: args[2] as "approve" | "request_changes",
        comment: String(args[3]),
        artifactIds: args[4] as string[],
        createdAt: now,
      };
      selected.reviews.unshift(review);
      selected.status = review.decision === "approve" ? "approved" : "changes_requested";
      return review;
    },
  };
  return {
    service: new WorkflowService(
      fakeStore as unknown as PgWorkflowStore,
      new ProjectPathPolicy([parent]),
      new CodexTerminalRunner({ fake: true }),
    ),
    runId: run.id,
    currentDesign,
    reviewCalls,
  };
}

async function verificationFixture(
  parent: string,
  initialDesignSpec: string | null,
  initialTestReport: string,
) {
  const requestedRoot = path.join(parent, "sample");
  await initializeCodexProject(requestedRoot, "Deferred verification", "Verification closure gate");
  const rootPath = await realpath(requestedRoot);
  const executionId = randomUUID();
  const testCommand = "npx playwright test tests/e2e/deferred-design.spec.ts";
  const commandLabel = "codex verification --json";
  const evidenceContent = "verified deferred-design Playwright report\n";
  const evidenceHash = createHash("sha256").update(evidenceContent).digest("hex");
  await mkdir(path.join(rootPath, "playwright-report"), { recursive: true });
  await writeFile(path.join(rootPath, "playwright-report", "index.html"), evidenceContent, "utf8");
  const workspaceRevision = await captureVerificationWorkspaceRevision({
    projectRoot: rootPath,
    selectedOutputPaths: [path.join(rootPath, "docs", "test-report.md")],
  });
  const bindTestReport = (content: string) => bindDeferredReportToExecution(content, {
    projectRoot: rootPath,
    executionId,
    workspaceRevisionToken: workspaceRevision.token,
    evidenceHash,
  });
  const project: ProjectDto = {
    id: randomUUID(),
    name: "Deferred verification",
    summary: "Verification closure gate",
    rootPath,
    configPath: path.join(rootPath, "ai-native.yaml"),
    runCount: 1,
    createdAt: now,
    updatedAt: now,
  };
  const run = {
    id: randomUUID(),
    projectId: project.id,
    title: "Close deferred design verification",
    objective: "Require passing runtime evidence before Verification approval",
    status: "active" as const,
    createdAt: now,
    updatedAt: now,
  };
  const designPhase = phase(run.id, "design", 1, "approved");
  const verification = phase(run.id, "verification", 4, "awaiting_review");
  const designArtifact = artifact(designPhase.id, "design-spec", "docs/design-spec.md", initialDesignSpec ?? "");
  const testReport = artifact(
    verification.id,
    "test-report",
    "docs/test-report.md",
    bindTestReport(initialTestReport),
  );
  if (initialDesignSpec !== null) designPhase.artifacts = [designArtifact];
  verification.artifacts = [testReport];
  verification.executions = [{
    id: executionId,
    phaseRunId: verification.id,
    status: "completed",
    selectedArtifactIds: [],
    selectedOutputKeys: ["test-report"],
    runnerMode: "real",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    command: commandLabel,
    exitCode: 0,
    error: null,
    startedAt: now,
    finishedAt: now,
    createdAt: now,
  }];
  verification.events = [
    executionEvent(executionId, 1, "runner.started", {
      mode: "real",
      phaseId: "verification",
      command: commandLabel,
      workingDirectory: rootPath,
      workspaceRevisionToken: workspaceRevision.token,
      verificationGitState: { kind: "not_repository" },
    }),
    executionEvent(executionId, 2, "item.completed", {
      type: "item.completed",
      item: {
        type: "command_execution",
        status: "completed",
        exit_code: 0,
        commandHash: createHash("sha256").update(testCommand).digest("hex"),
      },
    }),
    executionEvent(executionId, 3, "runner.completed", { exitCode: 0 }),
  ];
  const phases = [designPhase, verification];
  const reviewCalls: unknown[][] = [];
  const fakeStore = {
    getRun: async () => ({ project, run, phases, artifactPaths: {} }),
    currentArtifactSnapshotsForPhase: async (_runId: string, phaseId: PhaseId) => {
      const selected = phases.find((candidate) => candidate.phaseId === phaseId);
      return selected?.artifacts.map((candidate) => ({
        ...candidate,
        content: candidate.content ?? "",
        executionId: candidate.artifactKey === "test-report" ? executionId : null,
      })) ?? [];
    },
    reviewPhase: async (...args: unknown[]) => {
      reviewCalls.push(args);
      const selected = phases.find(({ phaseId }) => phaseId === args[1]);
      assert.ok(selected);
      const review: ReviewDto = {
        id: randomUUID(),
        phaseRunId: selected.id,
        decision: args[2] as "approve" | "request_changes",
        comment: String(args[3]),
        artifactIds: args[4] as string[],
        createdAt: now,
      };
      selected.reviews.unshift(review);
      selected.status = review.decision === "approve" ? "approved" : "changes_requested";
      return review;
    },
  };
  const service = new WorkflowService(
    fakeStore as unknown as PgWorkflowStore,
    new ProjectPathPolicy([parent]),
    new CodexTerminalRunner({ fake: true }),
  );
  return {
    service,
    runId: run.id,
    designArtifact,
    testReport,
    verification,
    reviewCalls,
    setDesignSpec(content: string | null) {
      designArtifact.content = content ?? "";
      designPhase.artifacts = content === null ? [] : [designArtifact];
    },
    setTestReport(content: string) {
      testReport.content = bindTestReport(content);
      testReport.contentHash = createHash("sha256").update(testReport.content).digest("hex");
    },
    resetApproval() {
      verification.status = "awaiting_review";
      verification.reviews = [];
      reviewCalls.length = 0;
    },
  };
}

function phase(
  workflowRunId: string,
  phaseId: PhaseId,
  position: number,
  status: PhaseRunDto["status"],
): PhaseRunDto {
  return {
    id: randomUUID(),
    workflowRunId,
    phaseId,
    position,
    status,
    artifacts: [],
    reviews: [],
    executions: [],
    events: [],
    availableArtifacts: [],
    createdAt: now,
    updatedAt: now,
  };
}

function artifact(
  phaseRunId: string,
  artifactKey: string,
  filePath: string,
  content: string,
): ArtifactDto {
  return {
    id: randomUUID(),
    phaseRunId,
    artifactKey,
    filePath,
    content,
    contentHash: createHash("sha256").update(content).digest("hex"),
    reviewStatus: artifactKey === "design-spec" ? "approved" : "pending",
    revision: 1,
    revisionSource: "ai",
    parentArtifactId: null,
    createdAt: now,
  };
}
