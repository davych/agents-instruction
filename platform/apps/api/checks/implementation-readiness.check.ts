import assert from "node:assert/strict";
import test from "node:test";

import { AppError } from "../src/domain/errors.ts";
import {
  assertImplementationReady,
  assessImplementationReadiness,
} from "../src/domain/implementation-readiness.ts";

const readyStories = {
  artifactKey: "user-stories",
  sourceStatus: "approved" as const,
  content: `## pinyin/US-001-level/story.md

# US-001: Choose a level

### US-001-AC-01: The learner can choose a permitted level
`,
};

const deferredValidation = {
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

test("AC-CLARITY-009/012: implementable inputs pass before code execution", () => {
  const result = assessImplementationReadiness({
    selectedArtifacts: [
      readyStories,
      {
        artifactKey: "prd",
        sourceStatus: "approved",
        content: "# PRD\n\n**Status:** Approved scope\n",
      },
      {
        artifactKey: "design-spec",
        sourceStatus: "approved",
        content: '```json\n{"status":"ready-for-engineering","blockers":[],"deferred_validations":[]}\n```',
      },
      {
        artifactKey: "architecture",
        sourceStatus: "approved",
        content: '# Architecture\n\n**Status:** Ready for human acceptance\n\n"state": "ready_for_human_acceptance"',
      },
    ],
  });
  assert.equal(result.ready, true);
  assert.equal(result.acceptanceCriteria.length, 1);
  assert.deepEqual(result.issues, []);
});

test("AC-CLARITY-009: reported upstream statuses are rejected as role-owned blockers", () => {
  assert.throws(
    () => assertImplementationReady({
      selectedArtifacts: [
        readyStories,
        {
          artifactKey: "prd",
          sourceStatus: "approved",
          content: "# PRD\n\n**Status:** Pending human decisions; not ready for downstream phase\n\n- B-01 pending",
        },
        {
          artifactKey: "design-spec",
          sourceStatus: "approved",
          content: '```json\n{"status":"blocked","blockers":[{"id":"B-01","decision":"Confirm the level model","owner":"PM / BA","next_action":"Record the chosen levels in the PRD"},{"id":"B-04","decision":"Validate the 320px layout","owner":"Designer","next_action":"Attach narrow-viewport evidence"}]}\n```',
        },
        {
          artifactKey: "architecture",
          sourceStatus: "approved",
          content: '# Architecture\n\n**Status:** Ready for human acceptance / Blocked\n\n- [ ] ARCH-04\n\n"state": "blocked"',
        },
      ],
    }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "IMPLEMENTATION_NOT_READY");
      assert.equal(error.statusCode, 409);
      const issues = (error.details as {
        issues?: Array<{
          code: string;
          role: string;
          blockers: Array<{ id: string; decision: string; nextAction: string }>;
        }>;
      })?.issues ?? [];
      assert.deepEqual(issues.map(({ code, role }) => [code, role]), [
        ["PRODUCT_BLOCKED", "pm-ba"],
        ["DESIGN_BLOCKED", "designer"],
        ["ARCHITECTURE_BLOCKED", "architect"],
      ]);
      assert.deepEqual(issues[1]?.blockers, [
        {
          id: "B-01",
          decision: "Confirm the level model",
          nextAction: "Record the chosen levels in the PRD",
          owner: "PM / BA",
        },
        {
          id: "B-04",
          decision: "Validate the 320px layout",
          nextAction: "Attach narrow-viewport evidence",
          owner: "Designer",
        },
      ]);
      return true;
    },
  );
});

test("AC-CLARITY-009: no authoritative criteria still fails before implementation", () => {
  const result = assessImplementationReadiness({
    selectedArtifacts: [{
      artifactKey: "implementation-notes",
      sourceStatus: "approved",
      content: "### US-999-AC-01: engineer-authored claim",
    }],
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.issues.map(({ code }) => code), ["ACCEPTANCE_CRITERIA_MISSING"]);
});

test("AC-DES-LOOP-005: only a formal deferred ledger is implementation-ready", () => {
  const formal = assessImplementationReadiness({
    selectedArtifacts: [
      readyStories,
      {
        artifactKey: "design-spec",
        sourceStatus: "approved",
        content: `\`\`\`json\n${JSON.stringify({
          status: "ready-for-engineering",
          blockers: [],
          deferred_validations: [deferredValidation],
        })}\n\`\`\``,
      },
    ],
  });
  assert.equal(formal.ready, true);

  for (const envelope of [
    {
      status: "blocked",
      blockers: [{
        id: "B-04",
        decision: "实现可运行后验证 320px",
        owner: "Designer",
        next_action: "实现完成后执行浏览器验证",
      }],
    },
    {
      status: "ready-for-engineering",
      blockers: [],
      deferred_validations: [{ ...deferredValidation, checks: [] }],
    },
  ]) {
    const result = assessImplementationReadiness({
      selectedArtifacts: [
        readyStories,
        {
          artifactKey: "design-spec",
          sourceStatus: "approved",
          content: `\`\`\`json\n${JSON.stringify(envelope)}\n\`\`\``,
        },
      ],
    });
    assert.equal(result.ready, false);
    assert.deepEqual(result.issues.map(({ code }) => code), ["DESIGN_BLOCKED"]);
  }
});

test("AC-DES-LOOP-005: malformed design JSON and blocker types fail closed before code", () => {
  for (const content of [
    '\`\`\`json\n{"status":"ready-for-engineering","blockers":"B-04 unresolved"}\n\`\`\`',
    '\`\`\`json\n{"status":"ready-for-engineering","blockers":[]\n\`\`\`',
  ]) {
    const result = assessImplementationReadiness({
      selectedArtifacts: [
        readyStories,
        { artifactKey: "design-spec", sourceStatus: "approved", content },
      ],
    });
    assert.equal(result.ready, false);
    assert.deepEqual(result.issues.map(({ code }) => code), ["DESIGN_BLOCKED"]);
  }
});
