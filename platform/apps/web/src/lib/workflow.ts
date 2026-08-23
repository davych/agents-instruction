import type { PhaseDefinition, PhaseStatus, RoleDefinition } from "@/lib/types";

export const FALLBACK_ROLES: RoleDefinition[] = [
  {
    id: "pm-ba",
    name: "PM / BA",
    mission: "把产品机会变成清晰的 PRD 与可验收用户故事。",
    responsibilities: ["用户问题", "业务规则", "范围", "验收标准"],
  },
  {
    id: "designer",
    name: "Designer",
    mission: "把确认的需求转化为可实现、可验证的交互设计。",
    responsibilities: ["用户旅程", "交互状态", "响应式", "可访问性"],
  },
  {
    id: "architect",
    name: "Architect",
    mission: "把产品与设计意图转化为有证据的架构决策。",
    responsibilities: ["架构方案", "系统边界", "ADR", "质量预算"],
  },
  {
    id: "software-engineer",
    name: "Software Engineer",
    mission: "把已确认合同实现为最小完整变更，并交付可独立验证的工程证据包。",
    responsibilities: ["实现", "验收追踪", "独立测试证据", "工程审查", "Provenance"],
  },
  {
    id: "tester",
    name: "Tester",
    mission: "验证需求、风险和回归范围。",
    responsibilities: ["测试设计", "缺陷证据", "质量结论"],
  },
  {
    id: "devops",
    name: "DevOps",
    mission: "建立可重复、可观察、可回滚的交付路径。",
    responsibilities: ["CI/CD", "部署", "监控", "回滚"],
  },
];

export const FALLBACK_PHASES: PhaseDefinition[] = [
  {
    id: "discovery",
    name: "需求发现",
    owner: "pm-ba",
    inputs: [],
    outputs: ["change-contract", "prd", "user-stories"],
    gate: "用户问题、范围、业务规则与验收标准已经清晰。",
  },
  {
    id: "design",
    name: "体验设计",
    owner: "designer",
    inputs: ["change-contract", "prd", "user-stories"],
    outputs: ["design-baseline", "design-spec", "design-prototype", "figma-handoff"],
    gate: "设计完整追溯用户故事，可供工程实现，且没有阻塞项。",
  },
  {
    id: "architecture",
    name: "架构决策",
    owner: "architect",
    inputs: ["change-contract", "prd", "user-stories", "design-spec"],
    outputs: [
      "architecture",
      "architecture-discovery-context",
      "architecture-options",
      "architecture-c4-context",
      "architecture-c4-containers",
      "architecture-adrs",
      "architecture-patterns",
      "architecture-nfrs",
      "architecture-adversarial",
    ],
    gate: "架构方向、边界、关键决策、质量预算和风险经过人工确认。",
  },
  {
    id: "implementation",
    name: "工程实现",
    owner: "software-engineer",
    inputs: [
      "change-contract",
      "prd",
      "user-stories",
      "design-baseline",
      "design-spec",
      "architecture",
      "architecture-c4-containers",
      "architecture-adrs",
      "architecture-patterns",
      "architecture-nfrs",
    ],
    outputs: [
      "implementation-notes",
      "implementation-plan",
      "implementation-tasks",
      "engineering-session-log",
      "engineering-test-evidence",
      "engineering-review",
      "engineering-provenance",
    ],
    gate: "实现与必要测试完成，每条验收标准有独立证据，七镜与对抗审查完整，证据链无阻塞。",
  },
  {
    id: "verification",
    name: "质量验证",
    owner: "tester",
    inputs: [
      "change-contract",
      "prd",
      "user-stories",
      "design-spec",
      "architecture",
      "architecture-nfrs",
      "implementation-notes",
      "engineering-test-evidence",
      "engineering-review",
    ],
    outputs: ["test-report"],
    gate: "验收标准、主要风险和延期设计验证都有真实证据。",
  },
  {
    id: "release",
    name: "发布准备",
    owner: "devops",
    inputs: [
      "architecture",
      "architecture-adrs",
      "architecture-nfrs",
      "architecture-adversarial",
      "test-report",
    ],
    outputs: ["release-runbook"],
    gate: "发布、监控和回滚步骤已准备。",
  },
];

export const PHASE_NAMES: Record<string, string> = Object.fromEntries(
  FALLBACK_PHASES.map((phase) => [phase.id, phase.name ?? phase.id]),
);

export const STATUS_LABELS: Record<PhaseStatus, string> = {
  pending: "尚未解锁",
  locked: "尚未解锁",
  ready: "可以开始",
  running: "Codex 执行中",
  awaiting_review: "等待人工审核",
  approved: "审核通过",
  changes_requested: "需要修改",
  rejected: "已驳回",
  failed: "执行失败",
};

export function getPhaseName(phase: PhaseDefinition) {
  return phase.name || PHASE_NAMES[phase.id] || phase.id;
}

export function artifactLabel(artifactId: string) {
  const labels: Record<string, string> = {
    "change-contract": "Change Contract",
    prd: "产品需求文档",
    "user-stories": "用户故事",
    "design-baseline": "设计基线",
    "design-spec": "设计规格",
    "design-prototype": "快速原型 HTML",
    "figma-handoff": "Figma 设计",
    architecture: "架构总览",
    "architecture-discovery-context": "架构发现上下文",
    "architecture-options": "架构候选方案",
    "architecture-c4-context": "C4 系统上下文",
    "architecture-c4-containers": "C4 容器视图",
    "architecture-adrs": "架构决策记录",
    "architecture-patterns": "架构模式",
    "architecture-nfrs": "非功能需求",
    "architecture-adversarial": "架构对抗审查",
    "implementation-notes": "实现说明",
    "implementation-plan": "实施计划",
    "implementation-tasks": "实施任务",
    "engineering-session-log": "工程会话日志",
    "engineering-test-evidence": "独立测试证据",
    "engineering-review": "工程七镜审查",
    "engineering-provenance": "PR 证据链",
    "test-report": "测试报告",
    "release-runbook": "发布手册",
  };
  return labels[artifactId] ?? artifactId;
}
