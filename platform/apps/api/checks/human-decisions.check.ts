import assert from "node:assert/strict";
import test from "node:test";

import { AppError } from "../src/domain/errors.ts";
import {
  assessPhaseHumanDecisionGate,
  assertPhaseHumanDecisionGateReady,
  humanDecisionSummary,
  parseHumanDecisionCapture,
  serializeHumanDecisionCapture,
} from "../src/domain/human-decisions.ts";

const validDeferredValidation = {
  id: "B-04",
  owner: "tester",
  phase: "verification",
  prerequisite: "实现完成且页面可运行、浏览器环境可用",
  targets: ["320x568", "1280x800"],
  checks: ["键盘与焦点", "responsive layout"],
  pass_criteria: "关键操作无裁切且键盘顺序与焦点恢复正确",
  evidence_required: "Tester 在 test-report 记录 viewport、步骤和结果",
  evidence_types: ["browser-run", "screenshot"],
  on_fail: "block_verification",
  on_missing: "block_verification",
  status: "deferred",
  release_impact: "缺失或失败会阻止 Verification 通过",
};

test("AC-CLARITY-014/018: an approved Product phase exposes five decisions as an inconsistency", () => {
  const gate = assessPhaseHumanDecisionGate({
    phaseId: "discovery",
    phaseStatus: "approved",
    artifacts: [{
      artifactKey: "prd",
      content: `# PRD

**Status:** Pending human decisions; not ready for downstream phase

## Open questions for a human

- [ ] How many levels exist and what completes one?
- [ ] Is access free, recommended, or locked?
- [ ] Is reading visual, audio, or spoken?
- [ ] Does progress survive refresh?
- [ ] What are the priorities and success targets?
`,
    }],
  });
  assert.equal(gate.state, "inconsistent_approval");
  assert.equal(gate.blockingCount, 5);
  assert.equal(gate.decisionCount, 5);
  assert.equal(gate.items[0]?.id, "PROD-Q-01");
  assert.equal(gate.items[0]?.actionPhaseId, "discovery");
});

test("AC-CLARITY-014/016: Design separates upstream dependencies from Designer-owned work", () => {
  const gate = assessPhaseHumanDecisionGate({
    phaseId: "design",
    phaseStatus: "awaiting_review",
    artifacts: [{
      artifactKey: "design-spec",
      content: `
\`\`\`json
{
  "status": "blocked",
  "open_questions": [],
  "deferred_validations": [],
  "blockers": [
    {"id":"B-01","decision":"Confirm level catalog","owner":"Human product owner","next_action":"Update PRD"},
    {"id":"B-02","decision":"Confirm access policy","owner":"Human product owner","next_action":"Update PRD"},
    {"id":"B-03","decision":"Confirm task modality","owner":"Human product owner","next_action":"Update PRD"},
    {"id":"B-04","decision":"Validate 320px and accessibility","owner":"Designer","next_action":"Attach rendered evidence"}
  ]
}
\`\`\`
`,
    }],
  });
  assert.equal(gate.blockingCount, 4);
  assert.equal(gate.dependencyCount, 3);
  assert.equal(gate.workCount, 1);
  assert.equal(gate.items.find(({ id }) => id === "B-01")?.actionPhaseId, "discovery");
  assert.equal(gate.items.find(({ id }) => id === "B-04")?.actionPhaseId, "design");
});

test("AC-CLARITY-019: post-implementation B-04 verification stays visible without blocking Design", () => {
  const deferred = assessPhaseHumanDecisionGate({
    phaseId: "design",
    phaseStatus: "awaiting_review",
    artifacts: [{
      artifactKey: "design-spec",
      content: `
\`\`\`json
{
  "status": "ready-for-engineering",
  "open_questions": [],
  "blockers": [],
  "deferred_validations": [
    {
      "id": "B-04",
      "owner": "tester",
      "phase": "verification",
      "prerequisite": "实现完成且页面可运行、浏览器环境可用",
      "targets": ["320x568", "1280x800"],
      "checks": ["键盘与焦点", "responsive layout"],
      "pass_criteria": "关键操作无裁切且键盘顺序与焦点恢复正确",
      "evidence_required": "Tester 在 test-report 记录 viewport、步骤和结果",
      "evidence_types": ["browser-run", "screenshot"],
      "on_fail": "block_verification",
      "on_missing": "block_verification",
      "status": "deferred",
      "release_impact": "缺失或失败会阻止 Verification 通过"
    }
  ]
}
\`\`\`
`,
    }],
  });

  const deferredItem = deferred.items.find(({ id }) => id === "B-04");
  assert.ok(deferredItem, "the deferred verification remains auditable");
  assert.equal(deferredItem.blocking, false);
  assert.match(deferredItem.nextAction, /test-report.*Verification/u);
  assert.equal(deferred.blockingCount, 0);
  assert.equal(deferred.workCount, 0, "deferred verification must not request another Designer run");
  assert.equal(deferred.state, "clear");
  assert.doesNotThrow(() => assertPhaseHumanDecisionGateReady(deferred));

  const legacyBlocked = assessPhaseHumanDecisionGate({
    phaseId: "design",
    phaseStatus: "changes_requested",
    artifacts: [{
      artifactKey: "design-spec",
      content: '\`\`\`json\n{"status":"blocked","blockers":[{"id":"B-04","decision":"实现可运行后验证 320px","owner":"Designer","next_action":"实现完成后执行浏览器验证"}]}\n\`\`\`',
    }],
  });
  assert.equal(legacyBlocked.items.find(({ id }) => id === "B-04")?.blocking, false);
  assert.equal(legacyBlocked.items.find(({ id }) => id === "DESIGN-HANDOFF-INCOMPLETE")?.blocking, true);
  assert.equal(legacyBlocked.blockingCount, 1, "legacy blocked status needs one formal cleanup, not another runtime attempt");

  const immediate = assessPhaseHumanDecisionGate({
    phaseId: "design",
    phaseStatus: "awaiting_review",
    artifacts: [{
      artifactKey: "design-spec",
      content: `
\`\`\`json
{
  "status": "blocked",
  "open_questions": [],
  "deferred_validations": [],
  "blockers": [
    {
      "id": "B-04",
      "decision": "立即验证现有 320px 设计稿与键盘操作",
      "owner": "Designer",
      "next_action": "现在附上可取得的设计验证证据"
    }
  ]
}
\`\`\`
`,
    }],
  });

  assert.equal(immediate.items.find(({ id }) => id === "B-04")?.blocking, true);
  assert.equal(immediate.blockingCount, 1);
  assert.equal(immediate.workCount, 1);
  assert.equal(immediate.state, "awaiting_role_work");
  assert.throws(
    () => assertPhaseHumanDecisionGateReady(immediate),
    (error: unknown) => error instanceof AppError && error.code === "PHASE_HUMAN_DECISIONS_REQUIRED",
  );
});

test("AC-CLARITY-016: Design routes product priority questions upstream instead of asking the Designer", () => {
  const gate = assessPhaseHumanDecisionGate({
    phaseId: "design",
    phaseStatus: "awaiting_review",
    artifacts: [{
      artifactKey: "design-spec",
      content: '\`\`\`json\n{"status":"blocked","open_questions":["Confirm product priority and success threshold"],"blockers":[],"deferred_validations":[]}\n\`\`\`',
    }],
  });
  assert.equal(gate.items[0]?.kind, "dependency");
  assert.equal(gate.items[0]?.actionPhaseId, "discovery");
  assert.equal(gate.items[0]?.owner, "Human product owner");
  assert.equal(gate.items[0]?.blocking, true, "misplaced product decisions remain blocking");
});

test("AC-DES-LOOP-004: genuinely non-blocking Design open questions do not create another rerun", () => {
  const gate = assessPhaseHumanDecisionGate({
    phaseId: "design",
    phaseStatus: "awaiting_review",
    artifacts: [{
      artifactKey: "design-spec",
      content: '\`\`\`json\n{"status":"ready-for-engineering","blockers":[],"open_questions":["Should a future iteration add an optional animation?"],"deferred_validations":[]}\n\`\`\`',
    }],
  });
  assert.equal(gate.items[0]?.kind, "decision");
  assert.equal(gate.items[0]?.blocking, false);
  assert.equal(gate.blockingCount, 0);
  assert.doesNotThrow(() => assertPhaseHumanDecisionGateReady(gate));
});

test("AC-DES-LOOP-003: malformed deferred ledgers fail closed at the approval gate", () => {
  const invalidLedgers = [
    [{}],
    [{ ...validDeferredValidation, owner: "Designer" }],
    [{ ...validDeferredValidation, phase: "design" }],
    [{ ...validDeferredValidation, checks: [] }],
    [{ ...validDeferredValidation, status: "complete" }],
    [validDeferredValidation, { ...validDeferredValidation }],
  ];

  for (const deferred_validations of invalidLedgers) {
    const gate = assessPhaseHumanDecisionGate({
      phaseId: "design",
      phaseStatus: "awaiting_review",
      artifacts: [{
        artifactKey: "design-spec",
        content: `\`\`\`json\n${JSON.stringify({
          status: "ready-for-engineering",
          blockers: [],
          deferred_validations,
        })}\n\`\`\``,
      }],
    });
    assert.equal(
      gate.items.some(({ id, blocking }) => id === "DESIGN-DEFERRED-VALIDATION-INVALID" && blocking),
      true,
    );
    assert.throws(
      () => assertPhaseHumanDecisionGateReady(gate),
      (error: unknown) => error instanceof AppError && error.code === "PHASE_HUMAN_DECISIONS_REQUIRED",
    );
  }
});

test("AC-DES-LOOP-003: malformed design envelopes cannot bypass the approval gate", () => {
  for (const content of [
    '\`\`\`json\n{"status":"ready-for-engineering","blockers":"B-04 unresolved"}\n\`\`\`',
    '\`\`\`json\n{"status":"ready-for-engineering","blockers":[]\n\`\`\`',
  ]) {
    const gate = assessPhaseHumanDecisionGate({
      phaseId: "design",
      phaseStatus: "awaiting_review",
      artifacts: [{ artifactKey: "design-spec", content }],
    });
    assert.equal(gate.blockingCount > 0, true);
    assert.throws(
      () => assertPhaseHumanDecisionGateReady(gate),
      (error: unknown) => error instanceof AppError && error.code === "PHASE_HUMAN_DECISIONS_REQUIRED",
    );
  }
});

test("AC-CLARITY-014/015: Architecture distinguishes dependencies, decisions, and final acceptance", () => {
  const gate = assessPhaseHumanDecisionGate({
    phaseId: "architecture",
    phaseStatus: "awaiting_review",
    artifacts: [{
      artifactKey: "architecture",
      content: `# Architecture

**Status:** Ready for human acceptance / Blocked

## Open Human Decisions

- [ ] **PROD-01 / B-01:** Product supplies the final catalog.
- [ ] **DES-01 / B-04:** Designer records rendered validation.
- [ ] **ARCH-02:** Product and operations confirm measurable NFR targets.
- [ ] **ARCH-03:** Security owner decides any new trust boundary.
- [ ] **ARCH-04:** Human architecture owner records final acceptance.
`,
    }],
  });
  assert.equal(gate.dependencyCount, 2);
  assert.equal(gate.decisionCount, 2);
  assert.equal(gate.items.find(({ id }) => id === "ARCH-04")?.kind, "acceptance");
  assert.equal(gate.items.find(({ id }) => id === "ARCH-04")?.blocking, false);
  assert.throws(
    () => assertPhaseHumanDecisionGateReady(gate),
    (error: unknown) => error instanceof AppError && error.code === "PHASE_HUMAN_DECISIONS_REQUIRED",
  );
});

test("AC-ARCH-LOOP-001/002: Architecture exposes OBS-002 instead of a generic rerun loop", () => {
  const gate = assessPhaseHumanDecisionGate({
    phaseId: "architecture",
    phaseStatus: "awaiting_review",
    artifacts: [
      {
        artifactKey: "architecture",
        content: "# Architecture\n\n**Status:** Blocked — awaiting platform-verified option selection; not a build approval\n",
      },
      {
        artifactKey: "architecture-discovery-context",
        content: `# Discovery

## Evidence still missing

- [ ] **Platform/workflow owner:** record the platform-verified selection object for one option in this current checkpoint.
- [ ] **Architecture or operations owner:** for OBS-002, choose either an approved browser diagnostic destination and minimal field/redaction policy, or an explicit policy exception with owner and review date.
`,
      },
    ],
  });

  assert.equal(gate.blockingCount, 1);
  assert.equal(gate.decisionCount, 1);
  assert.equal(gate.items.some(({ id }) => id === "ARCHITECTURE-HANDOFF-INCOMPLETE"), false);
  const observability = gate.items.find(({ id }) => id === "ARCH-OBS-002");
  assert.ok(observability);
  assert.equal(observability.kind, "decision");
  assert.equal(observability.actionPhaseId, "architecture");
  assert.match(observability.title, /浏览器错误信息/u);
  assert.match(observability.prompt, /本地最小诊断.*已有监控平台/u);
  assert.match(observability.nextAction, /只重跑一次 Architect/u);

  const selectionOnly = assessPhaseHumanDecisionGate({
    phaseId: "architecture",
    phaseStatus: "awaiting_review",
    artifacts: [
      {
        artifactKey: "architecture",
        content: "# Architecture\n\n**Status:** Blocked — awaiting platform-verified option selection; not a build approval\n",
      },
      {
        artifactKey: "architecture-discovery-context",
        content: "## Evidence still missing\n\n- [ ] **Platform/workflow owner:** record the platform-verified selection object for one option in this current checkpoint.\n",
      },
    ],
  });
  assert.equal(selectionOnly.blockingCount, 0);
  assert.equal(selectionOnly.items.length, 0);
});

test("AC-CLARITY-015: Product and Design ready handoffs have clear decision gates", () => {
  const product = assessPhaseHumanDecisionGate({
    phaseId: "discovery",
    phaseStatus: "awaiting_review",
    artifacts: [{
      artifactKey: "prd",
      content: "# PRD\n\n**Status:** Ready for human review\n\n## Open questions for a human\n\nNone.\n",
    }],
  });
  const design = assessPhaseHumanDecisionGate({
    phaseId: "design",
    phaseStatus: "awaiting_review",
    artifacts: [{
      artifactKey: "design-spec",
      content: '\`\`\`json\n{"status":"ready-for-engineering","open_questions":[],"blockers":[],"deferred_validations":[]}\n\`\`\`',
    }],
  });
  assert.equal(product.state, "clear");
  assert.equal(design.state, "clear");
  assert.doesNotThrow(() => assertPhaseHumanDecisionGateReady(product));
  assert.doesNotThrow(() => assertPhaseHumanDecisionGateReady(design));
});

test("AC-CLARITY-015: Needs-decision or TBD Product fields remain blocking without a checklist", () => {
  const gate = assessPhaseHumanDecisionGate({
    phaseId: "discovery",
    phaseStatus: "awaiting_review",
    artifacts: [{
      artifactKey: "prd",
      content: `# PRD

**Status:** Draft for human review

| ID | Rule | Evidence | Status |
|---|---|---|---|
| BR-001 | Choose access policy | None | Needs decision |
`,
    }],
  });
  assert.equal(gate.items[0]?.id, "PRODUCT-HANDOFF-INCOMPLETE");
  assert.equal(gate.items[0]?.kind, "decision");
});

test("AC-CLARITY-017: decision capture is auditable and remains open until artifacts are updated", () => {
  const comment = serializeHumanDecisionCapture({
    phaseId: "discovery",
    responses: [{ id: "PROD-Q-01", response: "Use the existing seven squads in their current order." }],
  });
  assert.deepEqual(parseHumanDecisionCapture(comment), {
    phaseId: "discovery",
    responses: [{ id: "PROD-Q-01", response: "Use the existing seven squads in their current order." }],
  });
  const gate = assessPhaseHumanDecisionGate({
    phaseId: "discovery",
    phaseStatus: "changes_requested",
    artifacts: [{
      artifactKey: "prd",
      content: "## Open questions for a human\n\n- [ ] How many levels exist?\n",
    }],
    reviews: [{
      id: "review-1",
      phaseRunId: "phase-1",
      decision: "request_changes",
      comment,
      artifactIds: [],
      createdAt: "2026-08-20T00:00:00.000Z",
    }],
  });
  assert.equal(gate.items[0]?.response, "Use the existing seven squads in their current order.");
  assert.equal(gate.blockingCount, 1, "captured answer must be materialized into the PRD before approval");
});

test("AC-CLARITY-017: decision capture safely round-trips Markdown fences and legacy records", () => {
  const response = "Use this exact rule:\n```json\n{\"mode\":\"guided\"}\n```\nand preserve the audit marker <!-- example -->.";
  const encoded = serializeHumanDecisionCapture({
    phaseId: "discovery",
    responses: [{ id: "PROD-Q-01", response }],
  });
  assert.deepEqual(parseHumanDecisionCapture(encoded), {
    phaseId: "discovery",
    responses: [{ id: "PROD-Q-01", response }],
  });
  const legacy = `<!-- ${"ai-sdlc:human-decisions:v1"} -->\n\`\`\`json\n{"schemaVersion":1,"phaseId":"design","responses":[{"id":"DES-Q-01","response":"Keep the current interaction."}]}\n\`\`\``;
  assert.deepEqual(parseHumanDecisionCapture(legacy), {
    phaseId: "design",
    responses: [{ id: "DES-Q-01", response: "Keep the current interaction." }],
  });
});

test("AC-CLARITY-014: the cross-phase summary reports decisions, work, and inconsistent phases", () => {
  const gates = [
    assessPhaseHumanDecisionGate({
      phaseId: "discovery",
      phaseStatus: "approved",
      artifacts: [{ artifactKey: "prd", content: "## Open questions for a human\n- [ ] Decide scope\n" }],
    }),
    assessPhaseHumanDecisionGate({
      phaseId: "design",
      phaseStatus: "awaiting_review",
      artifacts: [{ artifactKey: "design-spec", content: '\`\`\`json\n{"status":"ready-for-engineering","open_questions":[],"blockers":[],"deferred_validations":[]}\n\`\`\`' }],
    }),
    assessPhaseHumanDecisionGate({
      phaseId: "architecture",
      phaseStatus: "pending",
      artifacts: [],
    }),
  ];
  const summary = humanDecisionSummary(gates);
  assert.equal(summary.totalBlocking, 1);
  assert.equal(summary.totalDecisions, 1);
  assert.deepEqual(summary.inconsistentPhaseIds, ["discovery"]);
});
