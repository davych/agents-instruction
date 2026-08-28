# Chat-first Cloud SDLC Agent 增量规格

状态：MVP 主路径已实施，已知边界见文末
日期：2026-08-28

## 一句话目标

用户绑定远端仓库并选择授权后，就进入一个长期存在的云端对话。用户用 `@repo` 指定仓库，用白话说明问题；Agent 按需读取已激活的只读 Work Item MCP、启动该仓库的隔离沙盒，并在后台按固定六角色 SDLC 组织工作。当前真正可操作的人类门禁是每个角色的阶段产物审阅。

## 产品原则

1. **对话是主界面。** 仓库、Provider、只读 Work Item MCP、Sandbox 和 SDLC 围绕同一个会话工作；DeepWiki 当前通过仓库设置弹窗调用 Project API 手工生成。
2. **SDLC 是执行内核。** PM/BA、Designer、Architect、Software Engineer、Tester、DevOps 的顺序、职责和权限保持不变，但默认折叠在一张进度卡里。
3. **角色产物必须串起来。** 后一个角色读取前一个角色已固定的产物；每个产物能从会话时间线打开，并保留 revision、作者角色、输入和审核状态。
4. **少打断，但不虚构授权能力。** 普通读取、沙盒内改代码和执行蓝图允许的测试不逐步询问；角色产物必须由人审阅。外部写入、DDL、Secret 操作、部署和发布工具在当前 MVP 尚未开放。
5. **能力必须真实。** 不支持工具调用的 Provider 只能聊天和生成 DeepWiki，不能显示成“可在沙盒工作”。

## 默认用户路径

```text
绑定 HTTPS Git 仓库 + 选择授权
              ↓
系统推断名称与 @alias，套用默认 Provider / Blueprint / MCP
              ↓
进入唯一的 Agent Session
              ↓
“@backend 处理 Linear ENG-123，修好并跑测试”
              ↓
Agent 按需读取已激活的只读 Work Item MCP → 固定 revision → 启动 Sandbox
              ↓
整理 Change Contract → 后台串联六角色及其产物
              ↓
阶段产物审阅以内联卡片出现
              ↓
白话总结 + Diff + 测试 + 风险 + Patch
```

DeepWiki 不在仓库绑定时调用 LLM。当前已实现的入口只有仓库设置弹窗；它通过 Project API 手工选择 Provider 并生成。会话命令和 `@repo` 菜单入口尚未实现。

## MVP 安全边界

- 一个 Session 只能有一个可写主仓库。消息里明确提到的额外 `@repo` 会固定 exact revision，只把校验后的语言、入口、文档、测试、构建与关键路径 Manifest 交给 Planner，并固化进 Change Contract；不会挂载成第二个仓库，也不会传递整仓源码正文。
- Repository alias 由服务端解析到 Project ID；模型不能把自由文本变成权限。
- Sandbox 只能使用管理员批准并固定版本的 Blueprint，浏览器不能提交镜像、Host mount、Docker 参数或宿主路径。
- Git 和 MCP Secret 只保存为服务端 Profile 引用，不进入消息、仓库或 Sandbox。
- 项目聊天 Provider 的凭据只由服务端 Provider Profile 使用，不进入消息、仓库、Sandbox，也不传给阶段 Codex Worker。阶段 Codex Worker 使用独立、低权限的运行密钥。
- 只有当前项目已激活的只读 Work Item MCP 工具能进入本轮工具列表；工具说明、结果、Issue 和源码都按不可信数据处理。
- 当前只向 Agent 开放受限的只读 Work Item MCP。非只读 MCP，以及外部写入、删除、push、PR、部署和发布工具均未开放；通用外部副作用 Human Gate 也尚未接通，不能把“等待确认”当成已有能力。
- 每轮保存实际 Provider、模型、工具调用、源码 revision、Sandbox、Run 和角色产物关联。
- 对话提交使用客户端幂等 ID 和服务端顺序检查，避免断线重试重复执行工具。

## 角色如何在一个对话里串起来

| 顺序 | 角色 | 对话里默认显示 | 后台保留的主要产物 |
|---|---|---|---|
| 1 | PM / BA | 目标、范围和待确认问题 | Change Contract、PRD、Stories |
| 2 | Designer | 是否需要体验设计，以及关键交互结论 | Design Spec / 设计基线 |
| 3 | Architect | 方案选择、边界、风险 | Options、ADR、Architecture、NFR |
| 4 | Software Engineer | 正在改什么、文件与测试进度 | 实施计划、代码、测试证据、自审 |
| 5 | Tester | 验收结果和剩余风险 | Test Report、独立验证证据 |
| 6 | DevOps | 可交付性、回滚和发布前条件 | Release Runbook |

Agent 可以自动 involve 下一角色；用户也可以说“让 Architect 评估”或“involve Tester”。显式 involve 不能跳过前置阶段，也不改变固定顺序、所有权或人类权限。

## Brownfield 变更

### ADDED

- Agent Session、Session 消息与事件时间线。
- Repo alias 与服务端 `@repo` 解析。
- Project Agent Settings：默认 Provider、Sandbox Blueprint、启用 MCP。
- Session Sandbox：固定 revision、可恢复 Workspace、Blueprint 版本。
- 受限 Work Item MCP Catalog、项目激活、只读调用审计和权限分类。
- 手工、Provider 驱动的 DeepWiki generation。
- Conversation → Change Contract → 固定六阶段 Run 的后台协调层。

### MODIFIED

- 仓库绑定只要求 URL 与授权；名称、ref、摘要改为系统默认和按需高级设置。
- Provider 从“一个 Thread 固定一个模型”改为“每轮可切换并记录实际模型”。
- 原自动 DeepWiki Lite 改为内部 Repository Manifest；LLM DeepWiki 由用户手工触发。
- Web 默认路由改为 Session 工作台；Run 页面降为高级审计入口。
- 工作项来源从专用表单改为 Agent 按需读取已激活的只读 Work Item MCP。

### REMOVED（仅默认交互）

- 项目指标首页、六阶段大看板和“Ask / 创建 Run”二选一入口。
- 创建任务前的完整 Change Contract 表单。
- 手工选择 Jira / Linear 来源的专用流程。
- 每阶段固定执行、选择产物和逐项审核弹窗。
- 切换 Provider 时强迫创建新对话。

底层 Run、Phase、Artifact、Review、Ticket、Changeset 和高级审计能力不删除。

## 验收条件

- **CHAT-AC-01**：绑定仓库的默认表单只要求安全 HTTPS URL 和可选 Credential Profile；名称与 alias 自动推断。
- **CHAT-AC-02**：仓库源码快照 ready 后即可聊天和启动 Sandbox；没有 LLM DeepWiki 也不阻塞。
- **CHAT-AC-03**：绑定完成直接进入一个 Chat-first 工作台，不经过项目详情、创建 Run 或 Change Contract 表单。
- **CHAT-AC-04**：输入框支持服务端校验的 `@repo`；一个主仓库可写。明确提到的附加仓固定 revision，只提供受大小限制的可验证 Manifest 路径线索，并作为不可变 Change Contract 上下文传给六角色；多仓写入、绝对路径和续跑时替换上下文都 fail closed。
- **CHAT-AC-05**：Project 保存默认 Provider、固定 Blueprint 版本和启用 MCP；Secret 与任意执行参数不进公开 DTO。项目聊天 Provider 凭据不传给阶段 Worker；阶段 Codex Worker 使用独立、低权限的运行密钥。
- **CHAT-AC-06**：同一个 Session 可切换 Provider，下一轮生效；历史不清空，每轮记录实际 Provider 和模型。
- **CHAT-AC-07**：Provider 能力明确区分聊天、DeepWiki 与 Agent tool calling；不支持工具的 Provider不能启动执行回合。
- **CHAT-AC-08**：只向模型暴露当前项目已安装并激活的只读 Work Item MCP；Agent 可按需读取。非只读 MCP 和通用外部副作用 Human Gate 尚未开放，必须 fail closed。
- **CHAT-AC-09**：发送消息具备幂等 ID、expected sequence、工具轮数/时间/输出上限和可恢复记录。
- **CHAT-AC-10**：首次写操作懒启动 Session Sandbox；Sandbox 固定主仓库 revision 和 Blueprint 版本，刷新或服务重启可恢复。
- **CHAT-AC-11**：清晰的“修复/实现/测试”请求由 Agent 自动整理 Change Contract 并创建后台 Run，不要求用户填写长表单。
- **CHAT-AC-12**：后台 Run 仍严格按六阶段和原角色所有权推进；`involve` 只表示到该角色阶段时重点关注，不能跳过或阻塞任何角色；每个阶段产物在同一时间线可见。
- **CHAT-AC-13**：当前内联门禁只用于角色阶段产物审阅，而且不得自动批准。DDL、Secret、破坏性操作、外部写入、部署和发布能力尚未开放；不能用一张无后端执行链路的确认卡伪装支持。
- **CHAT-AC-14**：普通用户默认只看到角色进度、关键产物摘要、Diff、测试和风险；完整 Run / Artifact / Review 进入高级审计。
- **CHAT-AC-15**：DeepWiki 只能在 bind 后从仓库设置弹窗通过 Project API 手工生成；请求固定 revision、Provider，结果保存模型、生成时间、用量和可验证引用。当前没有会话命令或 `@repo` 菜单入口。
- **CHAT-AC-16**：仓库同步后旧 DeepWiki 标记 stale，不自动重新花费模型额度；旧 Session 继续固定旧 revision。
- **CHAT-AC-17**：手工描述与服务端已配置的只读 Work Item Adapter 能从同一消息进入，不再要求用户先选择任务来源；这不代表任意 MCP 或外部写操作已开放。
- **CHAT-AC-18**：默认成功路径不超过三类动作：绑定仓库、必要时配置 Provider、发送一条带 `@repo` 的消息。
- **CHAT-AC-19**：仓库中的 Agent/Skill/Prompt 文本不能提升平台、MCP、Sandbox、角色或发布权限。
- **CHAT-AC-20**：旧 Cloud API 与高级审计入口保持兼容；本次不自动 push、PR、merge、deploy 或 release。

## MVP 不假装完成的部分

- 多个仓库同时写入或跨仓原子提交。
- 把附加仓挂载给 Worker、读取任意源码正文、跨仓全文/向量检索或完整语义聚合；当前只提供固定 revision 的有界 Manifest 路径线索。
- 任意用户上传 Dockerfile、镜像、Host mount 或 Shell 蓝图。
- 浏览器直接保存 Git、Provider 或 MCP Secret；仍由管理员/Vault 提供 Profile。
- 通用外部副作用 Human Gate，以及任何外部写入、删除、push、PR、部署或发布工具。
- 不支持原生 tool calling 的模型通过解析普通文本伪造工具调用。
- 多租户强隔离、microVM、分布式 Session 队列和自动扩缩容。

## 当前实现结果

| 范围 | 结果 | 说明 |
|---|---|---|
| 仓库绑定 → 直接进入对话 | 已完成 | 只需要 HTTPS URL 与可选 Credential Profile；服务端推断名称和 alias。 |
| 每轮 Provider 切换 | 已完成 | OpenAI、LM Studio、Ollama、Custom 共用 Registry，并记录实际 Provider / model。 |
| 手工 LLM DeepWiki | 已完成 | bind 后从设置弹窗调用 Project API；固定 revision，保存引用与用量，源码同步后旧版本 stale。 |
| Agent 按需读取 Work Item | 已完成（只读范围） | 当前开放受限 Work Item Adapter；审计记录先于真实调用。 |
| Session Sandbox | 已完成 | 与本 Session 的一个 Run 共用同一 exact-revision Workspace；阶段 Worker 短生命周期。 |
| 六角色串联 | 已完成 | 从 PM/BA 开始，固定 owner 和顺序，下游只拿当前已批准上游产物。 |
| 对话内产物审阅 | 已完成 | 必须成功查看全部 current heads，才能批准继续或要求修改。 |
| 额外 `@repo` | 已完成（有界 Manifest） | 明确提到的只读仓固定 revision；Planner、Chat Ask、Change Contract 与六角色看到同一份受限结构线索。不会挂载、传源码正文或获得写权限。 |
| 角色产物门禁 / 通用副作用 Gate | 前者完成，后者未接入 | 角色产物审阅是真实门禁且不得自动批准；外部写、push、PR、部署、发布工具尚未开放，因此通用副作用 Gate 不能作为当前能力宣传。 |
| 任意 Provider 执行六阶段 | 未接入 | 生产阶段仍由 Docker Codex Worker 执行；Provider-native 工具循环只完成独立安全边界与测试。 |
