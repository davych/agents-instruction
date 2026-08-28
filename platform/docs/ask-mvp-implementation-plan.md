# Ask MVP 实施计划（历史记录）

状态：已由 Cloud SDLC MVP 取代
负责人：单人开发
最后更新：2026-08-28

## 为什么保留这份文件

这份文件最初描述的是“本地目录 + 浏览器 localStorage + 无状态 Ask”的早期方案。产品后来已经改成 browser-only 的 Cloud 路线，原计划中的本地路径、浏览器权威 history、无数据库表和“构建短 Prompt”等内容不再是实现或验收依据。

当前唯一的整体实施依据是 [Cloud SDLC Agent MVP 实施计划](cloud-sdlc-mvp-implementation-plan.md)。运行事实分别以 [Runtime Contract](runtime-contract.md)、[Security Model](security-model.md) 和 [Platform README](../README.md) 为准。

## 现在已经实现的 Ask

- Cloud Project 来自远程 HTTPS Git，不绑定用户本地目录。
- OpenAI、LM Studio、Ollama 和管理员配置的自定义兼容 Provider 都由服务端登记；浏览器不能覆盖 URL、协议或 Secret。
- Thread 与 Message 保存在 PostgreSQL，固定 Project、Provider、公开 revision 和 raw Git source revision；浏览器不提交权威 history。
- DeepWiki Lite 为 exact revision 提供确定性的文件、入口、文档、测试/构建和路径线索；它不是完整可浏览语义 Wiki。Ask 再按问题建立受限源码证据包并校验引用。
- 项目同步后，旧 Thread 继续读取旧 Snapshot。旧 Thread 整理成交付任务时，新 Run 也固定该旧 revision，不会静默切到最新源码。
- 交接前必须由人编辑并确认完整 Change Contract，包括工作类型、当前行为、目标行为、范围、验收条件和回归范围；Ask 不自动创建或执行阶段。
- Ask 仍然是只读辅助能力，不是第七阶段，也没有文件写入、Shell、提交、推送、PR、部署或发布权限。

## Prompt 的当前说法

用户不需要维护 `CLAUDE.md` 或一根长 Prompt。平台在运行时分层组装角色边界、阶段流程、模板、任务、DeepWiki 线索和已批准上游产物。这里不承诺最终 Prompt 很短：复杂产物上下文预算可达约 180,000 字符，达到边界时会截断或失败。

## 历史结论

早期 Ask 验证帮助确定了 Provider 抽象、只读检索、引用校验和明确人工交接，这些方向被保留。旧文档中的测试计数、localStorage 会话、无 DDL 和云端化前待办只代表当时快照，不再用于判断当前 Cloud 成品是否完成。
