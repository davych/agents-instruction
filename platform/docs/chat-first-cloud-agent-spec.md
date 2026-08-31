# Chat-first Cloud SDLC Agent 增量规格

状态：MVP 主路径已实施，已知边界见文末
日期：2026-08-29

## 一句话目标

用户绑定远端仓库并选择授权后，就进入一个长期存在的云端对话。用户用 `@repo` 指定仓库，用白话说明问题；Agent 按需读取已激活的只读 Work Item MCP、启动该仓库的隔离沙盒，并在后台按固定六角色 SDLC 组织工作。当前真正可操作的人类门禁是每个角色的阶段产物审阅。

## 产品原则

1. **对话是主界面。** 仓库、Provider、只读 Work Item MCP、Sandbox 和 SDLC 围绕同一个会话工作；DeepWiki 当前通过仓库设置弹窗调用 Project API 手工生成。
2. **SDLC 是执行内核。** PM/BA、Designer、Architect、Software Engineer、Tester、DevOps 的顺序、职责和权限保持不变，但默认折叠在一张进度卡里。
3. **角色产物必须串起来。** 后一个角色读取前一个角色已固定的产物；每个产物能从会话时间线打开，并保留 revision、作者角色、输入和审核状态。
4. **少打断，但不虚构授权能力。** 普通读取和沙盒内受限文件修改不逐步询问；只有真正暴露的 Blueprint allowlist 检查才能算执行证据。角色产物必须由人审阅；外部写入、DDL、Secret 操作、部署和发布工具在当前 MVP 尚未开放。
5. **能力必须真实。** 支持并通过原生 tool-call 探针的当前会话 Provider 才能执行六阶段；不支持工具调用的 Provider 只能聊天和生成 DeepWiki，不能显示成“可在沙盒工作”。

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
- 项目 Provider 的凭据只由页面一次性提交到 API 加密 Vault，并由服务端 Provider Registry 在固定请求快照内使用；API 不回传，且它不进入消息、仓库、Sandbox 或 Provider-native 文件工具。兼容的独立 Codex Run 仍使用自己的低权限运行密钥，不复用项目 Provider Secret。
- Chat-first 六阶段复用当前会话选中的 Provider 和有界历史。Provider-native 工具只有仓库相对路径的列出、读取、搜索、建目录、写文件和补丁能力；PM / BA 选中 `user-stories` 时另有无路径参数的结构化 Blocker 工具，由平台确定性渲染固定 Markdown。读取与搜索拒绝符号链接、硬链接和常见敏感目录，写入拒绝未选注册产物与平台控制目录。Implementation 仍可修改 Change Contract 范围内的产品源码和测试，但不能借此改写 `.ai-sdlc/`、native Agent 配置或其他受保护控制。平台不向模型提供任意 Shell、命令、网络工具或外部副作用。检查能力只能来自 Blueprint 预先批准的 `checkId`，而本版生产阶段尚未注入检查 Runner，所以不会把测试命令执行冒充成已完成。
- 只有当前项目已激活的只读 Work Item MCP 工具能进入本轮工具列表；工具说明、结果、Issue 和源码都按不可信数据处理。
- 当前只向 Agent 开放受限的只读 Work Item MCP。非只读 MCP，以及外部写入、删除、push、PR、部署和发布工具均未开放；通用外部副作用 Human Gate 也尚未接通，不能把“等待确认”当成已有能力。
- 每轮保存实际 Provider、通过有界与疑似 Secret 校验后的模型、平台生成的工具调用审计 ID、源码 revision、Sandbox、Run 和角色产物关联。上游 Provider 返回的原始 tool-call ID 属于不可信传输数据，不原样持久化；参数和结果只保存受限摘要或单向 hash。若上游把疑似 Secret 塞入 model 元数据，本轮会安全失败且不会回显或写入 Run。
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
- Provider-native 六阶段执行桥：继承当前会话 Provider 与有界历史，在同一 Session Sandbox 中受限读写，并复用既有 Artifact 保护、回滚和采集规则。
- Session 明细中的持久化 Run 投影，以及审核后不经过 Planner 的确定性 Run 推进接口。

### MODIFIED

- 仓库绑定只要求 URL 与授权；名称、ref、摘要改为系统默认和按需高级设置。
- Provider 从“一个 Thread 固定一个模型”改为“每轮可切换并记录实际模型”。
- 原自动 DeepWiki Lite 改为内部 Repository Manifest；LLM DeepWiki 由用户手工触发。
- Web 默认路由改为 Session 工作台；中央 Run 状态卡在各窗口宽度显示读取中、执行中、等待审核、可继续、失败、需修改和已完成，并在未完成状态提供合法的产物审阅与继续操作；Run 页面降为高级审计入口。Session-owned Run 一旦完成，Session 与高级审计入口都只读。
- 工作项来源从专用表单改为 Agent 按需读取已激活的只读 Work Item MCP。

### REMOVED（仅默认交互）

- 项目指标首页、六阶段大看板和“Ask / 创建 Run”二选一入口。
- 创建任务前的完整 Change Contract 表单。
- 手工选择 Jira / Linear 来源的专用流程。
- 每阶段固定执行、选择产物和逐项审核弹窗。
- 切换 Provider 时强迫创建新对话。

底层 Run、Phase、Artifact、Review、Ticket、Changeset 和高级审计能力不删除。

## Provider 页面配置纠偏

用户不应该为了换模型去修改服务器 `.env` 或重启 API。Cloud 主路径改成实例级 Provider 配置页，并保持下面这些单人 MVP 决定：

- 一个实例共享 OpenAI、LM Studio、Ollama、Custom 四个固定槽位；项目只保存默认槽位，对话可在启用槽位间为下一条消息或下一阶段切换。
- 当前唯一的 Cloud Bearer Token 同时代表实例管理员。多用户和 RBAC 不在本轮范围。
- Provider Profile 与 Secret 存在 API 专属加密 Vault；密钥和密文分文件，均位于持久 Managed Root。只有 API Registry 在调用固定 Provider 快照时使用；Provider-native 文件工具、兼容 Worker、项目 Workspace、MCP 和浏览器都拿不到。
- 生产启动不再读取 `AI_SDLC_ASK_*` 作为 Provider 真相源，也不做双向同步或静默导入。
- 编辑或停用不打断已经固定 Provider 快照的在途请求，但会立即阻止后续新请求。
- OpenAI 使用官方 HTTPS endpoint；LM Studio、Ollama 和 Custom 可使用 API 主机明确支持的本地 endpoint。其他远端 endpoint 默认必须是 HTTPS，并继续拒绝 URL 凭据、query、fragment、重定向和高危保留地址。

页面只有一套配置 Dialog：四张 Provider 卡片和一个主要动作“保存、测试并启用”。Secret 输入框永远为空；留空表示保留，显式清除表示删除。连接失败时保存草稿但保持停用，用户直接在原卡片修正，不进入额外向导。

### Provider 配置验收条件

- **PROV-AC-01**：从全局页头、Agent Provider 选择区或无可用 Provider 空状态，最多一次点击进入同一配置 Dialog。
- **PROV-AC-02**：OpenAI、LM Studio、Ollama、Custom 四个固定槽位都能保存、编辑、连接检查、启用和停用；保存后无须重启 API。
- **PROV-AC-03**：主按钮依次保存、使用刚保存的版本做真实连接检查，并且只在检查通过时启用；失败草稿保持停用。
- **PROV-AC-04**：公开 DTO、HTTP 响应、错误、日志、浏览器缓存、消息、事件、数据库业务字段、Sandbox 和 Worker 环境都不包含 Provider Secret、密文或完整 Authorization Header。
- **PROV-AC-05**：Secret 和 endpoint 使用明确的保留、替换或清除语义；编辑页不回填 Secret。endpoint origin 改变时不能沿用旧 Secret。
- **PROV-AC-06**：所有写入带 optimistic version；旧页面更新返回 409，不能覆盖新配置。配置字段变化会让旧检查失效并自动停用。
- **PROV-AC-07**：只有同一 configuration version 的 `ready` 检查才能启用；声明 tool calling 时还必须通过只解析、不执行的原生 tool-call 探针。
- **PROV-AC-08**：停用或不可用 Provider 的新请求 fail closed，不静默 fallback；项目默认仍指向它时显示可操作错误，由用户明确切换。
- **PROV-AC-09**：一个 Ask、DeepWiki 或 Agent Turn 在开始时固定 Provider 实例；过程中编辑配置不能把同一轮历史发给另一个 endpoint 或 Secret。
- **PROV-AC-10**：Agent 输入框只列启用 Provider；切换只影响下一条消息，不清空历史，assistant 消息继续保存实际 Provider 与上游模型。
- **PROV-AC-11**：配置文件损坏、认证标签不匹配、已有密文但主密钥丢失、原子写中断或残留临时文件时 fail closed，不能用空配置覆盖原文件。
- **PROV-AC-12**：连接检查只发送固定的小型兼容性请求，不发送仓库、对话、DeepWiki 或 MCP 内容；上游错误正文不原样返回或记录。
- **PROV-AC-13**：Provider endpoint 由 API 服务器访问。页面明确说明 `localhost` 指 API 运行环境；Docker Host 上的 LM Studio / Ollama 使用 `host.docker.internal`。
- **PROV-AC-14**：项目默认 Provider、现有 Session/Message/DeepWiki Provider ID、固定六阶段、角色 owner 和 Artifact Review 保持不变；Provider Secret 只在 API Registry，兼容 Worker 仍使用独立密钥。
- **PROV-AC-15**：本轮保持单 API 实例和单一 Custom 槽位；多租户、多个 Custom、跨副本一致性和企业 KMS 属于后续架构升级，不伪装成已完成。

## 验收条件

- **CHAT-AC-01**：绑定仓库的默认表单只要求安全 HTTPS URL 和可选 Credential Profile；名称与 alias 自动推断。
- **CHAT-AC-02**：仓库源码快照 ready 后即可聊天和启动 Sandbox；没有 LLM DeepWiki 也不阻塞。
- **CHAT-AC-03**：绑定完成直接进入一个 Chat-first 工作台，不经过项目详情、创建 Run 或 Change Contract 表单。
- **CHAT-AC-04**：输入框支持服务端校验的 `@repo`；一个主仓库可写。明确提到的附加仓固定 revision，只提供受大小限制的可验证 Manifest 路径线索，并作为不可变 Change Contract 上下文传给六角色；多仓写入、绝对路径和续跑时替换上下文都 fail closed。
- **CHAT-AC-05**：Project 保存默认 Provider、固定 Blueprint 版本和启用 MCP；Secret 与任意执行参数不进公开 DTO。Chat-first 阶段只通过 API 内的 Provider Registry 使用所选 Provider 快照，Secret 不进入会话历史、Workspace 或文件工具；兼容 Codex Run 使用独立运行密钥。
- **CHAT-AC-06**：同一个 Session 可切换 Provider，下一轮生效；历史不清空，每轮记录实际 Provider 和模型。
- **CHAT-AC-07**：Provider 能力明确区分聊天、DeepWiki 与 Agent tool calling；只有已启用并通过原生 tool-call 探针的 Provider 能启动执行回合，普通文本中的 JSON 不会被解析成工具调用。
- **CHAT-AC-08**：只向模型暴露当前项目已安装并激活的只读 Work Item MCP；Agent 可按需读取。非只读 MCP 和通用外部副作用 Human Gate 尚未开放，必须 fail closed。
- **CHAT-AC-09**：发送消息具备幂等 ID、expected sequence、工具轮数/时间/输出上限和可恢复记录。
- **CHAT-AC-10**：首次写操作懒启动 Session Sandbox；Sandbox 固定主仓库 revision 和 Blueprint 版本，刷新或服务重启可恢复。
- **CHAT-AC-11**：清晰的“修复/实现/测试”请求由 Agent 自动整理 Change Contract 并创建后台 Run，不要求用户填写长表单。
- **CHAT-AC-12**：后台 Run 仍严格按六阶段和原角色所有权推进；`involve` 只表示到该角色阶段时重点关注，不能跳过或阻塞任何角色；每个阶段产物在同一时间线可见。
- **CHAT-AC-13**：当前内联门禁只用于角色阶段产物审阅，而且不得自动批准。DDL、Secret、破坏性操作、外部写入、部署和发布能力尚未开放；不能用一张无后端执行链路的确认卡伪装支持。
- **CHAT-AC-14**：普通用户在会话中央区域始终能看到后台 Run 的当前角色、阶段状态、产物数、审核动作、失败与下一步，且不依赖桌面宽度的右侧栏；完整 Run / Artifact / Review 仍可进入高级审计。
- **CHAT-AC-15**：DeepWiki 只能在 bind 后从仓库设置弹窗通过 Project API 手工生成；请求固定 revision、Provider，可靠入队后由服务端继续执行，关闭弹窗不取消。结果保存模型、生成时间、用量和可验证引用；失败保留上一份 published 版本并给出可重试原因。当前没有会话命令或 `@repo` 菜单入口。
- **CHAT-AC-16**：仓库同步后旧 DeepWiki 标记 stale，不自动重新花费模型额度；旧 Session 继续固定旧 revision。
- **CHAT-AC-17**：手工描述与服务端已配置的只读 Work Item Adapter 能从同一消息进入，不再要求用户先选择任务来源；这不代表任意 MCP 或外部写操作已开放。
- **CHAT-AC-18**：默认成功路径不超过三类动作：绑定仓库、必要时配置 Provider、发送一条带 `@repo` 的消息。
- **CHAT-AC-19**：仓库中的 Agent/Skill/Prompt 文本不能提升平台、MCP、Sandbox、角色或发布权限。
- **CHAT-AC-20**：standalone legacy Cloud Run API 与高级审计入口保持兼容；未完成的 Session-owned Run 只能按当前阶段状态使用读取、Artifact 审阅和结构化决定，不能借兼容执行 API 改走 Codex；完成后进一步收敛为纯只读审计。本次不自动 push、PR、merge、deploy 或 release。
- **CHAT-AC-21**：用户可以从工作列表归档 idle 且没有未完成 SDLC Run 的 Session；这个动作从活跃列表移除会话，但保留消息、Run、Artifact 和事件审计。进行中的回合或 Run 必须先完成。
- **CHAT-AC-22**：Chat-first 新建与续跑阶段继承当前会话选择的 Provider 和服务端有界历史，通过 Provider-native 受限工具循环执行固定六阶段，不要求另行配置或调用 Codex。旧的独立 Run/Codex API 保持兼容；Provider-native 的 Figma、任意 Shell/网络和未批准检查继续 fail closed。
- **CHAT-AC-23**：Session 明细直接返回持久化 `agent_session_runs` 投影，Web 以它作为 Run 身份真相、仅把事件作为旧响应兼容回退；刷新、事件缺失或服务重启后仍能恢复并展示读取中、执行中、等待审核、可继续、需修改、失败和完成状态及当前产物。
- **CHAT-AC-24**：阶段审核先保存绑定当前 Artifact heads 的真实 Review；审核后的继续使用带 `expectedPhaseId` 与所选 `providerId` 的 Session-scoped deterministic advance API，不合成聊天消息，也不重跑 Planner。Provider 暂不可执行时仍允许保存审核，Run 保留为可继续状态并给出明确下一步。
- **CHAT-AC-25**：Run 明细返回服务端从 `agent_session_runs` 解析的可信执行来源。无论从 Session、项目 Run 列表还是去掉 URL 参数进入，Session-owned Run 都不会显示或调用 standalone Codex 执行；通用 execute 与 Codex-only E2E author/run API 在服务端返回 409，并引导回所属 Session。URL `session` 只用于导航候选，不能改变 Run 归属。
- **CHAT-AC-26**：服务端确认一个 Session-owned Run 已完成后，该 Run 在所有入口永久只读：禁止人工 Artifact revision、Review/结构化决定捕获、Architecture 决定和 E2E script review，也不能再次执行或推进；读取 Artifact、Review、事件、Changeset 和 Patch 仍可用。standalone Run 的既有完成态语义不受此规则改变。
- **CHAT-AC-27**：Provider-native 文件工具在调用前拒绝读取或搜索硬链接文件与常见敏感目录，并在所有阶段拒绝写入未选注册产物和平台控制目录；路径越界、符号链接和直接 Git metadata 访问继续 fail closed。Implementation 的较宽源码权限不覆盖这些拒绝规则。
- **CHAT-AC-28**：Provider 返回的 tool-call ID 不作为可信审计身份。持久化事件只使用平台生成或规范化的有界 call ID，并保存参数/结果 hash；上游原始 ID 不原样进入事件、日志或业务记录。
- **CHAT-AC-29**：Provider-native 只有在每个 selected output 已按同一 Runner 规则非空落盘、满足本次更新要求并通过已注册的确定性质量门禁时才能接受 final。受守护阶段必然需要更新注册输出，因此支持强制工具选择的协议从第一次响应起就要求真实选用工具；模型第一次漏掉 required/named tool call 时，平台必须用同一约束重试一次且不消耗工具或修复轮次，第二次仍遗漏或返回错误 named tool 才作为 Provider 兼容性错误公开，不能伪装成 Artifact 质量失败。Ollama Chat 因原生 API 限制保持 auto。Discovery 的 `user-stories` 按真实目录 entries 校验，不能让 README 中伪造的 `## .../story.md` 标题充当文件边界，也不能以 placeholder README 充当完成证据：必须至少包含一个稳定 Story，且两个不同 AC 各自拥有完整 Gherkin 场景；为兼容 partial update，不强迫未修改的历史 Story 套用最新模板。证据不足时，只接受根 `README.md` 中唯一且独占一行的 versioned sentinel、精确 Blocked/Pending 状态、非空 Missing facts、待回答问题、human owner 和可执行下一步组成的结构化 Blocker；inline-code 引用不算 sentinel。Blocker 由仅绑定当前 selected directory 的 `write_user_stories_blocker` 从结构化字段确定性渲染，并要求 1–20 条 missing facts 与 open questions 在一次调用中完整汇总。多项问题按内容指纹拆成独立决定卡，浏览器必须一次提交当前全部决定；部分答案不得解锁 Story 生成，全部问题得到具体答案后才要求 PM / BA 落实并移除旧 Blocker。Blocker 意图优先于遗留 Story，且只代表“可审核”，会投影为阻止批准的人工决定。Provider 提前结束时，平台在同一模型循环内最多两轮返回仅含安全 artifact key、仓库相对路径和物化/质量要求的补齐提示；阶段总工具上限中的 4 次保留给门禁修复。每个 repair tool 后立即探测门禁；失败探测保留当前轮剩余额度，只有额度耗尽才进入下一轮，因此提前 final 不会搁浅工具位。无效 Story 修复必须按 named `read_file`、`write_file` 的确定性顺序推进，Blocker 修复必须 named 选择结构化工具。补齐不重置工具/修复预算或绝对上限；被接受的模型响应、工具结果和门禁结果只刷新连续 4 分钟无活动租约。非 Implementation 的绝对上限为 30 分钟，Implementation 为 45 分钟。仍不完整或不可审核则保留 `OUTPUT_ARTIFACTS_MISSING` / `OUTPUT_ARTIFACTS_INVALID` 并回滚 selected outputs，不能笼统声称 Implementation 的其他允许源码/测试变更也已回滚。Session 必须显示当前 execution 的工具结果数、最近安全动作、门禁自动修复和必需工具重试进度，并记录、无障碍播报异步完成/失败；成功后直接出现产物审核入口；共享高级审计必须依据最新 execution command 显示 Provider 或 Codex，且把工具/门禁事件翻译为人类可读动作，不能把 Session Provider 执行误标成 Codex。`user-stories` 已尝试写入但未通过门禁时，公开错误必须明确说明“已尝试写入、未通过可审核质量检查、selected-output 写入已回滚”，不能误报成完全没写；同时只显示安全 artifact key、allowlist 质量问题标签与精确回滚事实，不泄露路径、被拒绝的正文、Provider 原文或凭据。

## MVP 不假装完成的部分

- 多个仓库同时写入或跨仓原子提交。
- 把附加仓挂载给 Worker、读取任意源码正文、跨仓全文/向量检索或完整语义聚合；当前只提供固定 revision 的有界 Manifest 路径线索。
- 任意用户上传 Dockerfile、镜像、Host mount 或 Shell 蓝图。
- Git / MCP Secret 的页面配置和通用 Secret 管理器；Provider 是当前唯一的页面 Secret 写入例外，而且保存后不能取回。
- 通用外部副作用 Human Gate，以及任何外部写入、删除、push、PR、部署或发布工具。
- 不支持原生 tool calling 的模型通过解析普通文本伪造工具调用。
- Provider-native 阶段的任意 Shell、自由命令、网络工具和 Desktop Figma；检查只能通过 Blueprint allowlist 的 `checkId` 暴露，而本版生产阶段没有注入检查 Runner，缺少命令证据时必须如实标记 Pending / Blocked。
- 多租户强隔离、microVM、分布式 Session 队列和自动扩缩容。

## 当前实现结果

| 范围 | 结果 | 说明 |
|---|---|---|
| 仓库绑定 → 直接进入对话 | 已完成 | 只需要 HTTPS URL 与可选 Credential Profile；服务端推断名称和 alias。 |
| 页面配置与每轮 Provider 切换 | 已完成 | OpenAI、LM Studio、Ollama、Custom 由模型设置管理并写入加密 Vault；启用后可按下一轮切换，并记录实际 Provider / model。 |
| 手工 LLM DeepWiki | 已完成 | bind 后从设置弹窗可靠入队；后台固定 revision 和 Provider，限制本地模型预算，保存引用与用量，失败保留上一版，源码同步后旧版本 stale。 |
| Agent 按需读取 Work Item | 已完成（只读范围） | 当前开放受限 Work Item Adapter；审计记录先于真实调用。 |
| Session Sandbox | 已完成 | 与本 Session 的一个 Run 共用同一 exact-revision Workspace；Chat-first Provider-native 工具使用该 Workspace，兼容 Codex Worker 仍为短生命周期。 |
| 六角色串联 | 已完成 | Chat-first 阶段继承本轮 Provider 与有界会话历史，从 PM/BA 开始，固定 owner 和顺序；下游只拿当前已批准上游产物。旧的独立 Run/Codex 执行入口继续兼容。 |
| 对话内 Run 状态与产物审阅 | 已完成 | Session 明细返回持久化 Run 投影；中央状态卡覆盖加载、运行、审核、修改、失败、继续和完成。必须成功查看全部 current heads，才能批准或要求修改。 |
| 额外 `@repo` | 已完成（有界 Manifest） | 明确提到的只读仓固定 revision；Planner、Chat Ask、Change Contract 与六角色看到同一份受限结构线索。不会挂载、传源码正文或获得写权限。 |
| 角色产物门禁 / 通用副作用 Gate | 前者完成，后者未接入 | 角色产物审阅是真实门禁且不得自动批准；外部写、push、PR、部署、发布工具尚未开放，因此通用副作用 Gate 不能作为当前能力宣传。 |
| 已启用 Provider 执行六阶段 | 已完成（受限工具范围） | Chat-first 使用当前会话 Provider 的原生 tool calls，在 Session Workspace 内受限读写并复用 Artifact 保护/回滚/采集。不向模型开放任意 Shell、网络工具或 Figma；本版未向生产阶段注入检查 Runner。 |
| 审核后确定性继续 | 已完成 | Session-scoped advance API 校验 Run 归属与预期阶段，直接推进当前 Run；不追加合成消息、不重新调用 Planner。 |
| Provider-native 文件与审计边界 | 已完成 | 硬链接读取、常见敏感目录、未选注册产物和控制目录写入均在工具层拒绝；持久化事件使用平台审计 call ID，不保留上游原始 tool-call ID。 |
| Session-owned Run 执行来源防绕过 | 已完成 | Run 明细投影可信 Session 来源；Web 不把 URL 当归属真相，通用 Codex execute/E2E API 对已关联 Run fail closed；未完成 Run 仅保留当前状态允许的 Review，完成 Run 只读。 |
| Session-owned 完成态不可变 | 已完成 | 完成后仍可查看完整 Artifact、Review、事件、Changeset 和 Patch，但人工修订、决定捕获、E2E script review、再次执行与推进都 fail closed；standalone 语义不变。 |
