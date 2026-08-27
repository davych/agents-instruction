import assert from "node:assert/strict";
import test from "node:test";

import { artifactLabel, FALLBACK_PHASES } from "../src/lib/workflow.js";
import {
  ENGINEERING_ARTIFACT_GUIDES,
  ENGINEERING_FLOW_STEPS,
  engineeringEvidenceGateGuidance,
  implementationReadinessGuidance,
} from "../src/lib/engineering-workflow.js";
import { readRunUiSource } from "./support/run-ui-source.ts";

const engineeringOutputs = [
  "implementation-notes",
  "implementation-plan",
  "implementation-tasks",
  "engineering-session-log",
  "engineering-test-evidence",
  "engineering-review",
  "engineering-provenance",
] as const;

test("AC-ENG-003/006: fallback workflow exposes all seven implementation outputs", () => {
  const implementation = FALLBACK_PHASES.find((phase) => phase.id === "implementation");
  const verification = FALLBACK_PHASES.find((phase) => phase.id === "verification");

  assert.deepEqual(implementation?.outputs, engineeringOutputs);
  assert.deepEqual(
    verification?.inputs.slice(-3),
    ["implementation-notes", "engineering-test-evidence", "engineering-review"],
  );
});

test("AC-ENG-006: every engineering output has a unique human-readable label", () => {
  const labels = engineeringOutputs.map((artifactKey) => artifactLabel(artifactKey));
  assert.equal(new Set(labels).size, engineeringOutputs.length);

  const expectedMeaning: ReadonlyArray<RegExp> = [
    /implementation|实现|索引|说明/iu,
    /plan|计划/iu,
    /task|任务/iu,
    /session|会话|日志|记录/iu,
    /independent|test|独立|测试|验证/iu,
    /review|lens|审查|评审|七镜/iu,
    /provenance|追溯|溯源|来源/iu,
  ];
  labels.forEach((label, index) => {
    assert.notEqual(label, engineeringOutputs[index]);
    assert.match(label, expectedMeaning[index]!);
  });
  assert.equal(artifactLabel("engineering-provenance"), "交付追溯清单");
  assert.doesNotMatch(artifactLabel("engineering-provenance"), /PR/iu);
});

test("AC-CLARITY-001/002: the UI models four steps and explains every artifact", () => {
  assert.equal(ENGINEERING_FLOW_STEPS.length, 4);
  assert.match(ENGINEERING_FLOW_STEPS[1]?.title ?? "", /实施.*写代码/iu);
  assert.match(ENGINEERING_FLOW_STEPS[1]?.description ?? "", /修改源码.*测试.*证据/iu);
  assert.deepEqual(
    new Set(ENGINEERING_ARTIFACT_GUIDES.map(({ key }) => key)),
    new Set(engineeringOutputs),
  );
  for (const guide of ENGINEERING_ARTIFACT_GUIDES) {
    assert.ok(guide.stage.length > 0);
    assert.ok(guide.timing.length > 0);
    assert.ok(guide.purpose.length > 20);
    assert.ok(guide.humanCheck.length > 15);
  }
  assert.match(ENGINEERING_FLOW_STEPS[2]?.description ?? "", /只需.*实现.*测试.*风险.*不要求.*Markdown/iu);
  const provenanceGuide = ENGINEERING_ARTIFACT_GUIDES.find(({ key }) => key === "engineering-provenance");
  assert.match(provenanceGuide?.purpose ?? "", /交付追溯清单.*不是实际 PR.*不表示.*创建.*发布 PR/iu);
  assert.match(provenanceGuide?.humanCheck ?? "", /未创建或发布 PR.*合并.*发布.*人/iu);
});

test("AC-CLARITY-003: the Implementation CTA says when real code work starts", async () => {
  const source = await readRunUiSource();
  assert.match(source, /检查条件并开始写代码/iu);
  assert.match(source, /证据文档.*自动生成/iu);
});

test("AC-CLARITY-004/005: approval errors become deduplicated recovery actions", () => {
  const guidance = engineeringEvidenceGateGuidance({
    code: "ENGINEERING_EVIDENCE_GATE_FAILED",
    details: {
      issues: [
        "engineering evidence: at least one authoritative acceptance criterion is required",
        "implementation-notes: explicit Failed or Blocked disposition prevents approval",
        "implementation-plan: unresolved <...> or {{...}} placeholder found",
        "implementation-plan: unresolved <...> or {{...}} placeholder found",
      ],
    },
  });
  assert.ok(guidance);
  assert.equal(guidance.actions.length, 3);
  assert.equal(guidance.issueCount, 4);
  assert.match(guidance.actions[0]?.title ?? "", /验收标准/iu);
  assert.match(guidance.actions[0]?.description ?? "", /产品阶段.*不要.*自造/iu);
  assert.match(guidance.actions[1]?.description ?? "", /阻塞.*完整重跑.*不要.*Ready/iu);
  assert.equal(guidance.actions[1]?.artifactKey, "implementation-notes");
  assert.match(guidance.actions[2]?.description ?? "", /<\.\.\.>.*\{\{\.\.\.\}\}.*TBD.*TODO.*上游.*重跑/iu);
  assert.equal(guidance.actions[2]?.artifactKey, "implementation-plan");
  assert.equal(guidance.diagnostics.length, 4, "raw diagnostics remain available");
  assert.equal(engineeringEvidenceGateGuidance({ code: "OTHER" }), null);
});

test("AC-CLARITY-020/021/022/025: an active gate failure becomes one five-document evidence repair", () => {
  const guidance = engineeringEvidenceGateGuidance({
    code: "ENGINEERING_EVIDENCE_GATE_FAILED",
    details: {
      issues: [
        "implementation-notes: Status must be exactly Ready for verification",
        "implementation-notes: Evidence index does not link engineering-session-log",
        "implementation-notes: Evidence index does not link engineering-test-evidence",
        "implementation-notes: Evidence index does not link engineering-review",
        "implementation-notes: Evidence index does not link engineering-provenance",
        "engineering-session-log: Outcome must record a complete, non-blocked result",
        "engineering-session-log: Verification gates contains a downstream Tester deferral that must move to Outcome or limitations",
        "engineering-test-evidence: Tier A requires a concrete test-authoring model/session",
        "engineering-test-evidence: acceptance criterion US-001-AC-01 has no passing automated-test row",
        "engineering-review: section \"Behaviour Preservation\" actionable finding lacks stable ENG-REV-<three-digits> ID, severity, finding, durable evidence, impact, required action, non-Agent owner, terminal status, resolution evidence",
        "engineering-review: adversarial method \"Pre-mortem\" must contain a finding or none found",
        "engineering-provenance: evidence field \"Spec\" must contain a durable artifact, path, or URL reference",
        "engineering-provenance: Publication boundary must state that PR publication, merge, and release were not performed by Software Engineer",
      ],
    },
  });

  assert.ok(guidance);
  assert.equal(guidance.issueCount, 13);
  assert.deepEqual(guidance.affectedArtifactKeys, [
    "implementation-notes",
    "engineering-session-log",
    "engineering-test-evidence",
    "engineering-review",
    "engineering-provenance",
  ]);
  assert.equal(guidance.recommendation.kind, "repair-evidence");
  assert.deepEqual(guidance.recommendation.outputKeys, guidance.affectedArtifactKeys);
  assert.match(guidance.summary, /5 份证据.*13.*不需要.*重写.*代码/iu);
  assert.equal(guidance.actions.length, 5);
  assert.deepEqual(guidance.actions.map(({ issueCount }) => issueCount), [5, 2, 2, 2, 2]);
  assert.match(guidance.actions[0]?.reasons.join(" ") ?? "", /Ready for verification.*索引.*工程会话日志/iu);
  assert.match(guidance.actions[1]?.reasons.join(" ") ?? "", /Tester.*误放.*Outcome.*交接/iu);
  assert.match(guidance.actions[2]?.reasons.join(" ") ?? "", /Tier A.*测试作者.*US-001-AC-01.*测试路径.*证据.*Pass/iu);
  assert.match(guidance.actions[3]?.reasons.join(" ") ?? "", /Behaviour Preservation.*表格.*Pre-mortem/iu);
  assert.doesNotMatch(guidance.actions.map(({ title }) => title).join(" "), /检查写代码后的/u);
});

test("AC-CLARITY-022: real implementation failures recommend a full rerun", () => {
  const guidance = engineeringEvidenceGateGuidance({
    code: "ENGINEERING_EVIDENCE_GATE_FAILED",
    details: {
      issues: [
        "implementation-tasks: every task must be complete; unfinished: ENG-TASK-004",
        "engineering-session-log: Verification gates contains an explicit blocked or failed gate result",
        "engineering-test-evidence: Commands and results contains a failed, skipped, blocked, or unrun command",
      ],
    },
  });
  assert.ok(guidance);
  assert.equal(guidance.recommendation.kind, "rerun-implementation");
  assert.deepEqual(guidance.recommendation.outputKeys, engineeringOutputs);
  assert.match(guidance.recommendation.title, /完整重跑.*Software Engineer/iu);
});

test("AC-CLARITY-023: the review dialog exposes batch and per-artifact repair controls", async () => {
  const source = await readRunUiSource();
  assert.match(source, /让 Software Engineer 只修复这.*份证据/u);
  assert.match(source, /只重跑.*份证据/u);
  assert.match(source, /全部 .* 条原始校验信息/u);
  assert.match(source, /onRerunOutputs/u);
  assert.match(source, /本次目标是按机器反馈修复已选记录.*不能只改文字冒充通过/u);
  assert.match(source, /isImplementationEvidenceRepair/u);
  assert.match(source, /检查并修复工程证据/u);
  assert.match(source, /代码与测试作为事实基线，若事实不成立则停止并报告/u);
  assert.match(source, /检查条件并开始写代码/u, "full implementation keeps the code-writing CTA");
});

test("AC-CLARITY-011/012: blocked inputs explain why code execution never started", () => {
  const guidance = implementationReadinessGuidance({
    code: "IMPLEMENTATION_NOT_READY",
    details: {
      issues: [
        {
          code: "PRODUCT_BLOCKED",
          role: "pm-ba",
          title: "产品定义仍有人工决定未完成",
          detail: "PRD is pending.",
          blockerIds: ["B-01"],
        },
        {
          code: "DESIGN_BLOCKED",
          role: "designer",
          title: "设计还不能交给工程实现",
          detail: "Design status=blocked.",
          blockerIds: ["B-01", "B-04"],
          blockers: [{
            id: "B-01",
            decision: "确定关卡顺序与解锁规则",
            owner: "PM / BA",
            nextAction: "在 PRD 中记录唯一决定",
          }],
        },
        {
          code: "ARCHITECTURE_BLOCKED",
          role: "architect",
          title: "架构包仍明确标记为 Blocked",
          detail: "Architecture is blocked.",
          blockerIds: ["ARCH-04"],
        },
      ],
    },
  });
  assert.ok(guidance);
  assert.match(guidance.summary, /创建 Codex 执行前停止.*不会.*正在写代码.*不会.*Blocked Markdown/iu);
  assert.deepEqual(guidance.actions.map(({ roleLabel }) => roleLabel), ["PM / BA", "Designer", "Architect"]);
  assert.deepEqual(guidance.actions[1]?.blockerIds, ["B-01", "B-04"]);
  assert.deepEqual(guidance.actions[1]?.blockers, [{
    id: "B-01",
    decision: "确定关卡顺序与解锁规则",
    owner: "PM / BA",
    nextAction: "在 PRD 中记录唯一决定",
  }]);
});

test("AC-CLARITY-010/011: normal Implementation presents automatic bundles instead of choices", async () => {
  const source = await readRunUiSource();
  assert.match(source, /实施依据（平台自动选择）/u);
  assert.match(source, /这里没有需要你决定的选项/u);
  assert.match(source, /工程证据包（平台自动生成）/u);
  assert.match(source, /1 个工程结果包/u);
  assert.match(source, /不需要在这里选 Markdown/u);
  assert.match(source, /重新实施并刷新全部证据/u);
});

test("AC-CLARITY-013: Implementation review prioritizes three human-facing documents", async () => {
  const source = await readRunUiSource();
  assert.match(source, /建议先看 3 份/u);
  assert.match(source, /实现说明 → 独立测试证据 → 工程七镜/u);
  assert.match(source, /通常不用逐字阅读.*自动检查全部 7 份/u);
  assert.match(source, /只需看实现、测试和风险.*不要求编辑 Markdown.*通过并解锁 Tester/u);
  assert.match(source, /交付追溯清单不是实际 PR.*Software Engineer 未创建或发布 PR/u);
  assert.match(source, /已核对实现、自动化测试与风险，无未解决工程阻塞，同意进入 Tester/u);
  assert.match(source, /检查证据并解锁 Tester/u);
  assert.match(source, /implementation-notes[\s\S]*engineering-test-evidence[\s\S]*engineering-review/u);
});
