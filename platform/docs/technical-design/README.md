# AI SDLC Cloud Platform 技术设计

本文描述当前仓库已经实现的 Chat-first Cloud MVP，重点覆盖远程 Git 项目的主路径。它是实现说明，不是未来架构蓝图，也不构成生产多租户安全承诺。`legacy-local` API 仍为兼容而保留，但其 Host runner、Desktop Figma 和独立 E2E 能力不属于本文的 Cloud 主路径。

面向产品和审阅人的白话流程见[业务流程与思维导图](../business-flow/README.md)。运维步骤见 [Cloud 运行指南](../../README.md)，更完整的威胁假设见 [安全模型](../security-model.md)，阶段执行约束见 [运行时合同](../runtime-contract.md)。

## 1. 设计目标与不变量

当前实现用以下不变量约束“对话驱动的软件交付”：

1. 浏览器在普通运行时只提交仓库 URL、消息、幂等 ID、预期序号和可选 Provider；唯一例外是持有部署令牌的管理员可在独立模型设置接口一次性提交 Provider endpoint 和新 Secret。API 不会回传 Secret，仓库路径、Worker 镜像、命令、挂载和权威对话历史仍由服务端决定。
2. 每个 Agent Session 最多一个可写主仓库，并固定一个完整 Git revision。附加 `@repo` 只提供固定 revision 的有界 Manifest 摘要，不提供源码正文或写权限。
3. 对话 Provider 负责问答、意图规划、只读 MCP 选择和手工 DeepWiki；远程项目的六阶段真实执行由受限 Docker Codex Worker 完成。能聊天不等于能执行代码。
4. Run 固定 `baseRevision`、Control Pack `definitionVersion`、Change Contract 和 Workspace。项目同步不会静默改变已有 Session、Ask Thread 或 Run。
5. 阶段顺序和 owner 固定为 PM/BA、Designer、Architect、Software Engineer、Tester、DevOps。下游只消费当前、已批准、owner 正确的 Artifact head。
6. Artifact 审核绑定审核者实际看到的 revision/hash。过期页面不能批准更新后的产物。
7. 远程真实阶段只走管理员预检并固定到 image ID 的 Docker Worker；配置缺失时 fail closed，不回退到 Host 执行。
8. 最终交付边界是可审阅的 Artifact、Diff、测试证据和二进制 Patch。平台本身不 push、不创建 PR、不合并、不部署、不发布。

## 2. 系统架构

```mermaid
flowchart LR
    subgraph clientZone["Client"]
        browser["React Web"]
    end

    subgraph webZone["Web container"]
        nginx["Nginx static server and API proxy"]
    end

    subgraph apiZone["Trusted API control plane"]
        fastify["Fastify API"]
        providerLayer["Provider Registry and Conversation Planner"]
        workflowLayer["Agent Coordinator and Workflow Service"]
        repositoryLayer["Git Broker and Knowledge Services"]
        mcpLayer["Read-only MCP Router and stdio Client"]
    end

    subgraph stateZone["Durable state and managed files"]
        postgres[("PostgreSQL")]
        managedRoot["Managed Workspace Root"]
        controlPack["Per-project Control Pack"]
        providerVault["Encrypted Provider Vault"]
    end

    subgraph workerZone["Phase execution"]
        dockerDaemon["Docker daemon"]
        codexWorker["Ephemeral Codex Worker"]
    end

    subgraph externalZone["Operator-approved external systems"]
        gitHost["HTTPS Git host"]
        chatEndpoint["Chat Provider endpoint"]
        codexEndpoint["Codex model endpoint"]
        workTracker["Jira, Linear, or another work tracker"]
    end

    browser -->|"HTTP API"| nginx
    nginx -->|"Same-origin /api proxy"| fastify
    fastify --> providerLayer
    fastify --> workflowLayer
    fastify --> repositoryLayer
    fastify --> mcpLayer
    fastify -->|"Read and write state"| postgres
    repositoryLayer -->|"Snapshots and indexes"| managedRoot
    workflowLayer -->|"Run workspace and artifacts"| managedRoot
    fastify -->|"Server-managed files"| controlPack
    fastify -->|"Atomic encrypted profile updates"| providerVault
    providerVault -->|"Decrypted only inside API"| providerLayer
    providerLayer -.->|"Bounded prompts"| chatEndpoint
    repositoryLayer -.->|"Validated HTTPS Git"| gitHost
    mcpLayer -.->|"Fixed read-only tool call"| workTracker
    workflowLayer -->|"Fixed Docker spec"| dockerDaemon
    dockerDaemon -->|"Create per execution"| codexWorker
    managedRoot -->|"Writable main workspace mount"| codexWorker
    controlPack -->|"Read-only control mount"| codexWorker
    codexWorker -.->|"Model request"| codexEndpoint
```

### 2.1 组件职责

| 组件 | 当前职责 | 明确不负责 |
|---|---|---|
| React Web | 仓库绑定、持久会话、Provider 配置与选择、角色进度、Artifact 展开审阅和高级 Run 审计 | 读取已保存 Secret，决定仓库路径、Worker 镜像、MCP 命令、权威历史或阶段权限 |
| Nginx Web container | 提供静态 Web，并把 `/api/` 反向代理到 API | TLS 证书自动管理；远程部署需另置 TLS 终止层 |
| Fastify API | Bearer 校验、精确 CORS、DTO 校验、服务编排、公开错误脱敏和 Cloud 资源访问检查 | 多用户身份、RBAC、租户隔离 |
| PostgreSQL | 保存 Project、Session、消息/事件、工具审计、Workspace、Run、Execution、Artifact revision、Review、DeepWiki 和 Changeset 元数据 | 保存 Git、Provider 或 MCP Secret |
| Encrypted Provider Vault | 保存四个实例级 Provider 槽位、启停状态、检查结果，以及 AEAD 加密后的 endpoint / API Key；支持单实例 CAS 与原子文件替换 | 多租户 Secret、多个 Custom、跨 API 副本一致性或企业 KMS |
| Cloud Project Service / Git Broker | 校验 URL/ref/DNS，使用短时 AskPass 凭据拉取，固定 revision，物化 Project Snapshot、Session Sandbox 和 Run Workspace | 把 Git 凭据传给浏览器、Prompt 或 Worker |
| Knowledge Services | 生成并复验确定性 DeepWiki Lite；为 Ask、Planner 和阶段执行提供 revision-bound 线索 | 将索引当作完整语义 Wiki，或证明未索引内容不存在 |
| Provider Registry / Planner | 统一 OpenAI Responses、OpenAI Chat、Ollama Chat 协议；完成问答、工作意图识别、Change Contract 规划和原生 tool call 解析 | Shell、任意文件写入、把普通模型文本解析成可执行工具调用 |
| MCP Router / stdio Client | 让模型从项目已激活的只读 Work Item Adapter 中选择一个，先审计再执行并按显式 mapping 归一化结果 | 浏览器自定义 command/argv/tool/Secret，或通用外部写入 |
| Agent Coordinator / Workflow Service | 固定角色顺序，选择已批准 Artifact，创建异步 Execution，校验阶段门禁并推进状态 | 自动替人批准，或因 `involve` 跳过上游 owner |
| Codex Terminal Runner | 组装固定 Docker spec、分层 Prompt、保护未选输出、收集 JSONL 事件和 Artifact、处理超时/清理 | 为远程项目回退到 Host；为 Release 执行部署 |
| Docker Codex Worker | 在单个 Run Workspace 内执行当前阶段的源码修改、检查和 Artifact 生成 | 获取附加仓源码、Docker socket、Git Token、数据库凭据或平台 Access Token |

实现组合入口是 [API app](../../apps/api/src/app.ts)，Web 路由和 Agent 工作台分别位于 [App.tsx](../../apps/web/src/App.tsx) 与 [agent-workspace-page.tsx](../../apps/web/src/pages/agent-workspace-page.tsx)。公开 DTO 和输入边界由 [contracts](../../packages/contracts/src/index.ts) 的 Zod schema 共享。

## 3. Chat-first 请求流

下面是“消息明确引用一个外部工作项，并启动新 Run”的成功路径。没有外部工作项时会省略 MCP 两步；普通问答则走 Ask 检索并在创建 Sandbox 之前结束。

```mermaid
sequenceDiagram
    title Chat-first work turn
    participant Browser
    participant API
    participant Postgres
    participant Provider
    participant MCPAdapter
    participant Worker

    Browser->>API: POST session message with clientMessageId and expectedSequence
    API->>Postgres: Bind mentioned repos and begin idempotent turn
    API->>Provider: Select one activated read-only tool
    Provider-->>API: Native resolve_work_item call
    API->>MCPAdapter: Audited tools/call with fixed adapter config
    MCPAdapter-->>API: Normalized untrusted work item
    API->>Provider: Plan intent and bounded Change Contract
    Provider-->>API: Schema-validated work plan
    API->>Postgres: Persist Sandbox, Contract, Run, and discovery Execution
    API->>Worker: Start discovery on pinned workspace and Control Pack
    API-->>Browser: 202 with persisted Session state
    Worker-->>API: JSONL events and workspace Artifact files
    API->>Postgres: Complete Execution and set phase awaiting_review
    Browser->>API: Poll Session and Run
    API-->>Browser: Messages, events, and current Artifact heads
```

### 3.1 消息接收与并发

- `clientMessageId` 与请求 fingerprint 提供幂等性；相同 ID 携带不同内容会冲突。
- `expectedSequence` 是乐观并发控制。服务端先检查幂等 replay，再校验序号和 `turn_state`。
- Agent 创建新 Run 时，会在同一数据库事务里写入 Run、六阶段、Change Contract、Workspace / Sandbox busy 状态和 `agent_session_runs` 关联。恢复时以关联表为控制真相，`sdlc.run-created` Event 只是可补建的展示记录；相同消息重试不会重放 Provider、MCP 或创建第二个 Run。
- 单进程内按 Session 串行化消息，数据库事务对 Session 行加锁。它不是跨进程分布式锁，因此 Cloud 只支持一个 API 实例。
- 浏览器不能提交历史数组作为权威上下文；服务端从 PostgreSQL 取最近的受限历史。每条 assistant 消息保存实际 Provider 和模型。

### 3.2 意图分支

| Planner 结果 | 行为 |
|---|---|
| `chat` | Ask Service 在主仓固定 revision 上做有界检索和引用校验；不创建 Sandbox 或 Run |
| `work` 且关键输入不足 | 只问一个会实质改变结果的澄清问题；不启动执行 |
| `work` 且 Provider 没有声明原生 tool calling | 保留消息并提示切换 Provider；不把普通文本冒充工具调用 |
| 新工作且 Session 已有 Run | 拒绝把另一项工作混入同一个可写 Sandbox，要求新建 Session |
| 明确“继续当前 Run” | 复用同一 Sandbox、Run 和已固定上下文，只启动当前可执行角色 |

`Agent Sandbox` 是 Session 级、固定 revision 的持久受管 Workspace 记录，不是常驻容器。每个真实阶段由 `WorkflowService` 临时启动一个 Worker，结束后容器删除，而 Workspace 继续保留供下阶段、审阅与 Patch 使用。

相关实现： [AgentSessionService](../../apps/api/src/services/agent/agent-session-service.ts)、[ConversationPlanner](../../apps/api/src/services/agent/conversation-planner.ts)、[AgentSdlcCoordinator](../../apps/api/src/services/agent/agent-sdlc-coordinator.ts) 和 [WorkflowService](../../apps/api/src/services/workflow-service.ts)。

## 4. 数据与状态模型

数据库 schema 由应用启动时增量建立，定义见 [schema.ts](../../apps/api/src/db/schema.ts)，事务和状态转换见 [store.ts](../../apps/api/src/db/store.ts)。主要聚合如下。

| 聚合 | 关键表 | 关键约束 |
|---|---|---|
| Project / Repository | `projects`, `project_agent_settings`, `managed_workspaces`, `knowledge_snapshots` | 远程仓必须是 HTTPS；活动 snapshot 唯一；revision 为完整 SHA-1/SHA-256；Control Pack 版本独立于仓库 |
| Conversation | `agent_sessions`, `agent_session_repositories`, `agent_messages`, `agent_events` | 每 Session 最多一个 `write` 仓；消息/事件 sequence 唯一；用户消息有幂等键和 fingerprint |
| Tool / Gate | `agent_tool_calls`, `agent_human_gates` | 工具参数和输出只留 SHA-256/安全摘要；Human Gate 表结构为受限能力预留，当前 Cloud 主链真正生效的人工门禁是 Artifact Review，通用外部副作用 Gate 尚未接入生产链路 |
| Sandbox / Run linkage | `agent_sandboxes`, `agent_session_runs`, `workflow_runs` | Sandbox、Run、主仓 revision 一致；一个 Workspace 不被多个 Run 复用 |
| SDLC | `phase_runs`, `executions`, `artifacts`, `reviews`, `tickets`, `execution_events` | 固定六阶段；每个 Artifact key 只有一个未 supersede 的 head；Review 固定实际 head IDs |
| Delivery | `run_changesets` | Patch 固定 base revision、文件清单、字节数和 SHA-256；Patch 正文作为 `bytea` 保存 |
| LLM knowledge | `deepwiki_generations`, 兼容用 `ask_threads` / `ask_messages` | Provider、模型、revision、manifest、引用和 token usage 可追踪；同步后旧生成标记 stale |

### 4.1 主要状态转换

| 对象 | 主路径 | 失败/恢复语义 |
|---|---|---|
| Repository | `importing/syncing -> ready`，内部 operation 为 `queued -> running`，并经过 validating/fetching/resolving/materializing/indexing/publishing | 失败进入 `failed`，保留安全错误；未完成的仓库 operation 可在重启后重新调度 |
| Agent turn | `idle -> running -> idle` | 本轮失败时消息标记 failed，写入 `turn.failed`，短暂进入 interrupted 后恢复 idle |
| Sandbox | `starting -> ready -> busy` | 启动中断标记 failed；ready/busy Workspace 仍需 revision 和 DB 引用一致 |
| Execution / Phase | `ready -> running -> awaiting_review -> approved` | Runner 失败使 Execution 和 Phase 进入 failed；`request_changes` 使当前阶段进入 changes_requested，并使受影响下游失效 |
| Artifact | `pending -> approved` 或 `changes_requested`；新 revision 把旧 head 置为 superseded | revision 以 parent ID 串联；stale reviewer 因 head ID 不同而被拒绝 |
| Run | `active -> completed` | 只有最后一个阶段批准后完成；失败阶段保留在同一 Run 中供修复后继续 |
| DeepWiki generation | `queued -> scanning -> generating -> validating -> ready` | 失败保留安全错误；仓库 revision 变化后 ready 结果变 stale，不自动重跑 |

三个贯穿全链的绑定值是：源码 `revision`、Control Pack `definitionVersion`、内容 `manifestHash/contentHash`。只要其中一项与当前持久记录或物理 Workspace 不一致，Ask、阶段输入选择或审批都会拒绝继续。

## 5. 一个可写主仓与有界附加仓 Manifest

### 5.1 主仓

- 仓库绑定完成后，Session 的主仓绑定到活动 Project Snapshot 的 exact revision，数据库唯一索引保证只有一个 `access_mode = write`。
- 第一个工作回合从该 Snapshot 物化一个 Session Sandbox。新 Run 直接引用这个 Sandbox Workspace，不再克隆第二份可写目录。
- Worker 只挂载这一份主仓 Workspace；`.git` 被额外覆盖为只读挂载，Control Pack 从仓库外只读挂载。
- 项目后来同步到新 revision 时，已有 Session 和 Run 仍使用旧 revision。旧 Snapshot 被删除或损坏时 fail closed，而不是静默切换。

### 5.2 附加 `@repo`

消息中出现服务端已登记的 `@alias` 时，平台仅在 Session 空闲且目标仓库/知识 Snapshot ready 时增加只读绑定：

- 一个 Session 最多绑定 16 个仓库，包括主仓；每轮最多解析 4 个被明确提及的只读仓。
- 每个只读上下文只含 `repoAlias`、`sourceRevision`、`manifestHash` 和最多 6,000 字符的 `summary`；一轮 summary 总计最多 24,000 字符。
- summary 只包含文件数、总字节、语言统计，以及 entry/docs/tests/build/key-path 的计数和有界相对路径。每类最多 12 条路径，单路径最多 512 字符。
- DTO 不含 Project ID、仓库 URL、Workspace 路径、绝对路径、凭据或文件正文；摘要再次做疑似 Secret 脱敏。
- 这些摘要被写入不可变 Change Contract，所有角色读取同一份参考。附加仓不会挂载进 Worker，也不会获得 Shell、Git、网络或写权限。
- 继续已有 Run 时，显式提及的附加仓必须与 Contract 中的 alias、revision、manifest hash 和 summary 完全一致；否则要求新建 Session。

边界实现见 [read-only-repository-context.ts](../../apps/api/src/services/agent/read-only-repository-context.ts)，Contract schema 见 [contracts](../../packages/contracts/src/index.ts)，运行时 Prompt 的强制说明见 [codex-runner.ts](../../apps/api/src/services/codex-runner.ts)。

## 6. Provider 与 Docker Codex Worker 分层

| 层 | 可选实现 | 当前输入 | 当前权限 | 产出 |
|---|---|---|---|---|
| Chat Provider | OpenAI、LM Studio、Ollama、Custom | 受限历史、主仓检索片段、只读 Manifest、归一化 Work Item | 无 Shell；无直接文件写入；仅可返回服务端验证的结构化结果或原生 tool call | 问答、意图计划、Change Contract 草案、MCP 选择、手工 DeepWiki |
| Provider-native Agent Runtime | `ProviderNativeAgentRuntime` + rooted tool host | 服务端根目录和工具定义 | 有界读/写/检查工具，原生 tool call，调用数/时间/输出限制 | 已有独立正确性与对抗测试，但尚未接入生产六阶段 |
| Phase Runtime | Docker 内固定版本 Codex CLI | 当前阶段 Prompt、Change Contract、DeepWiki 线索、已批准上游 Artifact、主仓 Workspace | 主仓 Workspace 可写；Control Pack 和 `.git` 只读；固定资源/环境/挂载 | 源码/测试修改、当前角色 Artifact、JSONL 执行事件 |

Provider Registry 的 endpoint、protocol、model 和 API key 来自 API 专属加密 Vault。持有部署级 Bearer Token 的管理员在 Web 四张固定卡中保存配置；Secret 输入框不回填，公开 DTO 只返回是否已保存、脱敏 Host、模型、版本、启停和最近检查。配置写入采用 optimistic version，更新会让旧检查失效并先停用；只有当前版本的 JSON 检查和可选原生 tool-call 探针都通过后才能启用。保存后 Registry 在线替换，不需要重启 API，也不会 fallback 到另一个 Provider。

LM Studio 固定映射为 OpenAI-compatible Chat Completions：API 调用 `POST /v1/chat/completions`，JSON 产物通过 `response_format.json_schema` 约束并继续在服务端校验。`openai/gpt-oss-20b` 可以作为模型 ID 使用，但能否通过检查仍取决于当前 LM Studio 版本、推理运行时和实际加载的模型；设计不把“模型支持”推断成“所有 LM Studio 版本都兼容”。检查失败时运维者先确认模型已加载并升级 LM Studio/推理运行时，仍失败则换用支持结构化 JSON 的模型，再从同一页面重试；协议由平台固定处理。

早期 Vault 把 LM Studio 固定为 OpenAI Responses。启动时的一次性增量迁移只把该槽的协议改为 Chat Completions，保留 endpoint、model、credential 和 tool-calling 选择，同时清除旧检查、设为停用并递增 record/config version。这样旧的 Responses 检查不能被拿来启用新协议；管理员只需在 Web 重新检查并启用，不需要重填 Secret。已经是 Chat Completions 的记录不会重复迁移。

每个 Ask、DeepWiki 或 Agent Turn 在开始时取得不可变 Provider 实例快照。在途请求可以按已固定的 endpoint / Secret 完成；同名配置编辑或停用只影响后续新请求，避免同一轮把历史发送到两个信任边界。

远程 Phase Runtime 使用启动时验证过的 Worker image ID。Docker spec 固定非 root UID:GID、只读 rootfs、`cap-drop ALL`、`no-new-privileges`、CPU/内存/PID/超时限制、bounded tmpfs 和精确 bind mounts。真实远程仓库还必须出现在 `AI_SDLC_REAL_EXECUTION_TRUSTED_REPOSITORIES` 的完整 URL allowlist 中；空列表拒绝所有真实远程阶段。

Worker 环境采用 allowlist，只可能转发 Codex/OpenAI runtime key、显式代理和少量 locale/terminal 变量。聊天 Provider Vault 的凭据、Git Credential、MCP Secret、`DATABASE_URL`、Access Token 和 Docker client 配置不会进入 Worker。默认 Worker 网络是普通 Docker `bridge`，因此这不是 egress 隔离；需要更强网络控制时必须由部署层另行设计。

相关实现： [Provider 配置服务](../../apps/api/src/services/llm/provider-configuration-service.ts)、[加密 Vault](../../apps/api/src/services/llm/provider-configuration-vault.ts)、[Provider Registry](../../apps/api/src/services/llm/provider-registry.ts)、[Provider-native runtime](../../apps/api/src/services/agent/provider-native-agent-runtime.ts)、[Codex runner](../../apps/api/src/services/codex-runner.ts)、[Worker Dockerfile](../../docker/worker.Dockerfile) 和 [Cloud startup preflight](../../apps/api/src/services/cloud-startup-preflight.ts)。

## 7. MCP 与 DeepWiki

### 7.1 Work Item MCP

当前 Cloud MVP 的 MCP 是小而封闭的只读桥接层：

1. 管理员通过环境配置最多 20 个 Adapter，固定其绝对 command、argv、tool name、reference 参数、fixed arguments、字段 mapping 和 Secret 环境引用。
2. Project 只能激活已安装、已配置的 Adapter ID。浏览器看不到或覆盖上述运行参数。
3. 支持 tool calling 的 Provider 最多选择一个 `resolve_work_item`；普通 assistant 文本不会被解析为工具调用。服务端还会校验所选工单编号或完整 URL 必须原样出现在当前用户消息中，拒绝模型虚构或截短另一个引用。
4. API 先创建 `agent_tool_calls` 审计行并进入 running，再启动 `shell:false` 的 stdio child，完成 MCP initialize 和固定的 `tools/call`。
5. 时间、stdout/stderr、单条协议消息和并发都有上限；stderr 不落日志、不返回浏览器。请求结束时等待进程树退出后才释放并发名额。
6. 返回值按管理员 mapping 归一化并保存 source fingerprint，随后作为不可信需求证据进入 Planner/Contract。它不能改变 Control Pack、角色、Worker 或审核权限。

实现见 [mcp-tool-router.ts](../../apps/api/src/services/agent/mcp-tool-router.ts)、[work-item-mcp-registry.ts](../../apps/api/src/services/work-item/work-item-mcp-registry.ts) 和 [mcp-stdio-client.ts](../../apps/api/src/services/work-item/mcp-stdio-client.ts)。Adapter 代码与 API 处在同一个主机信任域，必须由运维者审核并固定版本；应用级参数限制不能把恶意 Adapter 变成可信程序。

### 7.2 DeepWiki Lite 与 LLM DeepWiki

| 能力 | 触发 | 数据来源 | 结果与边界 |
|---|---|---|---|
| DeepWiki Lite | 每次成功导入新 revision 时自动执行 | 固定 Git tree/object，不扫描任意工作区文件 | 确定性 manifest、语言/路径信号和逐文件 hash；排除依赖/构建目录、敏感文件、symlink、binary 和超限内容 |
| LLM DeepWiki | 用户手工触发 | Lite map 加上服务端选择的有界源码 excerpt | 保存 revision、Provider、模型、manifest、引用和 usage；引用必须匹配服务端 source ID；同步后标记 stale |
| Project Ask | 每个只读问题 | 固定 revision 上的有界 retrieval | 返回验证过的 path/line/hash 引用、未知项和实际 Provider；没有执行工具 |

`ProjectKnowledgeResolver` 不会因为数据库行写着 ready 就信任索引。它重新解析持久 JSON，确认 Project/revision/workspace/manifest 一致，并对物理 Git snapshot 做 revision 绑定或重建索引比较。实现见 [deepwiki-lite.ts](../../apps/api/src/services/deepwiki-lite.ts)、[project-knowledge.ts](../../apps/api/src/services/project-knowledge.ts) 和 [deepwiki-generation-service.ts](../../apps/api/src/services/agent/deepwiki-generation-service.ts)。

## 8. 六角色 Artifact handoff

阶段与 Artifact 注册表的 canonical 来源是 [templates/ai-native.yaml](../../../templates/ai-native.yaml)；加载器还会验证固定顺序、owner、输入只能来自更早阶段、输出 owner、路径边界和旧项目兼容 backfill。

| 顺序 | Phase / owner | 主要交付 | 给下游的约束 |
|---:|---|---|---|
| 1 | Discovery / PM-BA | 不可变 Change Contract、PRD、User Stories | 需求范围、验收条件、回归范围和风险 |
| 2 | Design / Designer | Design baseline/spec、可选 prototype 与 Figma handoff | 交互状态、可访问性、工程交接和 deferred validation |
| 3 | Architecture / Architect | Discovery context、Options、C4、ADR、Patterns、NFR、Adversarial pack 和索引 | 人工选型、系统边界、质量预算和风险 |
| 4 | Implementation / Software Engineer | 主仓源码/测试修改，加实施计划、任务、session log、独立测试证据、七视角 review 和 provenance | 可复验实现与验收追踪；源码变更体现在 Workspace/Changeset 中 |
| 5 | Verification / Tester | `test-report` | 独立验收与回归证据、缺陷和发布建议 |
| 6 | Release / DevOps | `release-runbook` | 发布前置、监控、回滚和人工 go/no-go 信息；不执行发布 |

Handoff 规则：

- 新 Run 创建六个 `phase_runs`：Discovery 为 ready，其余为 pending。固定顺序见 [default workflow](../../../templates/shared/.ai-sdlc/workflows/default.md)。
- `involve Architect` 等文本只记录关注角色，不改变调度。Impact disposition 可以在有证据时 direct/skip/reuse/partial，从而省略一次 Agent execution，但不会删除阶段、改变 owner 或跳过门禁。
- Coordinator 找到第一个未 approved 的阶段，核对定义 owner，并只选择更早、已 approved、当前 head 的必需 Artifact IDs。
- Execution 完成后，新 Artifact revision 为 pending，阶段进入 awaiting_review。任何旧 head 同 key 被标记 superseded。
- Review 必须提交页面看到的完整 current head ID 集合；approve 将这些 heads 标为 approved 并把下一阶段从 pending 置为 ready；request_changes 保留意见并重置受影响下游。
- Implementation、Verification、Architecture 和 Release 还有各自的证据/新鲜度 validator；Artifact 文件与数据库 snapshot 不一致时拒绝继续。
- Release 最终批准只把 Run 标成 completed，不授予 deploy/release 权限。

## 9. Sandbox、Worker 与 Secret 信任边界

```mermaid
flowchart TB
    subgraph clientBoundary["Untrusted client boundary"]
        tokenHolder["Browser and deployment token holder"]
    end

    subgraph edgeBoundary["Network edge"]
        accessEdge["Loopback access or operator TLS proxy"]
        webContainer["Web container with Nginx"]
    end

    subgraph trustedBoundary["Trusted host control plane"]
        apiContainer["API container as UID 10001"]
        database[("PostgreSQL container")]
        secretEnv["Server environment Secrets"]
        managedFiles["Dedicated Managed Workspace Root"]
        providerKey["Provider Vault key file"]
        providerCipher["Provider encrypted profile file"]
        mcpBinary["Pinned operator MCP binary"]
        dockerSocket["Docker socket"]
        dockerHost["Docker daemon"]
    end

    subgraph workerBoundary["Ephemeral Worker boundary"]
        workerProcess["Non-root read-only-rootfs Worker"]
        writableRepo["Main repository at /workspace read-write"]
        readonlyGit["Git metadata read-only"]
        readonlyControl["Control Pack read-only"]
    end

    subgraph externalBoundary["Untrusted data and external processing"]
        gitService["Allowed Git service and repository content"]
        trackerService["Work tracker and issue content"]
        chatService["Chat Provider and model output"]
        phaseModel["Codex phase model service"]
    end

    tokenHolder -->|"Authorization header"| accessEdge
    accessEdge --> webContainer
    webContainer -->|"Provider Secret only on authenticated save"| apiContainer
    secretEnv -->|"DB, Git, MCP, access and Worker credentials"| apiContainer
    apiContainer --> database
    apiContainer --> managedFiles
    providerKey -->|"0600 read by API only"| apiContainer
    providerCipher -->|"AEAD decrypt inside API"| apiContainer
    apiContainer -->|"Validated Git fetch"| gitService
    apiContainer -->|"Bounded model context"| chatService
    apiContainer -->|"Fixed stdio config"| mcpBinary
    mcpBinary -.->|"Read-only API call"| trackerService
    apiContainer -->|"Docker client through socket"| dockerSocket
    dockerSocket --> dockerHost
    dockerHost --> workerProcess
    managedFiles -->|"Exact bind mounts"| writableRepo
    writableRepo --> workerProcess
    readonlyGit --> workerProcess
    readonlyControl --> workerProcess
    apiContainer -.->|"Allowlisted phase runtime environment only"| workerProcess
    workerProcess -.->|"Network model request"| phaseModel
```

### 9.1 边界结论

- **API 是最高信任控制面。** 它持有数据库权限、Git Broker 凭据、Provider/MCP Secret，并在 Compose 中持有 Docker socket。API 被攻破具有 Host 级影响，应运行在专用主机或 VM。
- **Managed Root 同时装载可信控制文件和不可信仓库数据。** 路径由服务端生成并做 realpath/symlink/owner 边界检查，但仍需独立、可恢复、带 OS/存储层硬配额的 filesystem。
- **Worker 是纵深防御，不是 hostile multi-tenant sandbox。** 它没有 Docker socket、Git Token、DB 凭据或平台 Token，但有一个可写仓库、模型凭据和默认网络出口。容器逃逸、网络滥用和写满 Host 配额不在 MVP 保证内。
- **仓库、Issue、Artifact 和模型返回都是不可信数据。** 它们不能修改 Control Pack、镜像、工具权限、Secret 边界或人工 gate。
- **MCP Adapter 是运维信任扩展。** 虽然 command/argv/env/protocol 受限，Adapter 仍以 API 容器内的 OS 身份运行，必须审核源码、版本与校验值。
- **远程访问必须加 TLS。** Bearer Token 持有者权限相同；Compose 默认仅把 Web 绑定到 `127.0.0.1`，远程部署应在前面终止 TLS 并配置精确 HTTPS Origin。
- **Provider Vault 是单机静态加密，不是企业 KMS。** 主密钥与密文分文件、权限收紧并做原子替换；两者必须成对备份。它防止只拿到密文的偶然泄露，但挡不住同时取得两文件的 Host root、被攻破的 API 进程或恶意模型 endpoint。

## 10. 失败恢复与幂等性

| 失败点 | 当前处理 | 恢复方式 |
|---|---|---|
| 重复/乱序消息 | `clientMessageId + fingerprint` replay；序号不同返回 conflict | 客户端刷新 Session 后重试；不会重复启动已完成 turn |
| Provider/MCP/Planner 失败 | 记录安全失败事件，用户消息标记 failed，Session 回到 idle | 修正 Provider/Adapter 后发送新消息；不会自动重放外部调用 |
| Provider Vault 缺文件、认证失败、损坏或遗留中断临时文件 | API 启动 fail closed，不生成空配置覆盖旧状态 | 运维者检查并成对恢复 key/ciphertext；不能靠页面绕过或静默重建 |
| Provider 页面配置冲突或检查失败 | 旧 version 返回 409；草稿保存后保持停用；后续请求不 fallback | 刷新配置，在原卡片修正并重新“保存、测试并启用” |
| 旧 LM Studio Responses 配置迁移 | 启动时保留地址、模型、凭据和工具设置，改为 Chat Completions；旧检查失效并安全停用 | 确认模型已加载，在原卡片重新检查并启用；若 JSON 检查仍失败，升级 LM Studio 和推理运行时后重试 |
| Git import/sync 中断 | 未采用 Workspace 标记失败并清理，Project 保存安全错误 | 服务启动会重新调度仍处于未完成状态的 repository operation |
| Worker 超时或非零退出 | TERM 后 KILL，尝试强制删除精确容器；Execution/Phase 标记 failed | 修正配置/代码后在同一 Run 重试当前阶段 |
| Worker 容器无法确认清理 | Workspace 在当前 API 进程内 quarantine，不再并发使用 | 下次启动 preflight 先删除同 deployment 的遗留 Worker，再开放服务 |
| 阶段执行中 API 重启 | schema migration 把 queued/running Execution 与 Phase 标为 failed | 人工重新启动阶段；不伪造完成 |
| Chat runtime 重启 | running 消息/工具/DeepWiki 标 failed，pending gate 取消，starting Sandbox 标 failed，Session 恢复 idle | 用户显式重试；外部工具和模型调用不自动重放 |
| Artifact 生成失败 | 已选 Artifact 输出路径由事务式保护恢复；未选 Artifact 和控制文件受保护 | 修正后重跑；一般产品源码修改没有全局自动回滚保证 |
| revision/index/hash 不一致 | Ask、Run 或审批 fail closed | 重新同步/新建 Session/重建证据，不能静默换 revision |

Changeset 在请求时用临时 Git index 和隔离 object 目录，以 Run 的 `baseRevision` 生成完整 binary patch，不修改真实 index/object database。实现见 [run-changeset.ts](../../apps/api/src/services/run-changeset.ts)。成功 Run Workspace 会保留以支持 Artifact、审计和 Patch；当前没有自动 retention，运维 prune 只删除无引用的候选 Workspace。

## 11. 部署拓扑

Cloud Compose 定义见 [docker-compose.cloud.yml](../../docker-compose.cloud.yml)：

| 单元 | 网络/端口 | 持久化与挂载 | 说明 |
|---|---|---|---|
| `web` | Host 默认 `127.0.0.1:8080`；容器监听 8080 | 只包含构建后的静态资源 | Nginx 把 `/api` 代理到 `api:4100` |
| `api` | Compose 内 expose 4100 | 同路径挂载 Host Managed Root、Docker socket、只读 MCP bin root | 非 root `10001:10001`；启动先做 Workspace/Docker/image preflight 和 DB migration |
| `postgres` | 仅 Compose 内 5432 | named volume `postgres-data` | API 的权威状态存储 |
| `worker-image` | 仅 build profile，不是常驻服务 | 无 | 构建带 `com.ai-sdlc.worker=true` 的固定 Codex 镜像 |
| 动态 Worker | 由 API 通过 Host Docker daemon 按 Execution 创建 | 主仓 Workspace rw、`.git` ro、Control Pack ro、ephemeral tmpfs | `--rm` 临时容器；失败时显式清理，启动时回收遗留容器 |

Host Docker daemon 解析 bind mount 的 source，因此 API 容器必须以相同绝对路径看见 `AI_SDLC_HOST_WORKSPACE_ROOT`。启动 preflight 会验证该目录可创建/读回/删除 sentinel、Docker Server Version 可读、Worker image label 正确，并把可变 tag 解析为不可变 image ID。

## 12. 已知 MVP 限制

- 单租户、自托管、部署级 Bearer Token；没有用户、组织、RBAC、计费、审计主体隔离或 Token 轮换 UI。
- 只支持单 API 实例。Session lock、真实阶段并发上限和后台任务都在进程内；没有 durable queue、暂停/取消协议或安全横向扩展。
- Provider Vault 只有四个实例级槽位和一个 Custom；没有 per-user Secret、企业 KMS、跨副本一致性、多个 Custom，也没有完整 DNS rebinding 防护。恶意网络环境仍需部署级 egress policy。
- Docker 不是 microVM。当前没有网络 egress policy、每 Run 硬磁盘配额、短期模型凭据代理、自动 Secret 扫描或 hostile code 隔离声明。
- 一个 Session/Run 只能写一个主仓；没有多仓写入、跨仓事务、附加仓任意源码检索或跨仓语义聚合。
- MCP 只开放管理员安装的只读 Work Item Adapter；没有浏览器任意安装、通用外部写/删除或可恢复 Human Gate 执行框架。
- Provider-native Agent Runtime 尚未替换生产六阶段 Docker Codex Worker。
- LLM DeepWiki 需要手工触发；Lite/LLM 两层都受大小和检索预算限制，不是完整 Wiki、向量数据库或全仓知识图谱。
- 成功 Run Workspace 不自动删除；应用层 repository byte limit 在 materialization 后验收，不能代替 Host filesystem 的硬容量配额。
- Cloud Verification 只能使用导入仓库中已有的测试/浏览器套件；远程项目不支持 Desktop Figma 写入或 legacy-local 的独立 Linked E2E authoring。
- 平台只生成/下载 Patch，不自动 push、raise PR、merge、deploy 或 release；这些动作必须在平台外由人或另一个明确授权的流程完成。
- `legacy-local` 兼容路径仍可能使用 Host runner，安全边界与远程 Cloud 主路径不同，不能把本文件的 Worker 隔离声明套用到它。

## 13. 关键实现索引

| 主题 | 实现 |
|---|---|
| API 组合、路由、公开错误和恢复启动 | [app.ts](../../apps/api/src/app.ts), [server.ts](../../apps/api/src/server.ts) |
| 数据模型与事务 | [schema.ts](../../apps/api/src/db/schema.ts), [store.ts](../../apps/api/src/db/store.ts) |
| Git、Workspace、Control Pack | [cloud-project-service.ts](../../apps/api/src/services/cloud-project-service.ts), [git-broker.ts](../../apps/api/src/services/git-broker.ts), [definition-loader.ts](../../apps/api/src/services/definition-loader.ts) |
| Chat-first orchestration | [agent-session-service.ts](../../apps/api/src/services/agent/agent-session-service.ts), [conversation-planner.ts](../../apps/api/src/services/agent/conversation-planner.ts), [agent-sdlc-coordinator.ts](../../apps/api/src/services/agent/agent-sdlc-coordinator.ts) |
| Provider 配置与 Ask | [provider-configuration-service.ts](../../apps/api/src/services/llm/provider-configuration-service.ts), [provider-configuration-vault.ts](../../apps/api/src/services/llm/provider-configuration-vault.ts), [provider-registry.ts](../../apps/api/src/services/llm/provider-registry.ts), [ask-service.ts](../../apps/api/src/services/ask/ask-service.ts) |
| MCP | [mcp-tool-router.ts](../../apps/api/src/services/agent/mcp-tool-router.ts), [work-item-mcp-registry.ts](../../apps/api/src/services/work-item/work-item-mcp-registry.ts) |
| Knowledge | [deepwiki-lite.ts](../../apps/api/src/services/deepwiki-lite.ts), [project-knowledge.ts](../../apps/api/src/services/project-knowledge.ts), [deepwiki-generation-service.ts](../../apps/api/src/services/agent/deepwiki-generation-service.ts) |
| Workflow、Worker、Patch | [workflow-service.ts](../../apps/api/src/services/workflow-service.ts), [codex-runner.ts](../../apps/api/src/services/codex-runner.ts), [run-changeset.ts](../../apps/api/src/services/run-changeset.ts) |
| Cloud 部署与安全 | [docker-compose.cloud.yml](../../docker-compose.cloud.yml), [worker.Dockerfile](../../docker/worker.Dockerfile), [security-model.md](../security-model.md) |
