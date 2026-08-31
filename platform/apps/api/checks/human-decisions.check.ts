import assert from "node:assert/strict";
import test from "node:test";

import { AppError } from "../src/domain/errors.ts";
import {
  answeredCurrentUserStoriesBlockerFingerprints,
  answeredCurrentUserStoriesBlockerScopes,
  assessPhaseHumanDecisionGate,
  assertPhaseHumanDecisionGateReady,
  buildHumanDecisionReplay,
  completeProductDecisionMaterializationPolicy,
  humanDecisionRevisionFeedback,
  humanDecisionSummary,
  parseHumanDecisionCapture,
  projectProductDecisionMaterializationGate,
  serializeHumanDecisionCapture,
} from "../src/domain/human-decisions.ts";
import {
  renderUserStoriesBlocker,
  USER_STORIES_BLOCKER_SENTINEL,
  userStoriesBlockerDecisionFingerprint,
  userStoriesBlockerDecisionId,
  userStoriesBlockerDecisionScope,
} from "../src/domain/user-story-quality.ts";

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

const currentProductStoriesBlocker = `## README.md

${USER_STORIES_BLOCKER_SENTINEL}

Status: Blocked

## Known facts

- The requested profile redesign is confirmed.

## Missing facts

- The profile visual direction is not confirmed.

## Open questions

- Which visual theme should the profile use?

## Human owner

- Product Owner

## Next step

- Confirm the theme and ask PM / BA to write the Stories.
`;

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
  assert.match(gate.items[0]?.id ?? "", /^PRODUCT-QUESTION-V2-[a-f0-9]{24}$/u);
  assert.equal(new Set(gate.items.map(({ id }) => id)).size, 5);
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

test("AC-DES-LOOP-007: a prose-only Design Spec reports the missing machine contract instead of a deferred-array symptom", () => {
  const gate = assessPhaseHumanDecisionGate({
    phaseId: "design",
    phaseStatus: "awaiting_review",
    artifacts: [{
      artifactKey: "design-spec",
      content: "# Design Specification\n\n## 目标\n\n- 优化当前布局。\n",
    }],
  });

  assert.equal(gate.blockingCount, 1);
  assert.equal(gate.workCount, 1);
  assert.deepEqual(gate.items.map(({ id }) => id), ["DESIGN-CONTRACT-MISSING"]);
  assert.match(gate.items[0]?.prompt ?? "", /缺少完整.*machine-readable JSON 合同/u);
  assert.doesNotMatch(gate.items[0]?.prompt ?? "", /must be an explicit array/u);
  assert.match(gate.items[0]?.nextAction ?? "", /完整重写.*fenced JSON/u);
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
  assert.match(gate.items[0]?.id ?? "", /^PRODUCT-HANDOFF-V2-[a-f0-9]{24}$/u);
  assert.equal(gate.items[0]?.kind, "decision");
});

test("AC-CLARITY-017: decision capture is auditable and remains open until artifacts are updated", () => {
  const prdContent = "## Open questions for a human\n\n- [ ] How many levels exist?\n";
  const artifact = {
    id: "prd-revision-1",
    artifactKey: "prd",
    content: prdContent,
  };
  const decisionId = assessPhaseHumanDecisionGate({
    phaseId: "discovery",
    phaseStatus: "awaiting_review",
    artifacts: [artifact],
  }).items[0]?.id;
  assert.match(decisionId ?? "", /^PRODUCT-QUESTION-V2-[a-f0-9]{24}$/u);
  const comment = serializeHumanDecisionCapture({
    phaseId: "discovery",
    responses: [{ id: decisionId!, response: "Use the existing seven squads in their current order." }],
  });
  assert.deepEqual(parseHumanDecisionCapture(comment), {
    phaseId: "discovery",
    responses: [{ id: decisionId!, response: "Use the existing seven squads in their current order." }],
  });
  const gate = assessPhaseHumanDecisionGate({
    phaseId: "discovery",
    phaseStatus: "changes_requested",
    artifacts: [artifact],
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
  assert.equal(gate.items[0]?.kind, "work");
  assert.equal(gate.decisionCount, 0, "an answered question becomes PM / BA work, not another decision");
  assert.equal(gate.workCount, 1);
  assert.equal(gate.blockingCount, 1, "captured answer must be materialized into the PRD before approval");
});

test("CHAT-DECISION-BATCH-02: PRD V2 answers follow question content while legacy positions bind only one artifact head", () => {
  const prd = (questions: readonly string[]) => `## Open questions\n\n${questions.map((question) => `- ${question}`).join("\n")}\n`;
  const originalArtifact = {
    id: "prd-revision-1",
    artifactKey: "prd",
    content: prd(["Use cards or a table?", "Include repository links?"]),
  };
  const original = assessPhaseHumanDecisionGate({
    phaseId: "discovery",
    phaseStatus: "awaiting_review",
    artifacts: [originalArtifact],
  });
  const cardsId = original.items[0]?.id;
  const linksId = original.items[1]?.id;
  assert.match(cardsId ?? "", /^PRODUCT-QUESTION-V2-/u);
  assert.match(linksId ?? "", /^PRODUCT-QUESTION-V2-/u);

  const reorderedArtifact = {
    ...originalArtifact,
    id: "prd-revision-2",
    content: prd(["Include repository links?", "Use cards or a table?"]),
  };
  const v2Review = {
    id: "v2-review",
    phaseRunId: "phase-1",
    decision: "request_changes" as const,
    comment: serializeHumanDecisionCapture({
      phaseId: "discovery",
      responses: [
        { id: cardsId!, response: "Use cards in the existing section order." },
        { id: linksId!, response: "Include repository links for every project." },
      ],
    }),
    artifactIds: [originalArtifact.id],
    createdAt: "2026-08-20T00:02:00.000Z",
  };
  const reordered = assessPhaseHumanDecisionGate({
    phaseId: "discovery",
    phaseStatus: "changes_requested",
    artifacts: [reorderedArtifact],
    reviews: [v2Review],
  });
  assert.equal(reordered.items[0]?.id, linksId);
  assert.match(reordered.items[0]?.response ?? "", /repository links/u);
  assert.equal(reordered.items[1]?.id, cardsId);
  assert.match(reordered.items[1]?.response ?? "", /Use cards/u);
  assert.equal(reordered.decisionCount, 0);
  assert.equal(reordered.workCount, 2);

  const legacyReview = {
    ...v2Review,
    id: "legacy-review",
    comment: serializeHumanDecisionCapture({
      phaseId: "discovery",
      responses: [{ id: "PROD-Q-01", response: "Use cards in the existing section order." }],
    }),
    artifactIds: [originalArtifact.id],
  };
  const legacySameHead = assessPhaseHumanDecisionGate({
    phaseId: "discovery",
    phaseStatus: "changes_requested",
    artifacts: [originalArtifact],
    reviews: [legacyReview],
  });
  assert.equal(legacySameHead.items[0]?.kind, "work");
  assert.match(legacySameHead.items[0]?.response ?? "", /Use cards/u);

  const legacyNewHead = assessPhaseHumanDecisionGate({
    phaseId: "discovery",
    phaseStatus: "changes_requested",
    artifacts: [reorderedArtifact],
    reviews: [legacyReview],
  });
  assert.equal(legacyNewHead.items[0]?.response, null);
  assert.equal(legacyNewHead.items[1]?.response, null);
  assert.equal(legacyNewHead.decisionCount, 2);
  assert.doesNotMatch(
    buildHumanDecisionReplay([legacyReview], [reorderedArtifact]).revisionFeedback.join("\n"),
    /Use cards/u,
    "an unbound positional Product answer must not leak into optional Provider feedback",
  );

  const laterExplicitArtifact = {
    ...originalArtifact,
    id: "prd-revision-3",
    content: prd(["PROD-Q-01: Which audience owns final acceptance?"]),
  };
  const legacyAgainstLaterExplicit = assessPhaseHumanDecisionGate({
    phaseId: "discovery",
    phaseStatus: "changes_requested",
    artifacts: [laterExplicitArtifact],
    reviews: [legacyReview],
  });
  assert.equal(legacyAgainstLaterExplicit.items[0]?.id, "PROD-Q-01");
  assert.equal(legacyAgainstLaterExplicit.items[0]?.response, null);
  assert.equal(
    legacyAgainstLaterExplicit.decisionCount,
    1,
    "an old positional PROD-Q-01 must not bind to a later explicit question with the same ID",
  );
});

test("CHAT-DECISION-IDENTITY-01: Product handoff answers follow row content and legacy fixed IDs bind only the reviewed PRD head", () => {
  const productArtifact = (id: string, rule: string) => ({
    id,
    artifactKey: "prd",
    content: [
      "# PRD",
      "",
      "| Rule | State |",
      "| --- | --- |",
      `| ${rule} | Needs decision |`,
      "",
    ].join("\n"),
  });
  const repositoryHead = productArtifact("prd-handoff-1", "Repository links");
  const repositoryGate = assessPhaseHumanDecisionGate({
    phaseId: "discovery",
    phaseStatus: "awaiting_review",
    artifacts: [repositoryHead],
  });
  const repositoryDecisionId = repositoryGate.items[0]!.id;
  assert.match(repositoryDecisionId, /^PRODUCT-HANDOFF-V2-[a-f0-9]{24}$/u);

  const v2Review = {
    id: "product-handoff-v2-answer",
    phaseRunId: "phase-product",
    decision: "request_changes" as const,
    comment: serializeHumanDecisionCapture({
      phaseId: "discovery",
      responses: [{
        id: repositoryDecisionId,
        response: "Include repository links for every project entry.",
      }],
    }),
    artifactIds: [repositoryHead.id],
    createdAt: "2026-08-20T00:04:00.000Z",
  };
  const sameContentNewHead = { ...repositoryHead, id: "prd-handoff-2" };
  const sameContentGate = assessPhaseHumanDecisionGate({
    phaseId: "discovery",
    phaseStatus: "changes_requested",
    artifacts: [sameContentNewHead],
    reviews: [v2Review],
  });
  assert.equal(sameContentGate.items[0]?.id, repositoryDecisionId);
  assert.match(sameContentGate.items[0]?.response ?? "", /repository links/u);

  const retentionHead = productArtifact("prd-handoff-3", "Data retention period");
  const changedGate = assessPhaseHumanDecisionGate({
    phaseId: "discovery",
    phaseStatus: "changes_requested",
    artifacts: [retentionHead],
    reviews: [v2Review],
  });
  assert.notEqual(changedGate.items[0]?.id, repositoryDecisionId);
  assert.equal(changedGate.items[0]?.response, null);
  assert.equal(changedGate.items[0]?.kind, "decision");

  const legacyReview = {
    ...v2Review,
    id: "product-handoff-legacy-answer",
    comment: serializeHumanDecisionCapture({
      phaseId: "discovery",
      responses: [{
        id: "PRODUCT-HANDOFF-INCOMPLETE",
        response: "Include repository links for every project entry.",
      }],
    }),
  };
  const legacySameHead = assessPhaseHumanDecisionGate({
    phaseId: "discovery",
    phaseStatus: "changes_requested",
    artifacts: [repositoryHead],
    reviews: [legacyReview],
  });
  assert.match(legacySameHead.items[0]?.response ?? "", /repository links/u);
  const legacyChangedHead = assessPhaseHumanDecisionGate({
    phaseId: "discovery",
    phaseStatus: "changes_requested",
    artifacts: [retentionHead],
    reviews: [legacyReview],
  });
  assert.equal(legacyChangedHead.items[0]?.response, null);
  assert.doesNotMatch(
    buildHumanDecisionReplay([legacyReview], [retentionHead]).revisionFeedback.join("\n"),
    /repository links/u,
    "an unbound legacy answer must not leak into optional Provider feedback",
  );
});

test("CHAT-DECISION-IDENTITY-02: implicit Design questions and blockers use content IDs with exact-head legacy compatibility", () => {
  const designArtifact = (id: string, blocker: string, question: string) => ({
    id,
    artifactKey: "design-spec",
    content: `\`\`\`json\n${JSON.stringify({
      status: "blocked",
      blockers: [{
        decision: blocker,
        owner: "Human design owner",
        next_action: "Update the interaction contract.",
      }],
      open_questions: [question],
      deferred_validations: [],
    })}\n\`\`\``,
  });
  const original = designArtifact(
    "design-head-1",
    "Choose trapped or roving focus.",
    "Should focus wrap in the command palette?",
  );
  const originalGate = assessPhaseHumanDecisionGate({
    phaseId: "design",
    phaseStatus: "awaiting_review",
    artifacts: [original],
  });
  const blockerId = originalGate.items.find(({ blocking }) => blocking)!.id;
  const questionId = originalGate.items.find(({ blocking }) => !blocking)!.id;
  assert.match(blockerId, /^DESIGN-BLOCKER-V2-[a-f0-9]{24}$/u);
  assert.match(questionId, /^DESIGN-QUESTION-V2-[a-f0-9]{24}$/u);

  const legacyReview = {
    id: "design-legacy-answer",
    phaseRunId: "phase-design",
    decision: "request_changes" as const,
    comment: serializeHumanDecisionCapture({
      phaseId: "design",
      responses: [
        { id: "DES-BLOCKER-1", response: "Use trapped focus and restore the trigger." },
        { id: "DES-Q-01", response: "Wrap focus within the command palette." },
      ],
    }),
    artifactIds: [original.id],
    createdAt: "2026-08-20T00:03:00.000Z",
  };
  const legacySameHead = assessPhaseHumanDecisionGate({
    phaseId: "design",
    phaseStatus: "changes_requested",
    artifacts: [original],
    reviews: [legacyReview],
  });
  assert.match(legacySameHead.items.find(({ id }) => id === blockerId)?.response ?? "", /trapped focus/u);
  assert.match(legacySameHead.items.find(({ id }) => id === questionId)?.response ?? "", /Wrap focus/u);

  const changed = designArtifact(
    "design-head-2",
    "Choose modal or non-modal navigation.",
    "Should the palette remain open after selection?",
  );
  const changedGate = assessPhaseHumanDecisionGate({
    phaseId: "design",
    phaseStatus: "changes_requested",
    artifacts: [changed],
    reviews: [legacyReview],
  });
  assert.equal(changedGate.items.some(({ id }) => id === blockerId || id === questionId), false);
  assert.equal(changedGate.items.every(({ response }) => response === null), true);

  const explicitCollision = {
    id: "design-head-3",
    artifactKey: "design-spec",
    content: `\`\`\`json\n${JSON.stringify({
      status: "blocked",
      blockers: [{
        id: "DES-BLOCKER-1",
        decision: "Choose the destructive-delete confirmation policy.",
        owner: "Human design owner",
        next_action: "Update the destructive action contract.",
      }],
      open_questions: [],
      deferred_validations: [],
    })}\n\`\`\``,
  };
  const collisionGate = assessPhaseHumanDecisionGate({
    phaseId: "design",
    phaseStatus: "changes_requested",
    artifacts: [explicitCollision],
    reviews: [legacyReview],
  });
  assert.equal(collisionGate.items.find(({ id }) => id === "DES-BLOCKER-1")?.response, null);
  assert.doesNotMatch(
    buildHumanDecisionReplay([legacyReview], [explicitCollision]).revisionFeedback.join("\n"),
    /trapped focus/u,
  );
});

test("CHAT-DECISION-IDENTITY-03: implicit Architecture questions use content IDs with exact-head legacy compatibility", () => {
  const architectureArtifact = (id: string, question: string) => ({
    id,
    artifactKey: "architecture-decisions",
    content: `# Architecture decisions\n\n## Open decisions\n\n- [ ] ${question}\n`,
  });
  const original = architectureArtifact("architecture-head-1", "Where should diagnostic events be stored?");
  const originalGate = assessPhaseHumanDecisionGate({
    phaseId: "architecture",
    phaseStatus: "awaiting_review",
    artifacts: [original],
  });
  const decisionId = originalGate.items[0]!.id;
  assert.match(decisionId, /^ARCHITECTURE-QUESTION-V2-[a-f0-9]{24}$/u);
  const legacyReview = {
    id: "architecture-legacy-answer",
    phaseRunId: "phase-architecture",
    decision: "request_changes" as const,
    comment: serializeHumanDecisionCapture({
      phaseId: "architecture",
      responses: [{ id: "ARCH-Q-01", response: "Use the existing internal telemetry store." }],
    }),
    artifactIds: [original.id],
    createdAt: "2026-08-20T00:02:00.000Z",
  };
  const legacySameHead = assessPhaseHumanDecisionGate({
    phaseId: "architecture",
    phaseStatus: "changes_requested",
    artifacts: [original],
    reviews: [legacyReview],
  });
  assert.match(legacySameHead.items[0]?.response ?? "", /telemetry store/u);

  const changed = architectureArtifact("architecture-head-2", "Which team owns the rollback decision?");
  const changedGate = assessPhaseHumanDecisionGate({
    phaseId: "architecture",
    phaseStatus: "changes_requested",
    artifacts: [changed],
    reviews: [legacyReview],
  });
  assert.notEqual(changedGate.items[0]?.id, decisionId);
  assert.equal(changedGate.items[0]?.response, null);

  const explicitCollision = architectureArtifact(
    "architecture-head-3",
    "ARCH-Q-01: Which team owns the rollback decision?",
  );
  const collisionGate = assessPhaseHumanDecisionGate({
    phaseId: "architecture",
    phaseStatus: "changes_requested",
    artifacts: [explicitCollision],
    reviews: [legacyReview],
  });
  assert.equal(collisionGate.items[0]?.id, "ARCH-Q-01");
  assert.equal(collisionGate.items[0]?.response, null);
  assert.doesNotMatch(
    buildHumanDecisionReplay([legacyReview], [explicitCollision]).revisionFeedback.join("\n"),
    /telemetry store/u,
  );
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

test("CHAT-DECISION-REPLAY-01: Provider feedback keeps concrete decisions without audit-marker budget loss", () => {
  const capturedReview = (
    createdAt: string,
    responses: Array<{ id: string; response: string }>,
  ) => ({
    id: `review-${createdAt}`,
    phaseRunId: "phase-1",
    decision: "request_changes" as const,
    comment: serializeHumanDecisionCapture({ phaseId: "discovery", responses }),
    artifactIds: [],
    createdAt,
  });
  const genericReviews = Array.from({ length: 6 }, (_, index) => capturedReview(
    `2026-08-20T00:${String(12 - index).padStart(2, "0")}:00.000Z`,
    [{
      id: "PRODUCT-STORIES-BLOCKER-V1",
      response: index % 2 === 0 ? "同意同意同意" : "yes, OK!!!",
    }],
  ));
  const reviews = [
    ...genericReviews,
    capturedReview("2026-08-20T00:05:00.000Z", [{
      id: "PRODUCT-STORIES-BLOCKER-V1",
      response: "直接改成红色主题，layout 可以调整。",
    }]),
    capturedReview("2026-08-20T00:04:00.000Z", [{
      id: "PRODUCT-STORIES-BLOCKER-V1",
      response: "把 GitHub profile README 样式调整得更高级。",
    }]),
    capturedReview("2026-08-20T00:03:00.000Z", [
      {
        id: "PRODUCT-HANDOFF-INCOMPLETE",
        response: "No need to highlight metrics; only redesign the profile page.",
      },
      { id: "PRODUCT-STORIES-BLOCKER-V1", response: "All requested profile sections are needed." },
    ]),
    capturedReview("2026-08-20T00:02:30.000Z", [{
      id: "PRODUCT-STORIES-BLOCKER-V1",
      response: "Preserve the existing project list while changing its presentation.",
    }]),
    capturedReview("2026-08-20T00:02:00.000Z", [{
      id: "PRODUCT-HANDOFF-INCOMPLETE",
      response: "No need to highlight metrics; only redesign the profile page.",
    }]),
    capturedReview("2026-08-20T00:01:00.000Z", [{
      id: "PRODUCT-STORIES-BLOCKER-V1",
      response: "Use the old blue theme.",
    }]),
  ];

  const feedback = humanDecisionRevisionFeedback(reviews).join("\n");
  assert.match(feedback, /红色主题/u);
  assert.match(feedback, /layout 可以调整/u);
  assert.match(feedback, /No need to highlight metrics/u);
  assert.doesNotMatch(feedback, /GitHub profile README/u, "the newest concrete value wins per ID");
  assert.doesNotMatch(feedback, /同意同意同意|yes, OK|Use the old blue theme/u);
  assert.doesNotMatch(feedback, /ai-sdlc:human-decisions:v1|eyJzY2hlbWFWZXJzaW9u/u);
  assert.equal(feedback.split("No need to highlight metrics").length - 1, 1);
  assert.ok(feedback.length <= 8_000);
});

test("CHAT-DECISION-REPLAY-03: an exact V2 Blocker answer survives more than five newer unrelated captures", () => {
  const artifact = {
    id: "stories-revision-9",
    artifactKey: "user-stories",
    content: currentProductStoriesBlocker,
  };
  const fingerprint = userStoriesBlockerDecisionFingerprint(currentProductStoriesBlocker);
  const decisionId = userStoriesBlockerDecisionId(currentProductStoriesBlocker);
  assert.ok(fingerprint);
  assert.ok(decisionId);

  const reviews = [
    ...Array.from({ length: 6 }, (_, index) => ({
      id: `unrelated-review-${index}`,
      phaseRunId: "phase-1",
      decision: "request_changes" as const,
      comment: serializeHumanDecisionCapture({
        phaseId: "discovery",
        responses: [{
          id: `PROD-Q-${String(index + 1).padStart(2, "0")}`,
          response: `Use the concrete product rule ${index + 1}.`,
        }],
      }),
      artifactIds: [],
      createdAt: `2026-08-20T00:${String(12 - index).padStart(2, "0")}:00.000Z`,
    })),
    {
      id: "exact-v2-review",
      phaseRunId: "phase-1",
      decision: "request_changes" as const,
      comment: serializeHumanDecisionCapture({
        phaseId: "discovery",
        responses: [{ id: decisionId, response: "Use the red theme; the layout may change." }],
      }),
      artifactIds: [],
      createdAt: "2026-08-20T00:01:00.000Z",
    },
  ];

  const replay = buildHumanDecisionReplay(reviews, [artifact]);
  assert.match(
    replay.revisionFeedback.join("\n"),
    /Use the red theme; the layout may change\./u,
    "a current answer is promoted from the complete history ahead of recent unrelated captures",
  );
  const gate = assessPhaseHumanDecisionGate({
    phaseId: "discovery",
    phaseStatus: "changes_requested",
    artifacts: [artifact],
    reviews,
    enforceUserStoriesQuality: true,
  });
  assert.equal(gate.state, "awaiting_role_work");
  assert.equal(gate.decisionCount, 0);
  assert.equal(gate.workCount, 1);
  assert.equal(gate.items[0]?.id, "PRODUCT-STORIES-ANSWER-NOT-MATERIALIZED");
  assert.equal(gate.items[0]?.response, "Use the red theme; the layout may change.");
  assert.match(gate.items[0]?.nextAction ?? "", /PRD.*真实 User Stories.*不得再次/u);
  assert.deepEqual(
    answeredCurrentUserStoriesBlockerFingerprints(reviews, [artifact]),
    [fingerprint],
  );
  assert.deepEqual(replay.answeredUserStoriesBlockerFingerprints, [fingerprint]);
  assert.deepEqual(replay.answeredUserStoriesBlockerScopes, [
    userStoriesBlockerDecisionScope(artifact.content),
  ]);
});

test("CHAT-DECISION-REPLAY-04: legacy V1 answers inherit only on the exact reviewed User Stories artifact", () => {
  const reviewedArtifact = {
    id: "stories-revision-8",
    artifactKey: "user-stories",
    content: currentProductStoriesBlocker,
  };
  const fingerprint = userStoriesBlockerDecisionFingerprint(currentProductStoriesBlocker);
  assert.ok(fingerprint);
  const boundLegacyReview = {
    id: "legacy-bound-review",
    phaseRunId: "phase-1",
    decision: "request_changes" as const,
    comment: serializeHumanDecisionCapture({
      phaseId: "discovery",
      responses: [{
        id: "PRODUCT-STORIES-BLOCKER-V1",
        response: "Use the red theme and preserve every existing profile section.",
      }],
    }),
    artifactIds: [reviewedArtifact.id],
    createdAt: "2026-08-20T00:01:00.000Z",
  };

  const sameArtifactGate = assessPhaseHumanDecisionGate({
    phaseId: "discovery",
    phaseStatus: "changes_requested",
    artifacts: [reviewedArtifact],
    reviews: [boundLegacyReview],
    enforceUserStoriesQuality: true,
  });
  assert.equal(sameArtifactGate.items[0]?.id, "PRODUCT-STORIES-ANSWER-NOT-MATERIALIZED");
  assert.equal(sameArtifactGate.items[0]?.kind, "work");
  assert.equal(
    sameArtifactGate.items[0]?.response,
    "Use the red theme and preserve every existing profile section.",
  );
  assert.deepEqual(
    answeredCurrentUserStoriesBlockerFingerprints([boundLegacyReview], [reviewedArtifact]),
    [fingerprint],
  );
  assert.match(
    buildHumanDecisionReplay([boundLegacyReview], [reviewedArtifact]).revisionFeedback.join("\n"),
    /preserve every existing profile section/u,
  );

  const newerArtifact = { ...reviewedArtifact, id: "stories-revision-9" };
  const differentArtifactGate = assessPhaseHumanDecisionGate({
    phaseId: "discovery",
    phaseStatus: "changes_requested",
    artifacts: [newerArtifact],
    reviews: [boundLegacyReview],
    enforceUserStoriesQuality: true,
  });
  assert.match(
    differentArtifactGate.items[0]?.id ?? "",
    /^PRODUCT-STORIES-BLOCKER-V2-[a-f0-9]{24}$/u,
  );
  assert.equal(differentArtifactGate.items[0]?.kind, "decision");
  assert.equal(differentArtifactGate.items[0]?.response, null);
  assert.equal(differentArtifactGate.decisionCount, 1);
  assert.equal(differentArtifactGate.workCount, 0);
  assert.deepEqual(
    answeredCurrentUserStoriesBlockerFingerprints([boundLegacyReview], [newerArtifact]),
    [],
  );
  assert.doesNotMatch(
    buildHumanDecisionReplay([boundLegacyReview], [newerArtifact]).revisionFeedback.join("\n"),
    /preserve every existing profile section/u,
  );
});

test("CHAT-DECISION-REPLAY-03A: non-question Product handoff decisions are also promoted from full history", () => {
  const artifact = {
    id: "prd-handoff-head",
    artifactKey: "prd",
    content: [
      "# PRD",
      "",
      "| Rule | State |",
      "| --- | --- |",
      "| Repository links | Needs decision |",
      "",
    ].join("\n"),
  };
  const current = assessPhaseHumanDecisionGate({
    phaseId: "discovery",
    phaseStatus: "awaiting_review",
    artifacts: [artifact],
  });
  const currentDecisionId = current.items[0]?.id;
  assert.match(currentDecisionId ?? "", /^PRODUCT-HANDOFF-V2-[a-f0-9]{24}$/u);
  const reviews = [
    ...Array.from({ length: 6 }, (_, index) => ({
      id: `newer-unrelated-${index}`,
      phaseRunId: "phase-1",
      decision: "request_changes" as const,
      comment: serializeHumanDecisionCapture({
        phaseId: "discovery",
        responses: [{
          id: `UNRELATED-${index}`,
          response: `Keep unrelated concrete rule ${index}.`,
        }],
      }),
      artifactIds: [],
      createdAt: `2026-08-20T00:${String(12 - index).padStart(2, "0")}:00.000Z`,
    })),
    {
      id: "handoff-answer",
      phaseRunId: "phase-1",
      decision: "request_changes" as const,
      comment: serializeHumanDecisionCapture({
        phaseId: "discovery",
        responses: [{
          id: currentDecisionId!,
          response: "Include repository links for every project entry.",
        }],
      }),
      artifactIds: [artifact.id],
      createdAt: "2026-08-20T00:01:00.000Z",
    },
  ];
  assert.match(
    buildHumanDecisionReplay(reviews, [artifact]).revisionFeedback.join("\n"),
    /Include repository links for every project entry/u,
  );
});

test("CHAT-DECISION-REPLAY-03B: current answers are replayed losslessly and over-budget legacy sets fail closed", () => {
  const prdArtifact = {
    id: "prd-long-answer",
    artifactKey: "prd",
    content: "## Open questions\n\n- Which exact content policy should PM / BA implement?\n",
  };
  const prdDecisionId = assessPhaseHumanDecisionGate({
    phaseId: "discovery",
    phaseStatus: "awaiting_review",
    artifacts: [prdArtifact],
  }).items[0]!.id;
  const longAnswer = `Use this exact content policy with all clauses preserved:\n${"x".repeat(4_900)}`;
  const longReview = {
    id: "long-review",
    phaseRunId: "phase-1",
    decision: "request_changes" as const,
    comment: serializeHumanDecisionCapture({
      phaseId: "discovery",
      responses: [{ id: prdDecisionId, response: longAnswer }],
    }),
    artifactIds: [prdArtifact.id],
    createdAt: "2026-08-20T00:02:00.000Z",
  };
  const replay = buildHumanDecisionReplay([longReview], [prdArtifact]);
  assert.ok(replay.revisionFeedback[0]?.includes(longAnswer));
  assert.doesNotMatch(replay.revisionFeedback.join("\n"), /…/u);

  const blockerArtifact = {
    id: "stories-long-answer",
    artifactKey: "user-stories",
    content: currentProductStoriesBlocker,
  };
  const blockerDecisionId = userStoriesBlockerDecisionId(blockerArtifact.content)!;
  const secondLongAnswer = `Use this exact visual policy:\n${"y".repeat(4_900)}`;
  const blockerReview = {
    ...longReview,
    id: "blocker-long-review",
    comment: serializeHumanDecisionCapture({
      phaseId: "discovery",
      responses: [{ id: blockerDecisionId, response: secondLongAnswer }],
    }),
    artifactIds: [blockerArtifact.id],
    createdAt: "2026-08-20T00:03:00.000Z",
  };
  assert.throws(
    () => buildHumanDecisionReplay(
      [blockerReview, longReview],
      [prdArtifact, blockerArtifact],
    ),
    (error: unknown) => error instanceof AppError
      && error.code === "PROVIDER_HUMAN_DECISION_REPLAY_LIMIT",
  );
});

test("CHAT-DECISION-REPLAY-05: unbound or cross-phase legacy V1 answers never resolve a current Blocker", () => {
  const artifact = {
    id: "stories-revision-9",
    artifactKey: "user-stories",
    content: currentProductStoriesBlocker,
  };
  const legacyReview = (
    phaseId: "discovery" | "design",
    artifactIds: string[],
  ) => ({
    id: `legacy-${phaseId}-${artifactIds.length}`,
    phaseRunId: "phase-1",
    decision: "request_changes" as const,
    comment: serializeHumanDecisionCapture({
      phaseId,
      responses: [{ id: "PRODUCT-STORIES-BLOCKER-V1", response: "Use the red theme." }],
    }),
    artifactIds,
    createdAt: "2026-08-20T00:01:00.000Z",
  });

  for (const review of [legacyReview("discovery", []), legacyReview("design", [artifact.id])]) {
    const gate = assessPhaseHumanDecisionGate({
      phaseId: "discovery",
      phaseStatus: "changes_requested",
      artifacts: [artifact],
      reviews: [review],
      enforceUserStoriesQuality: true,
    });
    assert.match(gate.items[0]?.id ?? "", /^PRODUCT-STORIES-BLOCKER-V2-[a-f0-9]{24}$/u);
    assert.equal(gate.items[0]?.response, null);
    assert.equal(gate.decisionCount, 1);
    assert.deepEqual(answeredCurrentUserStoriesBlockerFingerprints([review], [artifact]), []);
    assert.doesNotMatch(
      buildHumanDecisionReplay([review], [artifact]).revisionFeedback.join("\n"),
      /red theme/u,
    );
  }
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

test("CHAT-AC-29: Provider-native Story quality is projected into the inline human gate", () => {
  const artifacts = [
    { artifactKey: "prd", content: "# PRD\n\n## Open questions for a human\n\nNone.\n" },
    {
      artifactKey: "user-stories",
      content: "## README.md\n\n# User Stories\n\nActual Story files should be added later.\n",
    },
  ];
  const compatibleLegacy = assessPhaseHumanDecisionGate({
    phaseId: "discovery",
    phaseStatus: "awaiting_review",
    artifacts,
  });
  assert.equal(compatibleLegacy.blockingCount, 0, "legacy non-Provider Runs keep their prior review contract");

  const invalidProviderOutput = assessPhaseHumanDecisionGate({
    phaseId: "discovery",
    phaseStatus: "awaiting_review",
    artifacts,
    enforceUserStoriesQuality: true,
  });
  assert.equal(invalidProviderOutput.workCount, 1);
  assert.equal(invalidProviderOutput.items[0]?.id, "PRODUCT-STORIES-NOT-REVIEWABLE");
  assert.throws(
    () => assertPhaseHumanDecisionGateReady(invalidProviderOutput),
    (error: unknown) => error instanceof AppError
      && error.code === "PHASE_HUMAN_DECISIONS_REQUIRED",
  );

  const blocker = assessPhaseHumanDecisionGate({
    phaseId: "discovery",
    phaseStatus: "awaiting_review",
    artifacts: [
      artifacts[0]!,
      {
        artifactKey: "user-stories",
        content: `## README.md

${USER_STORIES_BLOCKER_SENTINEL}

Status: Blocked

## Known facts

- The requested outcome is confirmed.

## Missing facts

- The authoritative acceptance audience is not confirmed.

## Open questions

- Which audience owns final acceptance?

## Human owner

- Product Owner

## Next step

- Answer the audience question and ask PM / BA to write the Stories.
`,
      },
    ],
    enforceUserStoriesQuality: true,
  });
  assert.equal(blocker.decisionCount, 1);
  assert.match(blocker.items[0]?.id ?? "", /^PRODUCT-STORIES-BLOCKER-V2-[a-f0-9]{24}$/u);
  assert.match(blocker.items[0]?.prompt ?? "", /audience/u);
  assert.equal(blocker.items[0]?.owner, "Product Owner");
  assert.throws(
    () => assertPhaseHumanDecisionGateReady(blocker),
    (error: unknown) => error instanceof AppError
      && error.code === "PHASE_HUMAN_DECISIONS_REQUIRED",
  );

  const blockerWithoutPrd = assessPhaseHumanDecisionGate({
    phaseId: "discovery",
    phaseStatus: "awaiting_review",
    artifacts: [{
      artifactKey: "user-stories",
      content: `## README.md

${USER_STORIES_BLOCKER_SENTINEL}

Status: Blocked

## Missing facts

- The authoritative acceptance audience is not confirmed.

## Open questions

- Which audience owns final acceptance?

## Human owner

- Product Owner

## Next step

- Answer the audience question and ask PM / BA to write the Stories.
`,
    }],
    enforceUserStoriesQuality: true,
  });
  assert.equal(blockerWithoutPrd.items[0]?.id, blocker.items[0]?.id);
  assert.equal(blockerWithoutPrd.blockingCount, 1, "a missing PRD cannot hide a Story Blocker");
});

test("CHAT-DECISION-BATCH-01: common localized PRD headings expose every unresolved question in one gate", () => {
  const gate = assessPhaseHumanDecisionGate({
    phaseId: "discovery",
    phaseStatus: "awaiting_review",
    artifacts: [
      {
        artifactKey: "prd",
        content: `# 产品需求文档

## 7. 开放问题

- 需要确认 AI SDLC 经验的具体结构（表格、列表或卡片）和展示顺序。
- 是否需要包含项目链接或代码仓库链接？
`,
      },
      {
        artifactKey: "user-stories",
        content: `## README.md

${USER_STORIES_BLOCKER_SENTINEL}

# User Stories Blocker

Status: Blocked

## Missing facts

- No concrete AI SDLC experience details have been selected for the profile.

## Open questions

- What specific AI SDLC experiences should be included in the profile?

## Human owner

- Product Owner

## Next step

- The Product Owner supplies the experience details before Story creation.
`,
      },
    ],
    enforceUserStoriesQuality: true,
  });

  assert.equal(gate.state, "awaiting_decision");
  assert.equal(gate.decisionCount, 3);
  assert.deepEqual(
    gate.items.map(({ artifactKey }) => artifactKey),
    ["prd", "prd", "user-stories"],
  );
  assert.match(gate.items[0]?.prompt ?? "", /具体结构/u);
  assert.match(gate.items[1]?.prompt ?? "", /项目链接/u);
  assert.match(gate.items[0]?.id ?? "", /^PRODUCT-QUESTION-V2-[a-f0-9]{24}$/u);
  assert.match(gate.items[1]?.id ?? "", /^PRODUCT-QUESTION-V2-[a-f0-9]{24}$/u);
  assert.match(gate.items[2]?.id ?? "", /^PRODUCT-STORIES-BLOCKER-V2-/u);
});

test("CHAT-DECISION-BATCH-04: every Blocker question is visible and only a complete answer set authorizes Story materialization", () => {
  const prdSnapshot = {
    id: "prd-multi-revision-1",
    artifactKey: "prd",
    content: "# PRD\n\n**Status:** Ready for story authoring\n\n## Open Questions\n\n- None\n",
  };
  const artifact = {
    id: "stories-multi-revision-1",
    artifactKey: "user-stories",
    content: `## README.md\n\n${renderUserStoriesBlocker({
      status: "Pending",
      knownFacts: ["The existing profile content remains available."],
      missingFacts: [
        "The AI SDLC presentation format has not been selected.",
        "The repository-link policy has not been selected.",
      ],
      openQuestions: [
        "Should AI SDLC experience use cards or a table?",
        "Should project entries include repository links?",
        "Which AI SDLC experiences should be highlighted?",
      ],
      humanOwners: ["Product Owner"],
      nextSteps: ["The Product Owner answers every question before Story authoring."],
    })}`,
  };
  const initial = assessPhaseHumanDecisionGate({
    phaseId: "discovery",
    phaseStatus: "awaiting_review",
    artifacts: [artifact],
    enforceUserStoriesQuality: true,
  });
  assert.equal(initial.decisionCount, 3);
  assert.equal(initial.workCount, 0);
  assert.ok(initial.items.every(({ id }) => /^PRODUCT-STORIES-QUESTION-V3-/u.test(id)));
  assert.deepEqual(initial.items.map(({ prompt }) => prompt), [
    "Should AI SDLC experience use cards or a table?",
    "Should project entries include repository links?",
    "Which AI SDLC experiences should be highlighted?",
  ]);

  const review = (responses: Array<{ id: string; response: string }>) => ({
    id: `review-${responses.length}`,
    phaseRunId: "phase-1",
    decision: "request_changes" as const,
    comment: serializeHumanDecisionCapture({ phaseId: "discovery", responses }),
    artifactIds: [prdSnapshot.id, artifact.id],
    createdAt: "2026-08-20T00:01:00.000Z",
  });
  const allResponses = initial.items.map(({ id }, index) => ({
    id,
    response: [
      "Use cards in the existing section order.",
      "Include repository links for every project entry.",
      "Highlight delivery orchestration, quality gates, and release readiness.",
    ][index]!,
  }));
  const partial = assessPhaseHumanDecisionGate({
    phaseId: "discovery",
    phaseStatus: "changes_requested",
    artifacts: [artifact],
    reviews: [review(allResponses.slice(0, 1))],
    enforceUserStoriesQuality: true,
  });
  assert.equal(partial.decisionCount, 2);
  assert.equal(partial.workCount, 1);
  assert.deepEqual(answeredCurrentUserStoriesBlockerFingerprints(
    [review(allResponses.slice(0, 1))],
    [artifact],
  ), []);
  assert.deepEqual(answeredCurrentUserStoriesBlockerScopes(
    [review(allResponses.slice(0, 1))],
    [artifact],
  ), []);
  assert.equal(
    completeProductDecisionMaterializationPolicy(
      [review(allResponses.slice(0, 1))],
      [prdSnapshot, artifact],
    ),
    null,
    "a legacy partial capture cannot close the Discovery decision batch",
  );

  const completeReview = review(allResponses);
  assert.equal(
    completeProductDecisionMaterializationPolicy([], [artifact]),
    null,
  );
  assert.ok(
    completeProductDecisionMaterializationPolicy([completeReview], [prdSnapshot, artifact]),
    "a concrete structured Discovery answer locks later executions to materialization",
  );
  assert.equal(
    completeProductDecisionMaterializationPolicy([completeReview], [artifact]),
    null,
    "a Discovery lock requires reviewed snapshots for both PRD and User Stories",
  );
  assert.equal(
    completeProductDecisionMaterializationPolicy([
      completeReview,
      {
        id: "newer-human-feedback",
        phaseRunId: "phase-1",
        decision: "request_changes",
        comment: "A newer human review changes the requested product behavior.",
        artifactIds: [artifact.id],
        createdAt: "2026-08-20T00:02:00.000Z",
      },
    ], [prdSnapshot, artifact]),
    null,
    "a newer ordinary human review starts a new feedback epoch instead of permanently suppressing decisions",
  );
  const complete = assessPhaseHumanDecisionGate({
    phaseId: "discovery",
    phaseStatus: "changes_requested",
    artifacts: [artifact],
    reviews: [completeReview],
    enforceUserStoriesQuality: true,
  });
  assert.equal(complete.decisionCount, 0);
  assert.equal(complete.workCount, 3);
  assert.equal(new Set(complete.items.map(({ id }) => id)).size, 3);
  assert.ok(complete.items.every(({ id }) => id.endsWith("-ANSWER-NOT-MATERIALIZED")));
  assert.deepEqual(answeredCurrentUserStoriesBlockerFingerprints([completeReview], [artifact]), [
    userStoriesBlockerDecisionFingerprint(artifact.content),
  ]);
  assert.deepEqual(answeredCurrentUserStoriesBlockerScopes([completeReview], [artifact]), [
    userStoriesBlockerDecisionScope(artifact.content),
  ]);
});

test("CHAT-DECISION-MATERIALIZATION-03: a legacy multi-review history locks only when the reviewed head is fully resolved", () => {
  const prdArtifact = {
    id: "prd-revision-11",
    artifactKey: "prd",
    content: "# PRD\n\n## Open Questions\n\n- Should project entries include repository links?\n",
  };
  const storiesArtifact = {
    id: "stories-revision-11",
    artifactKey: "user-stories",
    content: `## README.md\n\n${renderUserStoriesBlocker({
      status: "Blocked",
      knownFacts: ["The GitHub profile layout will be redesigned."],
      missingFacts: ["The AI SDLC presentation format has not been selected."],
      openQuestions: ["Should AI SDLC experience use cards or a table?"],
      humanOwners: ["Product Owner"],
      nextSteps: ["The Product Owner answers before Story authoring."],
    })}`,
  };
  const artifacts = [prdArtifact, storiesArtifact];
  const open = assessPhaseHumanDecisionGate({
    phaseId: "discovery",
    phaseStatus: "awaiting_review",
    artifacts,
    enforceUserStoriesQuality: true,
  });
  const prdDecision = open.items.find(({ artifactKey }) => artifactKey === "prd");
  const storiesDecision = open.items.find(({ artifactKey }) => artifactKey === "user-stories");
  assert.ok(prdDecision);
  assert.ok(storiesDecision);
  const projected = projectProductDecisionMaterializationGate(open);
  assert.equal(projected.decisionCount, 0);
  assert.equal(projected.workCount, 2);
  assert.equal(projected.state, "awaiting_role_work");
  assert.ok(projected.items.every(({ owner }) => owner === "PM / BA"));
  const review = (
    id: string,
    createdAt: string,
    responses: Array<{ id: string; response: string }>,
  ) => ({
    id,
    phaseRunId: "phase-1",
    decision: "request_changes" as const,
    comment: serializeHumanDecisionCapture({ phaseId: "discovery", responses }),
    artifactIds: artifacts.map(({ id: artifactId }) => artifactId),
    createdAt,
  });
  const first = review("prd-answer", "2026-08-20T00:01:00.000Z", [{
    id: prdDecision.id,
    response: "Include a repository link on every AI SDLC project entry.",
  }]);
  assert.equal(
    completeProductDecisionMaterializationPolicy([first], artifacts),
    null,
    "one legacy partial capture cannot close the reviewed decision set",
  );
  const second = review("story-answer", "2026-08-20T00:02:00.000Z", [{
    id: storiesDecision.id,
    response: "Use the smallest reversible best-practice card layout.",
  }]);
  const policy = completeProductDecisionMaterializationPolicy([first, second], artifacts);
  assert.ok(policy, "the full concrete history can safely upgrade a v1 capture into a lock");
  assert.equal(policy.responses.length, 2);
  assert.deepEqual(new Set(policy.sourceArtifactIds), new Set(artifacts.map(({ id }) => id)));

  const arbitraryLatest = review("arbitrary", "2026-08-20T00:03:00.000Z", [{
    id: "PRODUCT-QUESTION-V2-not-from-this-head",
    response: "Invent a different decision.",
  }]);
  assert.equal(
    completeProductDecisionMaterializationPolicy([first, arbitraryLatest], artifacts),
    null,
    "an arbitrary decision ID cannot close a reviewed head",
  );
});

test("CHAT-DECISION-MATERIALIZATION-04: an ordinary Review starts a new capture and replay epoch", () => {
  const prdArtifact = {
    id: "prd-epoch-1",
    artifactKey: "prd",
    content: "# PRD\n\n## Open Questions\n\n- [ ] PROD-LINKS-01: Should project entries include repository links?\n",
  };
  const storiesArtifact = {
    id: "stories-epoch-1",
    artifactKey: "user-stories",
    content: `## README.md\n\n${renderUserStoriesBlocker({
      status: "Blocked",
      knownFacts: ["The existing profile content remains available."],
      missingFacts: ["The AI SDLC presentation format is not selected."],
      openQuestions: ["Should AI SDLC experience use cards or a table?"],
      humanOwners: ["Product Owner"],
      nextSteps: ["Answer the question before Story authoring."],
    })}`,
  };
  const artifacts = [prdArtifact, storiesArtifact];
  const open = assessPhaseHumanDecisionGate({
    phaseId: "discovery",
    phaseStatus: "awaiting_review",
    artifacts,
    enforceUserStoriesQuality: true,
  });
  const prdDecision = open.items.find(({ artifactKey }) => artifactKey === "prd")!;
  const storiesDecision = open.items.find(({ artifactKey }) => artifactKey === "user-stories")!;
  const capture = (
    id: string,
    createdAt: string,
    responses: Array<{ id: string; response: string }>,
  ) => ({
    id,
    phaseRunId: "phase-epoch",
    decision: "request_changes" as const,
    comment: serializeHumanDecisionCapture({ phaseId: "discovery", responses }),
    artifactIds: artifacts.map(({ id: artifactId }) => artifactId),
    createdAt,
  });
  const olderCapture = capture("capture-before-boundary", "2026-08-20T00:01:00.000Z", [{
    id: prdDecision.id,
    response: "Include repository links for every project entry.",
  }]);
  const ordinaryReview = {
    id: "ordinary-review-boundary",
    phaseRunId: "phase-epoch",
    decision: "request_changes" as const,
    comment: "Please revise the product direction before continuing.",
    artifactIds: artifacts.map(({ id }) => id),
    createdAt: "2026-08-20T00:02:00.000Z",
  };
  const newerCapture = capture("capture-after-boundary", "2026-08-20T00:03:00.000Z", [{
    id: storiesDecision.id,
    response: "Use the smallest reversible best-practice card layout.",
  }]);

  const postBoundaryGate = assessPhaseHumanDecisionGate({
    phaseId: "discovery",
    phaseStatus: "changes_requested",
    artifacts,
    reviews: [olderCapture, ordinaryReview, newerCapture],
    enforceUserStoriesQuality: true,
  });
  assert.equal(postBoundaryGate.decisionCount, 1);
  assert.equal(postBoundaryGate.workCount, 1);
  assert.equal(postBoundaryGate.items.find(({ id }) => id === prdDecision.id)?.response, null);
  assert.match(
    postBoundaryGate.items.find(({ artifactKey }) => artifactKey === "user-stories")?.response ?? "",
    /best-practice card/u,
  );
  assert.doesNotMatch(
    buildHumanDecisionReplay(
      [olderCapture, ordinaryReview, newerCapture],
      artifacts,
    ).revisionFeedback.join("\n"),
    /repository links/u,
  );
  assert.equal(
    completeProductDecisionMaterializationPolicy(
      [olderCapture, ordinaryReview, newerCapture],
      artifacts,
    ),
    null,
    "captures separated by an ordinary Review cannot combine into a complete lock",
  );

  const completeAfterBoundary = capture("complete-after-boundary", "2026-08-20T00:04:00.000Z", [
    { id: prdDecision.id, response: "Include repository links for every project entry." },
    { id: storiesDecision.id, response: "Use the smallest reversible best-practice card layout." },
  ]);
  assert.ok(
    completeProductDecisionMaterializationPolicy(
      [olderCapture, ordinaryReview, completeAfterBoundary],
      artifacts,
    ),
    "a complete capture made after the boundary can start a new lock",
  );
});

test("CHAT-DECISION-MATERIALIZATION-05: defer, TBD, unknown, and keep-open responses never close a decision", () => {
  const prdArtifact = {
    id: "prd-non-closing-1",
    artifactKey: "prd",
    content: "# PRD\n\n**Status:** Ready for story authoring\n\n## Open Questions\n\n- None\n",
  };
  const storiesArtifact = {
    id: "stories-non-closing-1",
    artifactKey: "user-stories",
    content: `## README.md\n\n${renderUserStoriesBlocker({
      status: "Pending",
      knownFacts: ["The profile redesign is in scope."],
      missingFacts: ["The presentation format is not selected."],
      openQuestions: ["Should AI SDLC experience use cards or a table?"],
      humanOwners: ["Product Owner"],
      nextSteps: ["Select a presentation format."],
    })}`,
  };
  const artifacts = [prdArtifact, storiesArtifact];
  const decisionId = assessPhaseHumanDecisionGate({
    phaseId: "discovery",
    phaseStatus: "awaiting_review",
    artifacts,
    enforceUserStoriesQuality: true,
  }).items.find(({ kind }) => kind === "decision")!.id;
  const review = (id: string, response: string, createdAt = "2026-08-20T00:02:00.000Z") => ({
    id,
    phaseRunId: "phase-non-closing",
    decision: "request_changes" as const,
    comment: serializeHumanDecisionCapture({
      phaseId: "discovery",
      responses: [{ id: decisionId, response }],
    }),
    artifactIds: artifacts.map(({ id: artifactId }) => artifactId),
    createdAt,
  });

  for (const [index, response] of [
    "TBD",
    "Defer this decision until later.",
    "Unknown for now.",
    "Keep this decision open.",
    "待定",
    "继续开放",
  ].entries()) {
    const nonClosingReview = review(`non-closing-${index}`, response);
    const gate = assessPhaseHumanDecisionGate({
      phaseId: "discovery",
      phaseStatus: "changes_requested",
      artifacts,
      reviews: [nonClosingReview],
      enforceUserStoriesQuality: true,
    });
    assert.equal(gate.decisionCount, 1, `${response} must remain a human decision`);
    assert.equal(gate.items.find(({ id }) => id === decisionId)?.response, null);
    assert.equal(
      completeProductDecisionMaterializationPolicy([nonClosingReview], artifacts),
      null,
      `${response} must not create a materialization lock`,
    );
  }

  const olderConcrete = review(
    "older-concrete",
    "Use cards in the existing section order.",
    "2026-08-20T00:01:00.000Z",
  );
  const newerTbd = review("newer-tbd", "TBD", "2026-08-20T00:02:00.000Z");
  const superseded = assessPhaseHumanDecisionGate({
    phaseId: "discovery",
    phaseStatus: "changes_requested",
    artifacts,
    reviews: [olderConcrete, newerTbd],
    enforceUserStoriesQuality: true,
  });
  assert.equal(superseded.decisionCount, 1, "newer TBD must supersede an older concrete answer");
  assert.equal(
    completeProductDecisionMaterializationPolicy([olderConcrete, newerTbd], artifacts),
    null,
  );
});

test("CHAT-DECISION-IDENTITY-04: duplicate explicit IDs with different semantics fail closed without hiding either item", () => {
  const artifact = {
    id: "prd-duplicate-explicit-id",
    artifactKey: "prd",
    content: [
      "# PRD",
      "",
      "## Open Questions",
      "",
      "- [ ] PROD-PRESENTATION-01: Should AI SDLC experience use cards or a table?",
      "- [ ] PROD-PRESENTATION-01: Should project entries include repository links?",
      "",
    ].join("\n"),
  };
  const review = {
    id: "duplicate-id-answer",
    phaseRunId: "phase-duplicate-id",
    decision: "request_changes" as const,
    comment: serializeHumanDecisionCapture({
      phaseId: "discovery",
      responses: [{
        id: "PROD-PRESENTATION-01",
        response: "Use cards and include repository links.",
      }],
    }),
    artifactIds: [artifact.id],
    createdAt: "2026-08-20T00:01:00.000Z",
  };
  const gate = assessPhaseHumanDecisionGate({
    phaseId: "discovery",
    phaseStatus: "changes_requested",
    artifacts: [artifact],
    reviews: [review],
  });

  assert.equal(gate.decisionCount, 0);
  assert.equal(gate.workCount, 2);
  assert.equal(gate.blockingCount, 2);
  assert.equal(new Set(gate.items.map(({ id }) => id)).size, 2);
  assert.ok(gate.items.every(({ id }) => /^DECISION-ID-CONFLICT-[a-f0-9]{24}$/u.test(id)));
  assert.ok(gate.items.every(({ response }) => response === null));
  assert.ok(gate.items.some(({ prompt }) => /cards or a table/u.test(prompt)));
  assert.ok(gate.items.some(({ prompt }) => /repository links/u.test(prompt)));
});
