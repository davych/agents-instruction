import { TESTER_E2E_CRYSTALLIZATION_REVIEW_PREFIX } from "@ai-sdlc/contracts";

export const TESTER_FLOW_SUMMARY =
  "Before Verification execution, review the current engineering handoff. MCP success is not evidence and cannot pass Verification by itself.";

export const TESTER_FLOW_STEPS = [
  {
    number: 0,
    title: "先审核工程交接",
    description: "先看实现说明 → 独立测试证据 → 工程七镜，并确认真实代码、测试和证据来自同一当前 revision。",
  },
  {
    number: 1,
    title: "探索：MCP 直接跑",
    description: "需要发现交互路径时用 Playwright MCP 操作浏览器；跑通只是一次性诊断草稿，不是证据，不能判定验收通过，也不能通过 CI。",
  },
  {
    number: 2,
    title: "固化：全新独立会话",
    description: `从权威 spec 冻结 AC 场景，不能复制探索代码/记录；缺少 *.spec.ts 时在 Verification 选择“要求修改”，评论首行精确写“${TESTER_E2E_CRYSTALLIZATION_REVIEW_PREFIX} <非空场景>”，随后每个当前合同 ID 单独写“AC: <ID>”，再写唯一“Frozen intent: <可观察行为>”，由 Software Engineer 集成并刷新工程证据。`,
  },
  {
    number: 3,
    title: "执行：脚本自己跑",
    description: "在当前 revision 用真实 playwright test 或项目命令执行，本地/CI 都不再使用 MCP；把命令、结果、报告和风险写进 test-report。",
  },
] as const;

export const TEST_REPORT_REVIEW_POINTS = [
  "MCP 探索是否被明确标为非门禁草稿，而不是验收通过证据",
  "需要的 E2E 脚本是否由新会话从 spec 固化，并经 Software Engineer 集成、刷新证据和重新审批",
  "是否记录当前 revision 的真实 standalone/CI 命令、退出结果、report/trace，以及失败 owner 和下一步",
] as const;
