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
    title: "固化：独立 E2E 项目",
    description: "从权威 spec 冻结 AC 场景；旧 Run 只采用已批准的 User Story。点击生成或更新脚本，由全新会话写入独立 E2E workspace，再人工审核实际会执行的整套 tests/** 与 fixtures/** 的全部内容和 hash；不复制 MCP 探索记录，也不用手写特殊评论或 Markdown。",
  },
  {
    number: 3,
    title: "执行：脚本自己跑",
    description: "在当前 revision 用真实 playwright test 或项目命令执行，本地/CI 都不再使用 MCP；把命令、结果、报告和风险写进 test-report。",
  },
] as const;

export const TEST_REPORT_REVIEW_POINTS = [
  "MCP 探索是否被明确标为非门禁草稿，而不是验收通过证据",
  "需要的 E2E 脚本是否由新会话从批准规格固化到独立项目，并经过完整可执行脚本基线人工审核",
  "是否记录当前 revision 的真实 standalone/CI 命令、退出结果、report/trace，以及失败 owner 和下一步",
] as const;
