# Tasks

每个具体任务在此目录创建一个 Markdown 文件，记录目标、负责人、输入、输出、验收标准、进度和交接证据。平台管理的每个 Run 还会生成一份不可变、任务级 `change-contract`，作为六阶段影响判断的共同输入，并为 Design、Implementation、Verification 与 Release 的 Run-scoped 产物固定独立路径，避免并行任务互相覆盖。

任务必须遵循 `ai-native.yaml` 和 `.ai-sdlc/workflows/default.md`。

角色可以因为 `direct`、`skip`、`reuse` 或经审核的局部影响处置而不做完整重跑，但影响判断、来源版本、理由、验收标准和回归证据不能省略。Bug 快速通道也必须进入 Tester，不能用“无需设计/架构变更”替代验证。Release 只准备绑定当前 Run 与选中输入哈希的 runbook；部署、回滚和最终 go/no-go 仍由明确授权的人类负责人决定。

直接 IDE 会话与 Web 使用同一角色、阶段 owner 和 artifact 合同，但只有平台真实产生的持久化审核、语义门禁、Linked E2E 与 runner 事件才能作为 Web 可信证据；不得在任务文件中自行声称这些事件已经发生。
