export interface ReleaseFlowStep {
  number: number;
  title: string;
  description: string;
}

export const RELEASE_FLOW_STEPS: ReleaseFlowStep[] = [
  {
    number: 1,
    title: "核对发布准入",
    description: "确认 Verification 当前证据、变更范围、依赖与未关闭事项；证据不完整时不得准备放行。",
  },
  {
    number: 2,
    title: "编写发布手册",
    description: "写清前置条件、执行步骤、负责人、观察窗口、监控信号和可验证的回滚步骤。",
  },
  {
    number: 3,
    title: "人工审核准备度",
    description: "逐项确认步骤可执行、状态可观察、失败可回滚，并记录仍需外部审批或协调的事项。",
  },
  {
    number: 4,
    title: "交接给实际执行者",
    description: "本工作流只交付经审核的准备材料；部署、发布、推送、合并与环境变更仍需另行授权并执行。",
  },
];

export const RELEASE_REVIEW_POINTS = [
  "发布前置条件与准入证据",
  "可复现的执行顺序和负责人",
  "监控信号、观察窗口与停止条件",
  "可验证的回滚步骤",
  "外部审批、环境权限与执行边界",
] as const;

export const RELEASE_COMPLETION_BOUNDARY =
  "这里只确认发布准备材料已经过人工审核；平台没有执行部署、发布、推送、合并或任何环境变更。";
