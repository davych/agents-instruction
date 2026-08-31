# 灵活 AI SDLC 工作台执行计划书

状态：待执行  
范围：`platform/` Web、API、Contracts、Sandbox、MCP 与已初始化目标项目  
目标形态：项目驱动、阶段可独立运行、产物跟随项目、MCP 能力化、Repo 环境蓝图驱动

## 1. 一句话目标

把当前偏线性、偏阶段审批的 SDLC 流程改造成一个项目驱动的 AI 工作台：用户可以从需求探索、设计、架构、实现、测试、发布中的任意阶段开始，按需引用项目产物和外部 MCP 上下文；AI 在目标项目的受控 Sandbox 中工作，依据 Repo 环境蓝图启动服务、操作浏览器并运行自动化测试；所有文件产物继续保存在目标项目中，平台通过统一执行回执说明项目、环境、测试、Git 和外部系统发生了什么。

## 2. 本次改造解决的问题

当前产品已经具备六阶段、Artifact、Changeset、Sandbox、Provider、MCP、Figma 和 E2E 等基础能力，但这些能力主要服务于固定串联流程，用户日常使用仍有以下阻力：

- 小 Bug、补测试、UI 调整也容易被引导回完整上游流程。
- 阶段执行依赖前置 Artifact、批准和状态，难以独立启动。
- 产物、代码变化、测试、环境和外部工具结果分散，用户不容易快速判断本次 Run 做了什么。
- Changeset/Diff 被赋予过重的交付含义；对于文档、图片、Figma、测试和外部系统操作，Diff 不是唯一也不是最佳结果表达。
- 当前 MCP 主要聚焦只读 Work Item 和少量专用集成，尚未形成贯穿六阶段的通用能力与授权模型。
- 当前 Sandbox Blueprint 更接近管理员批准的运行镜像选择，还不能由每个 Repo 声明如何安装、启动、检查健康、运行测试和收集证据。
- 前端开发服务器、后端服务、数据库和测试浏览器缺少可跨 AI 回合持续运行的统一 Environment Session。

## 3. 目标产品定义

产品由以下六个核心对象组成：

| 对象 | 职责 | 真相来源 |
|---|---|---|
| Project | 项目、目标仓库、阶段产物、连接和历史的归属边界 | 平台项目记录 + 目标项目目录 |
| Stage | 需求、设计、架构、实现、测试、发布六类能力入口 | 固定阶段目录与角色定义 |
| Run | 一次具体任务的输入、执行和状态 | 平台持久化 Run |
| Result Receipt | 文件、环境、测试、Git、MCP 和外部副作用的统一执行回执 | Run 执行记录与受信工具结果 |
| Environment Blueprint | Repo 如何准备 Sandbox、启动服务和运行测试的声明式合同 | Repo 内版本化配置 |
| Environment Session | 蓝图创建出的实际 Sandbox、服务、端口、浏览器和测试运行环境 | 运行时状态与事件 |

核心关系：

```text
Project
 ├─ 项目文件与 SDLC 产物
 ├─ Environment Blueprint
 ├─ MCP 连接与权限
 └─ Run 历史
          ↓
Environment Session（按需创建或复用）
          ↓
Run（任意阶段）
          ↓
Result Receipt
```

## 4. 产品原则

1. 六阶段保留固定展示顺序和角色所有权，但不再是强制执行依赖。
2. 每个阶段都可以独立创建 Run。
3. 前置产物是推荐上下文，不是平台级硬阻塞条件。
4. 完整流程只是多个普通 Run 的可编辑编排，不创建第二套执行模型。
5. 需求、设计、架构、代码、测试和发布产物继续写入目标项目目录。
6. 平台数据库保存索引、关系、状态和执行证据，不复制一套项目内容作为新的真相来源。
7. Diff 是结果查看方式之一，不是每次 Run 的必经步骤。
8. Git Commit、Push、PR、Merge、Deploy 和 Release 是独立动作，不能由“阶段完成”隐式授权。
9. MCP 按能力、作用域和副作用分类，不把流程写死到某个供应商。
10. Environment Blueprint 跟随 Repo 版本化，但只能使用平台批准的运行时和受控字段。
11. AI 通过结构化环境工具管理长期服务，不用阻塞 Shell 命令假装服务托管。
12. 所有高影响外部动作都必须留下可验证回执。

## 5. 用户主流程

### 5.1 三个入口

首页只提供三个工作入口：

- `完整流程`：选择需要经过的阶段，系统给出推荐顺序。
- `运行一个阶段`：直接选择需求、设计、架构、实现、测试或发布。
- `快速修改`：直接进入实现，可选继续测试、查看 Git 状态或提交。

三者最终都创建同一种 Run。

### 5.2 一次 Run 的四步

```text
选择阶段 → 描述任务 → 选择上下文与工具 → 查看执行结果
```

用户只需描述当前任务。高级选项可以选择：

- 当前项目文件或目录；
- 某个阶段产物；
- 某次历史 Run；
- 指定 Branch、Commit 或工作区状态；
- Jira、Linear、Notion、Figma 等 MCP 资源；
- 是否创建或复用 Environment Session；
- 本次允许的工具和写入范围。

### 5.3 常见路径

| 场景 | 推荐路径 |
|---|---|
| 新产品能力 | 需求 → 设计 → 架构 → 实现 → 测试 → 发布 |
| 普通功能 | 需求 → 设计 → 实现 → 测试 |
| 小 Bug | 实现 → 测试 |
| UI 调整 | 设计 → 实现 |
| 补测试 | 测试 |
| 架构评审 | 架构 |
| 测试失败排查 | 测试 → 实现 → 测试 |
| 线上故障 | 监控上下文 → 实现 → 测试 → 发布 |
| 已有版本发布 | 测试 → 发布 |

推荐路径不构成状态机限制，用户可以随时跳过、插入、重跑或结束。

## 6. 六阶段统一合同

所有阶段采用同一个 Run 合同，只改变角色、推荐上下文、默认输出和推荐工具。

| 阶段 | 推荐输入 | 典型项目产物 | 推荐工具 |
|---|---|---|---|
| 需求探索 | 用户描述、Issue、业务文档、用户反馈 | 需求说明、范围、验收条件、Stories | Jira、Linear、Notion、Confluence、Drive、网页研究 |
| 设计 | 需求、现有页面、设计系统 | 设计说明、交互规则、原型、Figma 引用 | Figma、Browser、设计资源库 |
| 架构 | 当前代码、需求、设计、接口和数据结构 | 方案比较、ADR、架构图、NFR | Git、代码搜索、OpenAPI、数据库、云平台 |
| 实现 | 当前任务、相关文件、可选上游产物 | 源码、配置、测试、实现说明 | Filesystem、Git、包文档、数据库、终端 |
| 测试 | 验收条件、当前代码、运行环境 | 测试代码、测试报告、缺陷记录 | Browser、Playwright、API、数据库、CI、日志 |
| 发布 | 指定版本、测试结果、环境配置 | 发布说明、Runbook、部署记录 | Git 托管、CI/CD、容器、云平台、监控、通知 |

阶段执行前不再要求最小数量的已批准上游 Artifact。若上下文不足，角色应在 Run 中提出具体问题或返回 Blocked，而不是由平台用固定前置步骤阻止启动。

## 7. 产物与执行结果

### 7.1 产物归属

- 所有 SDLC 产物继续按 Artifact Owner 解析到目标项目目录。
- `templates/ai-native.yaml` 继续登记 Web 可审阅产物。
- Artifact revision、owner、hash、来源 Run 和输入引用继续持久化。
- 平台不创建与项目文件竞争的第二套正文存储。
- 已初始化项目通过增量 backfill 获得新定义，不能整体重写项目拥有的内容。

### 7.2 Result Receipt

每次 Run 完成后生成统一执行回执，至少包含：

- 完成、失败、取消或阻塞摘要；
- 创建、修改、删除的项目路径；
- 新增或更新的阶段产物；
- 执行的命令、退出码、耗时和输出摘要；
- Environment Blueprint、Session 和服务健康状态；
- 测试套件、通过数、失败数、跳过数和附件；
- Git 基线、当前状态和可选 Changeset；
- MCP 调用、外部资源链接和副作用；
- 使用的权限与关键授权决定；
- 未完成事项、风险和推荐下一步。

### 7.3 结果页

结果页统一提供：

- `总结`
- `产物与文件`
- `环境`
- `测试与命令`
- `外部操作`
- `Git`
- `日志`

文本和代码可以打开 Diff；图片、Figma、测试 Trace、视频和外部资源使用对应预览。没有 Git 或没有文本变化时，结果页仍能完整工作。

### 7.4 Run 后续动作

- 继续修改；
- 打开项目文件或产物；
- 基于本次结果创建任意阶段的新 Run；
- 保留当前项目状态；
- 查看 Git 状态或 Diff；
- 暂存、Commit、Push 或创建 PR；
- 重新运行测试；
- 停止或保留 Environment Session。

不要求用户必须审阅 Diff、批准 Artifact 或创建 Commit 才能结束 Run。

## 8. Git 能力

Git 是可选的项目版本能力，不是阶段门禁。

### 8.1 能力范围

| 能力 | 默认策略 |
|---|---|
| status、branch、log、diff | 项目级只读授权 |
| 创建分支、stage、unstage | 工作区写权限 |
| commit | 明确授权，可编辑 message 和文件范围 |
| push、创建 PR/MR | 外部写权限，执行前确认 |
| merge、tag、release | 高影响权限，单独确认 |
| 丢弃或覆盖修改 | 高风险操作，仅在可证明安全恢复时开放 |

### 8.2 基线与归属

代码 Run 开始前记录：

- `HEAD` 和 Branch；
- 已有 tracked/untracked 修改；
- 工作区模式；
- 本次 Run 的写入范围。

Run 结束时区分原有修改、本次 Run 修改和随后发生的修改。无法可靠归属时不提供“一键撤销本次 Run”，也不能使用仓库级粗暴重置。

现有 Changeset/Patch API 保留，调整为 Result Receipt 中的 Git 展示和下载能力，而不是所有 Run 的完成条件。

## 9. MCP 能力体系

### 9.1 从安装项升级为能力目录

MCP Catalog 除安装和激活状态外，需要声明：

- 能力名称；
- 支持的读、写、执行或发布操作；
- 资源作用域；
- 授权状态与过期时间；
- 是否产生外部副作用；
- 是否支持幂等、撤销或补偿；
- 输入和输出上限；
- 可用于哪些阶段；
- Secret 使用方式。

建议统一能力命名：

```text
issue.read                 issue.write
document.read              document.write
design.read                design.write
repository.read            repository.commit
repository.push            repository.pull-request
browser.inspect            browser.test
database.schema.read       database.data.read
database.data.write        ci.run
deployment.preview         deployment.publish
observability.read         notification.send
```

### 9.2 首批连接类别

| 类别 | 代表连接 | 用途 |
|---|---|---|
| Work Item | Jira、Linear、GitHub Issues | 需求和验收上下文 |
| Knowledge | Notion、Confluence、Google Drive | 文档和规范 |
| Design | Figma | 设计读取、写入和交接 |
| Repository | Git、GitHub、GitLab | 版本、Commit、PR 和 CI |
| Browser/Test | Playwright、Browser、API Client | 页面和接口测试 |
| Data | PostgreSQL、MySQL、SQLite | Schema、测试数据和验证 |
| Delivery | GitHub Actions、GitLab CI、Docker、Kubernetes、Cloudflare、Vercel | 构建、预览和发布 |
| Observability | Sentry、Datadog、Grafana、日志系统 | 故障诊断和发布观察 |
| Communication | Slack、Teams | 通知和协作 |

具体厂商通过 Adapter 映射到统一能力，不写死进阶段逻辑。

### 9.3 授权分层

1. 读取上下文：可在项目级持续授权。
2. 修改项目：Run 启动时按项目根目录和路径范围授权。
3. 修改外部系统：按连接或当前 Run 授权，并展示动作摘要。
4. 发布与高影响操作：Push、Merge、数据库写入、部署、发布和删除必须临执行前确认。

MCP 返回内容始终视为不可信数据，不能提升角色、路径、Secret、Sandbox 或发布权限。

### 9.4 外部副作用回执

每次外部写操作记录：

- MCP、工具和能力；
- 操作目标与稳定资源 ID；
- 请求摘要；
- 授权主体和授权范围；
- 开始、完成或失败时间；
- 返回链接或版本；
- 幂等键；
- 可撤销、可补偿或不可恢复标记。

## 10. Repo Environment Blueprint

### 10.1 定位

Environment Blueprint 不是第七阶段，而是实现、测试、发布及按需设计验证共用的运行底座。

推荐 Repo 路径：

```text
.ai-sdlc/environment.yaml
```

`ai-native.yaml` 引用这份配置。平台绑定 Repo 时自动识别并校验；没有蓝图的项目仍可运行不需要执行环境的阶段。

### 10.2 安全模型

Repo 蓝图可以声明项目如何运行，但不能直接控制宿主机。它只能：

- 引用管理员批准的基础 runtime/image；
- 使用允许的 Sandbox executor；
- 声明受限 workspace、cache、service、port、healthcheck 和 named action；
- 引用 Secret 名称，不能包含 Secret 值；
- 申请受策略限制的网络和资源能力；
- 使用平台允许的测试和附件类型。

禁止通过蓝图声明 privileged、宿主机任意 mount、Docker Socket、任意设备、宿主用户、未批准镜像或绕过资源限制。

### 10.3 蓝图内容

蓝图需要支持：

- runtime/image 与版本；
- workspace 挂载方式；
- CPU、内存、磁盘、PID 和超时；
- 依赖缓存；
- setup/bootstrap 动作；
- 多服务及依赖关系；
- 端口和内部预览；
- 健康检查与 readiness timeout；
- migration、seed、reset 和 fixture；
- lint、typecheck、unit、integration、e2e、build 等 named action；
- Browser base URL；
- screenshot、trace、video、coverage、JUnit 等附件；
- development、testing、release 等 profile；
- Secret 引用和网络策略；
- Session 复用、停止和清理策略。

### 10.4 自动生成

绑定 Repo 或进入环境设置时扫描：

- `package.json` 与 lockfile；
- `Dockerfile`、Compose 和 Dev Container；
- Vite、Next.js 等前端配置；
- Playwright、Cypress、Vitest、Jest 等测试配置；
- 项目已有 scripts、端口和 health endpoint。

平台生成蓝图建议，由用户确认后写入 Repo。自动发现不能直接启动未确认的任意命令。

## 11. Environment Session

### 11.1 生命周期

```text
unconfigured → provisioning → bootstrapping → starting → ready
                                      └──────→ unhealthy / failed
ready → stopping → stopped → cleaned
```

Session 固定：

- Project 和 Repo revision；
- Blueprint 内容 hash 和版本；
- Workspace；
- Runtime；
- Profile；
- Secret 与网络授权快照；
- 启动的服务、端口和进程；
- 创建它的 Run 或 Agent Session。

### 11.2 服务监督

长期服务由独立 supervisor 托管，不能绑定到一次 LLM tool call 的生命周期。每个服务保存：

- 状态和 PID/容器身份；
- 启动时间；
- 依赖服务；
- health/readiness；
- 日志流；
- 重启次数；
- 内部地址与预览地址。

### 11.3 AI 环境工具

向 AI 暴露结构化工具，而不是无边界 Shell：

```text
environment.inspect
environment.ensure
environment.stop
environment.rebuild
service.list
service.start
service.restart
service.status
service.logs
action.list
action.run
test.run
browser.open
```

蓝图中已声明且策略允许的 named action 可以自动执行；未声明命令或能力升级进入授权流程。

### 11.4 Session 复用

- 实现和紧随其后的测试默认可以复用同一 Session。
- 新任务默认创建新的 Run，但可明确选择复用环境。
- Blueprint、Repo revision、Secret scope 或高影响配置变化时必须新建或重建 Session。
- 并行写代码优先使用不同 worktree/Workspace，不能让多个 Writer 共享同一可写目录。

## 12. 前端预览与自动化测试

### 12.1 受控预览

- Sandbox 内部端口通过平台受控代理生成短期预览地址。
- 默认只对当前项目用户和测试浏览器可见，不自动公开互联网。
- Preview 绑定 Environment Session、service 和 port，不接受浏览器提交任意转发目标。
- 用户可以打开预览并在需要时接管 AI 的浏览器会话。

### 12.2 测试类型

统一支持：

- lint 与 typecheck；
- 单元测试；
- 集成与 API 测试；
- E2E 浏览器测试；
- 可选可访问性和视觉回归；
- build 和发布前 smoke。

### 12.3 AI 交互闭环

```text
读取任务与设计
  → environment.ensure
  → 等待服务健康
  → browser.open
  → 操作页面并观察 console/network
  → 修改项目文件
  → 热更新或重启服务
  → action.run / test.run
  → 读取失败日志、截图和 trace
  → 修复并重跑
  → 生成 Result Receipt
```

探索性 Browser MCP 操作与可复现测试证据需要区分。正式 E2E 结论必须绑定可追踪脚本、环境、revision、命令和退出状态。

### 12.4 测试附件

结果回执可关联：

- screenshot；
- Playwright trace；
- video；
- console/network 摘要；
- JUnit；
- coverage；
- service logs；
- API 请求失败摘要。

附件存放在受控 Run Workspace 或项目登记的测试输出目录，并受到大小、数量、保留时间和敏感信息过滤约束。

## 13. UI 信息架构

### 13.1 项目首页

顶部保留六阶段卡片，任意卡片都可直接开始。主要动作：

- 开始完整流程；
- 运行一个阶段；
- 快速修改；
- 查看最近运行。

首页摘要展示：

- 最近 Run；
- 当前阶段产物；
- 待处理结果；
- Git 状态；
- Environment Session 状态；
- MCP 连接和授权问题。

### 13.2 Run 创建页

默认字段只有阶段和任务描述。以下内容收进可展开的“上下文与工具”：

- 项目路径/文件；
- 历史 Artifact/Run；
- Git revision；
- Environment profile；
- MCP；
- 权限和写入范围；
- Provider/model。

### 13.3 Environment 面板

提供：

- 蓝图状态和版本；
- 创建、启动、停止、重建；
- 服务和健康状态；
- 端口与打开预览；
- 日志；
- Named Actions；
- 测试入口；
- 资源和过期时间。

### 13.4 连接与权限

按项目展示 MCP/Git/Provider/Secret 的连接、能力、作用域和授权状态，不在阶段表单里重复配置。

## 14. Contracts 与 API 改造

### 14.1 Contracts

在 `platform/packages/contracts` 增量引入：

- `RunIntent`：single-stage、orchestrated、quick-change；
- `RunContextReference`：artifact、project-path、run、git-revision、mcp-resource；
- `RunEnvironmentRequest`：none、create、reuse，以及 profile；
- `RunExecutionState`、`RunOutcomeState`、`RunDispositionState`；
- `ResultReceipt` 与 file/environment/test/git/external-effect sections；
- `McpCapability`、`CapabilityGrant`、`ExternalEffectReceipt`；
- `RepositoryEnvironmentBlueprint`、`EnvironmentSession`、`ManagedService`、`NamedAction`；
- `TestExecution` 与附件 DTO。

保留现有 DTO 的兼容解析，旧 Run 不强制补齐新字段。

### 14.2 建议 API

```text
POST   /api/projects/:projectId/runs
GET    /api/runs/:runId/result
POST   /api/runs/:runId/continue

GET    /api/projects/:projectId/environment-blueprint
POST   /api/projects/:projectId/environment-blueprint/detect
PUT    /api/projects/:projectId/environment-blueprint

POST   /api/projects/:projectId/environment-sessions
GET    /api/environment-sessions/:sessionId
POST   /api/environment-sessions/:sessionId/actions/:actionId
POST   /api/environment-sessions/:sessionId/services/:serviceId/restart
POST   /api/environment-sessions/:sessionId/stop
GET    /api/environment-sessions/:sessionId/logs

GET    /api/projects/:projectId/capabilities
POST   /api/projects/:projectId/grants
POST   /api/runs/:runId/external-actions
```

最终路由命名在 Contracts 设计阶段确认。所有带副作用接口需要幂等键、expected state/version 和审计记录。

## 15. 后端改造边界

优先复用现有组件：

| 现有组件 | 改造方向 |
|---|---|
| `workflow-service.ts` | 将阶段前置校验拆成职责校验、推荐上下文和真正安全门禁；支持独立阶段 Run |
| `run-changeset.ts` | 作为 Result Receipt 的 Git section，不再代表全部结果 |
| `sandbox-blueprint-registry.ts` | 从管理员静态 Blueprint 扩展为“批准 runtime + Repo 声明配置”的双层模型 |
| `project-agent-capability-service.ts` | 扩展通用 MCP capability、授权状态和作用域 |
| `mcp-tool-router.ts` | 从只读 Work Item 路由升级为能力路由、授权门禁和外部副作用回执 |
| `agent-session-service.ts` | 允许选择阶段和环境策略，不再默认创建固定六阶段串联 Run |
| `docker-agent-sandbox-check-runner.ts` | 扩展 named action 执行，但保持资源、网络、挂载和 Secret 边界 |
| `e2e-automation-runner.ts` | 接入 Environment Session、service readiness 和统一测试结果 |
| `figma-mcp-integration.ts` | 迁移到通用 MCP capability 展示，同时保留真实写入证据检查 |

新增服务建议：

- `repository-environment-blueprint-service`；
- `environment-session-service`；
- `managed-service-supervisor`；
- `preview-proxy-service`；
- `named-action-runner`；
- `run-result-receipt-service`；
- `capability-grant-service`；
- `external-effect-audit-service`。

## 16. 前端改造边界

| 现有区域 | 改造方向 |
|---|---|
| `project-page.tsx` | 六阶段独立入口、快捷路径、环境和连接摘要 |
| `execute-dialog.tsx` | 收敛为阶段、任务和可展开上下文；移除不必要的强制前置 Artifact 选择 |
| `run-page.tsx` | 以 Result Receipt 为中心，Diff 作为 Git/文件子视图 |
| 阶段 flow guides | 从硬性推进改为推荐下一步和快捷创建 Run |
| review dialogs | 保留需要审阅的产物能力，不再作为每个阶段继续的统一门禁 |
| E2E dialogs | 接入 Environment Session、测试动作、预览、日志和附件 |

新增界面：

- Repo Environment Blueprint 编辑与自动发现；
- Environment Session 状态面板；
- MCP 能力与授权矩阵；
- 统一 Result Receipt；
- 完整流程编排器；
- 外部操作确认与回执。

## 17. 数据与兼容迁移

### 17.1 兼容原则

- 旧 Run、Artifact、Review、Changeset 和 Session 必须继续可读。
- 旧固定六阶段 Run 保持原推进语义，不在读取时偷偷改成新流程。
- 新 Run 使用新的灵活执行语义。
- 用 schema/version 或 execution model 显式区分 legacy 与 flexible。
- 新字段优先 additive；需要 DDL 时单独提交迁移方案和回滚办法。
- 已初始化项目只做显式增量 backfill，保留项目拥有的文件。

### 17.2 建议迁移

1. 给 Project 增加 workflow execution model 与 blueprint source/version。
2. 给 Run 增加 intent、context references、environment session 和 result receipt version。
3. 给 MCP installation/activation 增加 capability 与 grant metadata。
4. 增加 Environment Session、Service、Action Execution、External Effect 记录。
5. 旧 Changeset 在结果投影中映射为 Git section。
6. 旧 Review 保持原样；新 Run 只有显式需要人工决定时创建 Decision/Grant。

## 18. 安全与可靠性要求

- 一个 Environment Session 只有一个可写主 Workspace。
- 并行 Writer 使用独立 worktree 或 Workspace。
- Repo Blueprint 视为不可信输入，必须 schema 校验和策略编译。
- Blueprint 固定 content hash，运行中不能静默变化。
- named action 使用受控 runner，不接受浏览器提交任意 argv、env、mount 或 image。
- Secret 只按 action/service 注入，日志和 Result Receipt 必须脱敏。
- Preview 只代理 Session 已登记且健康的端口。
- 外部网络按项目和 profile 限制。
- MCP、仓库文件、测试输出和网页内容不能修改系统权限。
- 外部副作用 API 必须幂等；服务重启不得自动重放未确认操作。
- Session 超时、失败、API 重启和 Worker 异常都保留真实状态，不伪造成功。
- 环境停止与项目文件持久化解耦；清理 Sandbox 不能删除目标项目产物。
- 不承诺对所有外部系统提供通用撤销；不可恢复动作必须提前说明。

## 19. 实施里程碑

### M0：架构决策与目标合同

交付：

- 确认“六阶段固定目录和 owner、执行可独立”的新语义；
- 确认 legacy 与 flexible 双模型兼容策略；
- 确认 Project、Run、Result Receipt、Capability、Blueprint、Environment Session 合同；
- 确认 Repo 蓝图与管理员批准 runtime 的安全边界；
- 确认需要的存储变更和迁移策略。

完成条件：主要对象、状态机、权限边界和迁移方式形成 ADR，之后再改代码。

### M1：独立阶段 Run

交付：

- Contracts 支持单阶段、可选上下文和环境策略；
- API 可以直接创建任意阶段 Run；
- `executePhase` 不再把非安全性的前置 Artifact 当作硬依赖；
- 项目页提供六阶段独立入口；
- 完整流程仍可运行，但使用普通 Run 编排。

完成条件：一个干净项目可以直接启动实现或测试；未执行需求、设计、架构不会被平台阻止。

### M2：统一 Result Receipt

交付：

- Run Result Receipt 数据模型与 API；
- 文件、Artifact、命令、测试、Git、MCP 和外部操作 sections；
- 统一结果页；
- 现有 Changeset/Patch 嵌入 Git section；
- 旧 Run 结果兼容投影。

完成条件：没有 Diff 的文档 Run、Figma Run 或测试 Run 也能清楚说明发生了什么。

### M3：MCP 能力与授权

交付：

- 通用 MCP capability catalog；
- 项目连接与权限页面；
- capability grants；
- read/write/execute/publish 分层；
- external effect receipt 和幂等执行；
- Git、Work Item、Figma 迁移到统一展示。

完成条件：Run 能按需读取外部上下文；任何外部写操作都能在执行前确认并在结果中追踪。

### M4：Repo Environment Blueprint

交付：

- `.ai-sdlc/environment.yaml` schema；
- Repo 检测与建议生成；
- 管理员批准 runtime + Repo 声明配置编译；
- Blueprint 编辑、验证和版本固定；
- Environment Session API 和基础 UI；
- workspace、cache、resource、network、secret policy。

完成条件：每个 Repo 可以声明安装、启动、健康检查和测试动作，且不能借蓝图提升宿主机权限。

### M5：服务托管、预览与测试

交付：

- managed service supervisor；
- service dependency 和 health/readiness；
- 日志、重启和停止；
- 受控 preview proxy；
- Browser/Playwright 连接；
- named action runner；
- unit/integration/e2e/build 结构化结果和附件。

完成条件：AI 能启动前端项目、等待就绪、打开页面、修改代码、观察热更新、运行 E2E 并提交完整执行回执。

### M6：完整流程编排与体验收敛

交付：

- 完整流程选择阶段、暂停、跳过、插入、重跑和结束；
- 实现到测试复用 Environment Session；
- 推荐上下文和下一步；
- 快速修改路径；
- 项目首页、Run 创建页和结果页信息层级收敛。

完成条件：新功能可以走完整流程，小 Bug 可以两步完成，两个路径共享相同 Run、环境和结果模型。

### M7：兼容迁移与运行加固

交付：

- legacy Run 和已初始化项目 backfill；
- 并发 Writer 隔离；
- API 重启和 Session 恢复；
- Secret/日志脱敏；
- 资源与附件限制；
- 审计、指标、故障恢复和清理；
- 用户指南和管理员运行手册。

完成条件：旧数据可读、新流程可用、失败不伪造、重试不重复外部副作用、清理环境不丢项目产物。

## 20. 验收场景

### AC-FLOW

- `FLOW-01`：用户可以直接启动任意阶段 Run。
- `FLOW-02`：未选择上游 Artifact 不阻止 Run；上下文不足由角色明确询问或 Blocked。
- `FLOW-03`：完整流程可以选择、跳过、插入和重跑阶段。
- `FLOW-04`：小 Bug 可以按“实现 → 测试”完成。
- `FLOW-05`：旧固定流程 Run 继续按原语义查看和推进。

### AC-RESULT

- `RESULT-01`：所有 Run 都有统一执行回执。
- `RESULT-02`：回执能区分项目文件、Artifact、环境、测试、Git 和外部副作用。
- `RESULT-03`：Diff 不可用或不适用时仍能完整审阅结果。
- `RESULT-04`：产物正文仍存在目标项目目录并可被后续 Run 选择。

### AC-MCP

- `MCP-01`：项目可以连接并激活多类 MCP。
- `MCP-02`：阶段推荐 MCP，但不强制绑定厂商。
- `MCP-03`：读取、项目写入、外部写入和发布权限分层。
- `MCP-04`：外部写操作有授权、幂等键、稳定资源 ID 和结果回执。
- `MCP-05`：MCP 返回不能扩大权限或泄露 Secret。

### AC-ENV

- `ENV-01`：Repo 可以版本化保存 Environment Blueprint。
- `ENV-02`：平台可以从常见前端 Repo 生成蓝图建议。
- `ENV-03`：AI 可以创建或复用 Environment Session。
- `ENV-04`：开发服务跨多个 AI 回合持续运行。
- `ENV-05`：平台在健康检查通过后提供受控前端预览。
- `ENV-06`：AI 可以读取日志、重启服务和执行 named action。
- `ENV-07`：AI 可以运行可追踪的单元、集成和 E2E 测试。
- `ENV-08`：测试截图、Trace、视频、日志和结构化结果进入回执。
- `ENV-09`：清理 Session 不删除目标项目文件和产物。
- `ENV-10`：Repo 蓝图不能请求宿主机任意挂载、privileged 或 Docker Socket。

### AC-GIT

- `GIT-01`：Git 状态和 Diff 是可选结果能力。
- `GIT-02`：Run 完成不强制 Commit。
- `GIT-03`：Commit 可以选择文件范围并编辑 message。
- `GIT-04`：Push、PR、Merge、Tag 和 Release 使用独立授权。
- `GIT-05`：系统不能把 Run 前已有修改当成本次 Run 变更安全撤销。

## 21. 端到端示范验收

以一个 Vite/React 前端 Repo 为例：

1. 用户绑定 Repo，平台检测 package manager、dev script 和 Playwright 配置。
2. 平台生成 Environment Blueprint 建议，用户确认后写入 Repo。
3. 用户直接选择“实现”，输入“修复移动端登录按钮遮挡”。
4. AI 创建 development Environment Session，安装依赖并托管 `web` 服务。
5. 健康检查通过，平台显示预览入口。
6. AI 使用 Browser/Playwright 打开登录页，复现问题并读取 console/network。
7. AI 修改目标项目中的样式和测试文件，热更新后重新检查。
8. AI 执行 typecheck、unit 和 E2E named actions。
9. Result Receipt 展示修改路径、页面截图、测试结果、服务日志摘要和 Git 状态。
10. 用户可以保持未提交、继续修改、创建 Commit、进入测试阶段或直接结束。

该场景通过，代表“阶段独立运行、产物跟随项目、环境蓝图、AI 服务控制、浏览器测试和统一回执”已经形成完整闭环。

## 22. 明确不在本计划中冒充完成的能力

- 不提供互不信任租户之间的完整多租户隔离承诺。
- 不允许 Repo 提交任意宿主机 Docker 配置或 privileged 环境。
- 不自动授予生产数据库写入、Merge 或正式发布权限。
- 不承诺所有外部 MCP 操作都可以自动撤销。
- 不提供多个 Repo 的原子写入和原子提交。
- 不把浏览器探索结果冒充为可复现 E2E 证据。
- 不自动把旧 Run 改写成新执行模型。

## 23. 推荐执行顺序

```text
M0 架构合同
  → M1 独立阶段 Run
  → M2 Result Receipt
  → M3 MCP 能力与授权
  → M4 Repo Environment Blueprint
  → M5 服务托管、预览与自动化测试
  → M6 完整流程与体验收敛
  → M7 兼容迁移与运行加固
```

M1 与 M2 先把用户流程变简单；M3 建立统一外部能力；M4 与 M5 完成高级 Sandbox 和 AI 运行闭环；M6 最后用已经稳定的基础对象编排完整流程，避免再次建立一套只服务于线性流程的实现。

## 24. 最终完成定义

本计划完成时，用户应当能够：

- 清楚看到六阶段，但不被阶段顺序束缚；
- 从任意阶段开始一次独立工作；
- 按需选择项目产物和外部 MCP 上下文；
- 让所有产物继续保存在目标项目；
- 为每个 Repo 配置怎样准备、启动和测试项目；
- 让 AI 持续管理前端、后端、数据库和测试浏览器；
- 在实现后直接看到运行结果、页面状态和自动化测试证据；
- 根据需要查看 Diff、Commit、Push 或创建 PR，而不是被迫执行；
- 在任何外部写入或发布动作发生前掌握权限；
- 从统一执行回执中理解这次 Run 对项目、环境、Git 和外部系统做了什么。

最终产品定义：

> 这是一个项目驱动的 AI SDLC 工作台。每个 Repo 使用环境蓝图描述如何创建 Sandbox、启动服务和运行测试；AI 可以从任意 SDLC 阶段开始，按需使用项目产物和 MCP，在受控环境中修改项目、操作浏览器、执行自动化测试并完成交付动作；所有产物继续保存在目标项目中，平台通过统一执行回执展示项目文件、运行环境、测试、Git 和外部系统发生的变化。
