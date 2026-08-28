# Chat-first Cloud SDLC Agent：MVP 实施计划

状态：已完成（单租户、自托管 Chat-first MVP）
适合团队：单人开发、自托管、单一信任域
最后更新：2026-08-28

## 一句话目标

用户只绑定一个远端 Git HTTPS 仓库并选择授权，随后一直在同一个云端对话里工作。用户用白话或 `@repo` 下任务；Agent 自己理解任务、选择已安装且已激活的 MCP、启动受控 Sandbox，并把 PM/BA、Designer、Architect、Software Engineer、Tester、DevOps 六个角色和它们的产物真正串成一条可审阅的交付链。

这不是 Devin 的外观复刻。产品的卖点是：**对话入口很轻，SDLC 内核很强，产物能追溯，关键决定仍由人掌握。**

## 先把产品说清楚

### 用户看到的主流程

```text
绑定远端仓库 URL + 选择 Credential Profile
                    ↓
自动固定源码 revision，直接进入 Agent Session
                    ↓
可选：配置默认 Provider / Blueprint / MCP，手工生成 DeepWiki
                    ↓
“@backend 修复 Linear ENG-123，跑完测试”
                    ↓
Agent 选择只读 MCP、整理 Change Contract、启动 Session Sandbox
                    ↓
PM/BA → Designer → Architect → Engineer → Tester → DevOps
                    ↓
每个角色交出产物 → 对话内查看 → 人工批准或要求修改
                    ↓
下一角色读取上游已批准产物，最后交付 Diff / 测试 / 风险 / Patch
```

默认成功路径只有三类动作：绑定仓库、必要时配置 Provider、发送消息。用户不再先选“Ask 还是 Run”，不再填写长 Change Contract 表单，也不必维护 `CLAUDE.md`、`AGENTS.md` 或一根超长 Prompt。

### 云端到底是什么

- 浏览器不绑定本地项目目录，也看不到服务器绝对路径。
- Git Broker 在服务端拉取远端仓库，固定 exact commit。
- 一个 Agent Session 只有一个可写主仓库。消息里明确提到的额外 `@repo` 会固定自己的 exact revision，只把经过校验且受总量限制的语言、入口、文档、测试、构建和关键路径 Manifest 交给 Planner，并固化进 Change Contract；不会挂载为第二个写仓，也不会把源码正文整仓塞进 Prompt。
- 第一次工作消息会懒启动一个持久的 Session Sandbox Workspace。
- 该 Session 的一个 SDLC Run 直接使用同一 Workspace，六个角色连续看到同一份代码状态，不再偷偷克隆第二份工作区。
- 每个阶段由短生命周期、受限的 Docker Worker 执行。MVP 保留 Workspace，不假装已经提供常驻 microVM。
- 不同任务使用不同 Session，避免两项工作混在同一个可写 Sandbox。

## 六角色如何真正串联

固定顺序和 owner 不允许被聊天或模型改变：

| 顺序 | 角色 | 本阶段要做什么 | 交给下游的主要产物 |
|---|---|---|---|
| 1 | PM / BA | 把聊天和 Issue 整理成清楚的目标、范围、验收条件 | Change Contract、PRD、Stories |
| 2 | Designer | 判断是否需要体验设计，说明关键交互与工程交接 | Design Spec / 设计基线 |
| 3 | Architect | 给出方案、边界、风险与可执行决定 | Options、ADR、Architecture、NFR |
| 4 | Software Engineer | 按已批准输入改代码、补测试、自审 | 代码、实施计划、测试证据、Review、Provenance |
| 5 | Tester | 独立核对验收条件和回归风险 | Test Report、独立验证证据 |
| 6 | DevOps | 整理发布前条件、监控与回滚办法 | Release Runbook |

串联规则：

1. 新工作永远从 PM/BA 开始。`involve Architect` 只能表达关注点，不能跳过上游 owner。
2. 后一个角色只读取数据库里“当前、已批准、属于正确 owner”的上游产物，不读取过期版本或随意猜文件名。
3. 一个角色完成后进入 `awaiting_review`。对话页把当前产物逐个展开；全部成功读取后，用户才能批准或要求修改。
4. “批准并继续”先写入真实 Review，再发出明确的继续消息，启动固定顺序中的下一角色。
5. “要求修改”必须写清意见，并留在当前阶段；不会自动越过门禁。
6. 角色正在运行、被阻塞或 Worker 不可用时，系统保持真实状态，不伪造完成。
7. 产物 ID、revision、hash、owner、Review 和 Run 关联都保留；完整页面仍可作为高级审计入口。

## LLM 和 Agent Runtime 怎么分

项目配置一个默认 Provider，对话输入框可按消息切换：

- OpenAI；
- LM Studio；
- Ollama；
- 自定义 OpenAI Responses、OpenAI Chat 或 Ollama Chat 兼容端点。

当前 MVP 分成两层，避免把“能聊天”冒充成“能安全改代码”：

### 1. 对话 Provider

负责聊天回答、任务判断、Change Contract 整理、MCP 工具选择和手工 DeepWiki。每条消息保存实际 Provider 与模型。OpenAI 原生支持 tool calling；LM Studio、Ollama 和 Custom 只有在管理员明确打开能力开关且模型真的支持时，才允许进入工作回合。聊天 Provider 凭据只留在服务端，不进入消息、仓库或 Sandbox，也不会传给阶段 Worker。

### 2. 阶段 Worker

固定六角色的真实代码执行目前仍使用 Docker 内的 Codex Runtime。它拿到受限的 Run Workspace、只读 Control Pack、当前阶段 Prompt、Change Contract、DeepWiki 线索和已批准上游产物，并使用独立、低权限、可快速轮换的运行密钥。聊天 Provider 不会因为返回一段看起来像 JSON 的文本就获得 Shell 或文件权限。

Provider-native 的文件/检查工具循环已经作为受限运行时边界实现并独立测试，但尚未替换生产六阶段的 Docker Codex Worker。MVP 文案必须把这条边界说清楚。

## Prompt 和 DeepWiki 怎么做

- 用户仓库不要求任何 AI 配置文件。
- 平台在仓库外维护版本化 Control Pack。
- Prompt 按层组装：角色权限 → 当前阶段流程 → 产物模板 → 本次任务 → DeepWiki 线索 → 已批准上游产物。
- 每层只有一个职责，避免把所有规则塞进一根难维护的长 Prompt。
- 每个阶段要求“结论先说、白话表达、短句和表格优先”，但证据、风险和门禁不能被省略。
- 仓库绑定只生成确定性的 Repository Manifest，不自动花 LLM 额度。
- 用户可在绑定后手工选择 Provider 生成 LLM DeepWiki；结果固定 revision、Provider、模型、引用和用量。
- 仓库同步后旧 DeepWiki 标记为 stale，不会自动重新生成，也不会改变旧 Session 固定的源码。

## MCP 怎么用

- MCP 由管理员安装，项目只负责激活；聊天时 Agent 自己选择当前已激活工具。
- Jira、Linear 或其他来源与人工描述都进入同一个消息入口，不再先选任务来源。
- 浏览器不能提交 command、args、tool name、固定参数或 Secret。
- 当前 MVP 对外开放的是受限、只读 Work Item MCP；调用前先写入 queued/running 审计记录，再真正执行 Adapter。
- 未知工具、未激活工具、多工具调用、参数不合法、超时或输出超限都 fail closed。
- 外部写入、删除、push、PR、部署和发布仍未开放；因此不会用一个没有恢复语义的假确认按钮冒充 Human Gate。

## 安全边界

- Git 只允许 HTTPS，拒绝 userinfo、query、fragment、危险 ref、私网和未允许 origin。
- Credential、聊天 Provider Key 和 MCP Secret 只存在服务端 Profile / 环境引用里，不进入消息、Prompt、数据库业务内容或 Sandbox。阶段 Codex Worker 只拿独立、低权限的运行密钥，不拿项目聊天 Provider 凭据、Git Token、数据库凭据或平台 Token。
- Blueprint 只能选择管理员批准的名称和版本；最终镜像由 API 启动时验证并固定，浏览器不能指定镜像、命令、Host mount 或 Docker 参数。
- Worker 使用非 root、只读 rootfs、cap-drop、no-new-privileges、CPU / 内存 / PID / 超时限制和精确挂载；不拿 Docker socket、Git Token、数据库凭据或平台 Token。
- 仓库、Issue、MCP 返回和 Artifact Markdown 都是不可信内容，不能提升角色、工具、Sandbox 或发布权限。
- API 重启时，进行中的消息、工具、DeepWiki 和 Sandbox 会被保守标为失败或可重试；不会自动重放外部工具或模型调用。
- MVP 是单租户、单 API 实例、自托管产品，不声称具备不互信租户隔离。

## 本轮实施清单

### A. Chat-first 产品面

- [x] 远端仓库 URL + Credential Profile 一步绑定，自动名称和 `@alias`。
- [x] 绑定后直接创建并进入 Agent Session。
- [x] 同一会话持久化消息、事件、Provider、模型、工具、revision、Sandbox 和 Run 关联。
- [x] Provider 可按下一条消息切换，历史不清空。
- [x] 对话输入支持服务端校验的 `@repo`：主仓可写；明确提到的附加仓固定 revision，只向 Planner 和 Run 提供有界、只读、可验证的 Manifest 路径线索。
- [x] 默认 UI 收敛为会话、角色进度、产物审阅和少量项目设置；完整 Run 保留为高级审计。

### B. Project 能力配置

- [x] Project Agent Settings 保存默认 Provider、固定 Blueprint 与启用 MCP。
- [x] OpenAI、LM Studio、Ollama、自定义 Provider 注册、连接检查和真实能力声明。
- [x] 管理员批准的 Blueprint 目录和启动时镜像校验。
- [x] MCP Catalog、项目激活和只读 Work Item Adapter。
- [x] 手工 LLM DeepWiki，固定 revision / Provider / model / citations / usage。

### C. Agent 与 Sandbox

- [x] Conversation Planner 把白话任务整理成 Change Contract，不要求长表单。
- [x] 原生 tool calling 使用各 Provider 的真实 wire format，不解析普通文本伪造工具调用。
- [x] MCP 调用先落审计再执行，并有轮数、时间、并发、参数和输出边界。
- [x] Session Sandbox 固定源码 revision 和 Blueprint，刷新后可恢复。
- [x] Session Sandbox 与该 Session 的 Run 共用同一个 Workspace。
- [x] 附加 `@repo` 的有界 Manifest 进入 Planner，并作为不可变 Change Contract 上下文供六角色阶段读取；续跑不能偷偷替换仓库或 revision。
- [x] 重启恢复 fail closed，不重放外部副作用。

### D. 六角色和产物链

- [x] 新 Run 真正创建并启动 PM/BA，而不是只显示计划卡。
- [x] 固定六阶段顺序和 owner 校验，不能通过 `involve` 跳阶段。
- [x] 每个角色只选择当前、已批准的上游 Artifact heads。
- [x] 同一个 Session 显式继续已有 Run，不重复创建 Run。
- [x] Chat-first 内联查看当前产物、要求修改、批准并继续。
- [x] 角色失败、阻塞或等待审阅时保留可恢复的真实状态。

### E. Cloud 与交付边界

- [x] Public DTO、错误和 Web 不泄露 Workspace、Control Pack、Secret 或原始 Git 错误。
- [x] 远端真实阶段只走受限 Docker Worker；未配置时不回退宿主执行。
- [x] Changeset / binary Patch 可审阅下载。
- [x] Bearer Token、精确 CORS、Cloud 启动 preflight 和 Workspace 清理。
- [x] 不自动 push、建 PR、merge、deploy 或 release。

### F. 验证和自修复

- [x] 契约、Store、API、Web、Git、Provider、MCP、Sandbox、角色链和安全边界有独立检查。
- [x] 对关键路径做正确性、安全、错误处理、规格偏移和对抗审查，并修复已发现高风险问题。
- [x] 最终重复运行 root 与 platform 全量检查、build、pack 和 diff whitespace 检查。
- [x] 使用已批准的本地 Worker 镜像运行真实 Tier-D Docker smoke。
- [x] 启动本地 Web，并用真实浏览器走通仓库绑定、Agent Session、Run、产物查看、人工批准和下一角色启动。

## MVP 验收条件

- **MVP-AC-01**：用户不提供本地路径，只绑定远端 HTTPS Git 仓库和可选授权，就进入对话。
- **MVP-AC-02**：没有 `CLAUDE.md`、`AGENTS.md` 或 DeepWiki 也能开始；LLM DeepWiki 只能手工触发。
- **MVP-AC-03**：一条明确工作消息自动创建 Change Contract、Session Sandbox 和 Run，并真实启动 PM/BA。
- **MVP-AC-04**：六角色固定串联；下游只消费已批准的正确 owner 产物，不能跳阶段。
- **MVP-AC-05**：每阶段当前产物能在聊天页打开，全部查看后才能批准或要求修改；批准后继续下一角色。
- **MVP-AC-06**：Provider 可切换且能力不夸大；没有原生 tool calling 的配置不能启动工作回合。
- **MVP-AC-07**：Agent 只看到项目已激活 MCP，调用先审计后执行；MCP 内容不能提升权限。
- **MVP-AC-08**：一个 Session 只有一个写仓；Sandbox 和 Run 使用同一固定 revision Workspace。附加仓只有有界 Manifest 参考，不能获得写权限或替换已固定的 Run 上下文。
- **MVP-AC-09**：重启、并发、重试、Worker 故障和旧 revision 都 fail closed，不伪造阶段完成。
- **MVP-AC-10**：最终提供 Diff、测试证据、风险与 Patch，但不会擅自 push、PR、合并、部署或发布。

## 这版仍然不冒充完成的能力

- 多租户用户体系、组织、RBAC、计费、配额、microVM 和分布式队列。
- 多仓同时写入、跨仓原子提交、把附加仓挂载进 Worker、读取其任意源码正文，以及跨仓向量检索或完整语义聚合；当前只传递固定 revision 的有界 Manifest 路径线索。
- 用户在浏览器安装任意 MCP Server 或上传任意 Dockerfile / 镜像。
- 通用、可恢复的外部写操作 Human Gate；当前 MVP 没有开放外部写工具。
- 让 OpenAI、LM Studio、Ollama 或 Custom 直接替换生产六阶段 Codex Worker。
- 自动 push、PR / MR、merge、deploy 或 release。
- 完整 DeepWiki 网站、向量数据库或全仓语义图谱。
- 多个不同工作共用一个 Session；新任务应创建新 Session。

## 最终验证命令

```bash
# repository root
npm test
npm pack --dry-run
git diff --check

# platform/
yarn typecheck
yarn test
yarn build
```

真实 Docker Tier-D 只在明确配置已批准 Worker 镜像时执行：

```bash
AI_SDLC_WORKER_IMAGE=ai-sdlc-worker:local yarn test:docker-smoke
```

没有 Docker 或镜像时，Skip 是诚实结果，不能写成“真实 Worker 已通过”。真实 Provider 也只有在运维者配置实际端点和凭据后，才能把连接检查称为真实 smoke；协议替身测试不冒充联网结果。

## 最终验证结果

2026-08-28 在当前工作区完成最后一轮验证：

- `platform/yarn typecheck`：通过。
- `platform/yarn test`：命令通过；Contracts 51/51，Web 134/134（含业务流程与技术设计文档验收 6/6），API 925 项中 924 通过、0 失败、1 项按设计跳过。普通全量套件不把没有显式镜像的 Docker 检查冒充成成功。
- `platform/yarn build`：通过。Vite 仅报告现有动态导入和大 chunk 提示，没有构建失败。
- `AI_SDLC_WORKER_IMAGE=ai-sdlc-worker:local yarn test:docker-smoke`：真实 Tier-D 1/1 通过，验证 Worker 能读 Control、写 Run Workspace，不能改只读 `.git` / Control，也拿不到 Docker socket。
- 根目录 `npm test`：32/32 通过。
- 根目录 `npm pack --dry-run --cache /private/tmp/ai-sdlc-npm-cache`：通过，79 个发布文件，tarball 约 138.2 kB。使用临时 cache 是为了绕开当前用户 npm cache 的历史 owner 问题，不是绕过包检查。
- `git diff --check`：通过。
- 浏览器主路径：远端仓库绑定后直接进入 Agent Session；消息创建同一个 Run 并启动 PM/BA；3 份当前产物全部展开后批准按钮才解锁；批准后沿用原 Run，Designer 真正启动并交出 2 份待审阅产物。
- 独立七视角与对抗审查发现并修复了 Run/Session 跨事务恢复、MCP 虚构工单引用和 Blueprint 网络能力误报；故障切点与边界定向回归 31/31 通过，最终没有未解决的 P0/P1/P2。

浏览器和 Provider 端到端使用的是本地受控测试 Provider / Fake Codex，用来证明状态、交互、门禁与角色串联；它不冒充真实外部 Provider 联网或真实业务代码交付。真实 Worker 隔离边界由上面的独立 Docker Tier-D 证明。
