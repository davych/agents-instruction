import type { PhaseDefinition, PhaseStatus, RoleDefinition } from "@/lib/types";

/**
 * Legacy compatibility snapshot used only when the API cannot supply a project definition.
 * The canonical structure remains templates/ai-native.yaml; a cross-package drift check keeps
 * role identity and the complete phase graph synchronized without adding YAML to the Web bundle.
 */
export const LEGACY_FALLBACK_CANONICAL_SOURCE = "templates/ai-native.yaml";

// Update this only after reviewing the localized role copy and every gate below
// against the canonical semantic fields covered by the API-side drift check.
export const LEGACY_FALLBACK_CANONICAL_SEMANTIC_SHA256 =
  "0688fa6eab70905eacb3c9951ede4c1c3be21376debd821f4ee6be66615562da";

export const FALLBACK_ROLES: RoleDefinition[] = [
  {
    id: "pm-ba",
    name: "PM / BA",
    mission: "在已记录的 Product 路由内产出最小充分的产品证据，避免为每个 Run 重写项目 PRD。",
    responsibilities: ["产品影响分析", "用户问题", "业务规则", "产品范围", "验收标准"],
  },
  {
    id: "designer",
    name: "Designer",
    mission: "把已确认的产品需求转化为清晰的界面行为与可供工程实现的设计交接。",
    responsibilities: ["用户旅程", "交互状态", "响应式行为", "可访问性", "设计验证"],
  },
  {
    id: "architect",
    name: "Architect",
    mission: "把已确认的产品与设计意图转化为有证据支撑的架构决策包。",
    responsibilities: ["架构候选方案", "系统边界", "决策记录", "可度量质量预算"],
  },
  {
    id: "software-engineer",
    name: "Software Engineer",
    mission: "把已确认合同实现为最小完整变更，并交付可独立验证的工程证据包。",
    responsibilities: ["实现", "验收追踪", "独立测试证据", "工程审查", "交付追溯"],
  },
  {
    id: "tester",
    name: "Tester",
    mission: "把已确认的需求与风险转化为独立、可重复的验证；Playwright MCP 仅用于可选探索，持久 E2E 通过显式关联工作区、临时 staging 独立编写、受控提升、完整基线人审与真实浏览器独立执行形成证据。",
    responsibilities: ["风险驱动测试设计", "可选浏览器探索", "关联 E2E 测试资产", "完整脚本基线 Hash 审核", "真实浏览器独立执行", "缺陷证据", "发布质量建议"],
  },
  {
    id: "devops",
    name: "DevOps",
    mission: "准备有证据约束、可重复、可观察、可回滚的发布路径，但不执行发布。",
    responsibilities: ["发布就绪度", "来源追溯验证", "上线指导", "健康与监控", "回滚规划", "事件升级"],
  },
];

export const FALLBACK_PHASES: PhaseDefinition[] = [
  {
    id: "discovery",
    name: "需求发现",
    owner: "pm-ba",
    inputs: [],
    outputs: ["change-contract", "prd", "user-stories"],
    gate: "当前 Run 的不可变 Change Contract 已存在；所选 Product disposition 对范围、业务规则、验收标准与目标回归提供了充分证据。",
  },
  {
    id: "design",
    name: "体验设计",
    owner: "designer",
    inputs: ["change-contract", "prd", "user-stories"],
    outputs: ["design-baseline", "design-spec", "design-prototype", "figma-handoff"],
    gate: "已记录明确的 Design disposition：skip 与 reuse 有有效证据，或所选设计产物完整、可追溯、ready-for-engineering 且无阻塞；只能在可运行实现上验证的检查已记录为 Tester 在 Verification 阶段负责的 deferred validations，而不是 Design blocker。",
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
    gate: "已记录明确的 Architecture disposition：skip 有有效的无影响证据，reuse 绑定当前已接受的架构证据，或所选 partial/full 产物完整并具备所需的人类选型与验收证据。",
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
    gate: "已确认的实现与必要测试均完成；每条验收标准都有独立测试证据，七镜审查与对抗审查完整，来源追溯链没有未解决阻塞。",
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
    gate: "验收标准、目标回归、主要风险与每项选定的延期 Design 验证都有当前执行证据；所需 E2E 脚本与人类批准的关联工作区完整可执行基线清单一致，并由平台监督在真实浏览器中独立执行；仅有 Playwright MCP 探索绝不能满足可重复 E2E 或 CI 证据。",
  },
  {
    id: "release",
    name: "发布准备",
    owner: "devops",
    inputs: [
      "change-contract",
      "architecture",
      "architecture-adrs",
      "architecture-nfrs",
      "architecture-adversarial",
      "implementation-notes",
      "engineering-provenance",
      "test-report",
    ],
    outputs: ["release-runbook"],
    gate: "发布手册绑定当前 Run，以及每个所选上游 artifact ID、项目相对路径和内容 Hash，并绑定实现与验证 revision 及适用的发布制品 digest；来源追溯与供应链适用性明确；前置条件、顺序化上线步骤、健康与 smoke 检查、监控阈值/窗口/负责人/动作、回滚触发条件/RTO/数据兼容性/恢复验证、事件升级、风险与人类 go/no-go 负责人均完整，且没有未解决的发布阻塞。该门禁只表示指导已就绪，不表示发布已批准或已执行。",
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

const PROVIDER_EXECUTOR_LABELS: Record<string, string> = {
  openai: "OpenAI",
  lmstudio: "LM Studio",
  ollama: "Ollama",
  custom: "Custom Provider",
};

/**
 * A running phase must name the executor proven by its persisted execution,
 * not by the current route. This keeps standalone Codex Runs truthful while a
 * Session-linked Provider-native Run is opened in the shared audit UI.
 */
export function phaseStatusLabel(status: PhaseStatus, command?: string): string {
  if (status !== "running") return STATUS_LABELS[status];
  if (!command) return "执行中";
  const providerExecution = /^provider-native:([a-z][a-z0-9-]*)$/u.exec(command);
  if (!providerExecution) return "Codex 执行中";
  const providerLabel = PROVIDER_EXECUTOR_LABELS[providerExecution[1] ?? ""] ?? "Provider";
  return `${providerLabel} 执行中`;
}

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
    "engineering-provenance": "交付追溯清单",
    "test-report": "测试报告",
    "release-runbook": "发布手册",
  };
  return labels[artifactId] ?? artifactId;
}
