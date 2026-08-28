# AI SDLC Cloud Platform

这是一个可自托管的 Chat-first Cloud SDLC Agent。用户在浏览器里绑定远程 Git HTTPS 仓库并选择授权，随后直接进入一个持久对话；用户用白话或 `@repo` 下任务，Agent 自己选择项目已激活的 MCP、懒启动 Session Sandbox，并按固定六角色组织执行、产物和人工审核。远程仓库不需要 `CLAUDE.md`、`AGENTS.md`、`.codex` 或 `ai-native.yaml`，平台会在仓库之外准备自己的 Control Pack。

它不是 Devin 的复刻，也不是通用聊天壳。当前 MVP 的重点是：一个轻量对话入口、一条固定且可解释的六角色 SDLC、可审计的上下游产物、可按消息切换的 Provider、受控远程 Sandbox 和人工可下载的 Patch。它不会自动 push、创建 PR、合并、部署或发布。

> **真实边界：**这是单租户自托管 MVP，不是生产多租户 SaaS。API 有一个部署级 Bearer Token，但没有用户、组织、RBAC、计费或租户隔离。远程真实阶段只在受限 Docker Worker 中运行；可信 API 仍持有 Git Broker 凭据、数据库权限和 Docker socket。部署前请阅读[安全模型](docs/security-model.md)。

产品侧的完整主路径、六角色交接和返工规则见[业务流程 README 与思维导图](docs/business-flow/README.md)；服务边界、状态模型、运行时和信任边界见[项目技术设计与架构图](docs/technical-design/README.md)。

## 默认使用方式

1. 输入远端 HTTPS Git URL，私有仓库再选择管理员配置的 Credential Profile。
2. 仓库 ready 后系统直接打开 Agent Session；名称、`@alias` 和源码 revision 都由服务端确定。
3. 在同一页按需选择默认 Provider、固定 Sandbox Blueprint、激活 MCP，或手工生成 LLM DeepWiki。
4. 发一条消息，例如“`@backend 处理 Linear ENG-123，修好并跑测试`”。
5. Agent 建立同一 Session 的 Sandbox 与 Run，从 PM/BA 开始固定串联六角色。
6. 每个角色完成后，在对话里展开全部当前产物；“批准并继续”会进入下一角色，“要求修改”会留在本阶段。
7. 最后查看 Diff、测试、风险和 Patch；完整 Run 页面只作为高级审计入口。

## Prerequisites

- Node.js 20 or newer with Corepack;
- Docker; Compose v2 is used when available, with a Docker CLI fallback;
- 一个 Docker Host；远程真实阶段使用固定 Worker 镜像中的 Codex CLI。

## 启动 Cloud MVP

从 `platform/` 开始：

```bash
cp .env.cloud.example .env.cloud
# 分别运行两次，生成数据库密码和访问 Token；把两段不同的输出粘贴进 .env.cloud
openssl rand -hex 32
openssl rand -hex 32
# 再填写精确 Origin、专用绝对 Workspace 路径和 Docker socket group id
mkdir -p /你在_AI_SDLC_HOST_WORKSPACE_ROOT_里填写的绝对路径
# Compose 中 API/Worker 默认使用 10001:10001；让这个专用目录归它所有
sudo chown 10001:10001 /你在_AI_SDLC_HOST_WORKSPACE_ROOT_里填写的绝对路径
docker compose --env-file .env.cloud -f docker-compose.cloud.yml \
  --profile worker-image build
# 可选但推荐：在正式启动前跑一次真实隔离边界验收（Tier D）
AI_SDLC_WORKER_IMAGE=ai-sdlc-worker:local yarn test:docker-smoke
docker compose --env-file .env.cloud -f docker-compose.cloud.yml up -d postgres api web
```

本机浏览器打开 `http://localhost:8080`，输入 `.env.cloud` 中的 `AI_SDLC_ACCESS_TOKEN`。Compose 默认把 Web 端口只绑定到 `127.0.0.1`，这正是推荐的本机使用方式。

远程访问时不要把 8080 的明文 HTTP 直接暴露出去。保留 `AI_SDLC_WEB_BIND_HOST=127.0.0.1`，在同一台主机上用 Caddy、Nginx 或云负载均衡终止 TLS，再把**精确的 HTTPS Origin** 写入 `AI_SDLC_ALLOWED_ORIGINS`。例如：

```caddyfile
sdlc.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

```dotenv
AI_SDLC_WEB_BIND_HOST=127.0.0.1
AI_SDLC_ALLOWED_ORIGINS=https://sdlc.example.com
```

Bearer Token 只有在 HTTPS 内传输才不会被同网段窃听；不要使用 `http://sdlc.example.com`。API 会拒绝把非 loopback 的明文 HTTP Origin 当成远程 Cloud 配置。Web 与 API 默认走同源反向代理，不需要浏览器填写 API 地址。

`AI_SDLC_HOST_WORKSPACE_ROOT` 必须是 Docker Host 上已经存在的专用绝对目录。可信 API 会把它以相同绝对路径挂载，以便 Host Docker daemon 能把具体 Run Workspace 只挂给 Worker。不要填 home、现有源码仓库或共享业务目录。请把 Managed Root 放在独立、带操作系统或存储层**硬容量配额**的 filesystem / volume：Git 的 byte 限制在 materialization 完成后才验收，Worker 也可以持续写它的 repo mount，应用层限制不能阻止瞬时磁盘占用或恶意写满空间。

Linux 还要把 `AI_SDLC_DOCKER_GID` 设为 `/var/run/docker.sock` 的 group id。API 与 Worker 的 uid:gid 必须一致。启动时 API 会实际创建、读回并删除一个 Workspace sentinel，再读取 Docker Server Version 和带 `com.ai-sdlc.worker=true` 标签的 Worker 镜像；任一步失败都不会对外监听。`AI_SDLC_CLOUD_SKIP_DOCKER_PREFLIGHT=1` 只允许与 `AI_SDLC_CODEX_FAKE=1` 一起用于测试或本地演示，真实远程 Run 不能绕过这道检查。

`.env.cloud.example` 故意把密码、Token、Workspace Root 和 Docker GID 留空；Compose 用 `${VAR:?}` 在启动前拒绝空值。不要把示例文本当成 Secret，Access Token 也会主动拒绝仓库曾使用过的占位字符串。

### 本地开发

From `platform/`:

```bash
corepack enable
[ -e .env ] || cp .env.example .env
yarn install
yarn db:up
yarn dev
```

`.env.example` 同时包含 Cloud 和 legacy local 开发变量。Cloud Web 只显示远程仓库入口；旧本地 Project 数据与显式 API 仍保留兼容。

The Web app is served at <http://localhost:5174> and the API at <http://localhost:4100>. PostgreSQL uses host port `54329` by default. `yarn db:up` waits for the database health check.

Useful commands:

```bash
yarn typecheck
yarn test
yarn build
yarn db:logs
yarn db:down
```

`yarn db:down` stops PostgreSQL but keeps its named volume. Remove the volume only when local data loss is intended.

## 关键 Cloud 配置

| Variable | Purpose |
|---|---|
| `AI_SDLC_ACCESS_TOKEN` | 部署级访问令牌；非 loopback 监听时必填，至少 24 个无空白字符 |
| `AI_SDLC_ALLOWED_ORIGINS` | 允许访问 API 的精确浏览器 Origin，不能写通配符 |
| `AI_SDLC_WEB_BIND_HOST` | Compose Web 发布地址；默认 `127.0.0.1`，远程访问仍应保持 loopback 并在前面终止 TLS |
| `AI_SDLC_MANAGED_WORKSPACE_ROOT` | API 看到的受管 Workspace 根；Compose 会从 Host 绝对路径注入 |
| `AI_SDLC_GIT_ALLOWED_ORIGINS` | 可导入仓库的精确 HTTPS Origin 列表 |
| `AI_SDLC_GIT_CREDENTIAL_PROFILES` | 私有仓库 Profile 元数据；Secret 只通过 Profile 的 `secretEnv` 变量提供 |
| `AI_SDLC_WORKER_IMAGE` | 管理员构建并批准的固定远程阶段镜像；不配置时 real remote Run fail closed |
| `AI_SDLC_SANDBOX_BLUEPRINTS` | 可选的名称/版本/说明目录；每项都由服务端绑定到启动时验证通过的同一个 Worker 镜像，不能携带镜像或命令 |
| `AI_SDLC_REAL_EXECUTION_TRUSTED_REPOSITORIES` | 允许真实阶段执行的精确仓库 URL，逗号分隔；空值表示全部拒绝，导入/Ask/Fake 不受影响 |
| `AI_SDLC_MAX_CONCURRENT_PHASES` | 单个 API 进程的真实阶段并发上限，默认 `1`；超出时返回 429，不排队 |
| `AI_SDLC_MCP_BIN_ROOT` | Host 上的 MCP Adapter 可执行文件目录；Compose 只读挂载到 API 的 `/opt/ai-sdlc/mcp-bin` |
| `AI_SDLC_CLOUD_SKIP_DOCKER_PREFLIGHT` | 仅 Fake/test 可设为 `1`；真实 Cloud 固定为 `0` |
| `AI_SDLC_ALLOWED_PROJECT_ROOTS` | 仅 legacy-local API 使用的本地父目录 allowlist；Cloud 项目只能进入 Managed Root |
| `AI_SDLC_CODEX_BIN` | Codex executable used for real jobs; defaults to `codex` |
| `AI_SDLC_CODEX_TIMEOUT_MS` | Real-execution timeout; defaults to 30 minutes |
| `AI_SDLC_CODEX_FAKE` | `0` for real execution; `1` only for tests or deterministic demos |
| `AI_SDLC_CLI_PATH` | Optional absolute override for this repository's `bin/cli.js` |
| `DATABASE_URL` | PostgreSQL connection used by the API |
| `HOST` / `PORT` | API bind address and port |
| `VITE_API_URL` | API URL used by the Web app |

## 手工、Jira 与 Linear 工作项

它们都从同一个聊天框进入。用户可以直接描述任务，也可以说“`@backend 处理 Linear ENG-123`”。如果当前 Provider 支持原生 tool calling，Agent 只会从这个项目已经激活的 MCP 中选择工具；读取结果与用户文字一起整理为 Change Contract，再启动固定六角色 Run，不要求用户先选择来源或填写长表单。

MVP 提供的是通用、服务端 stdio MCP Adapter，不内置 Jira 或 Linear 的账号/OAuth 页面。管理员先安装厂商 MCP Server，或用固定版本的 stdio bridge 连接远程 MCP；项目设置里只做激活。浏览器只看见 Adapter 的安全摘要，不会提交 command、args、tool、固定参数、字段映射或 Secret。当前开放的是只读 Work Item 工具；未知、未激活、多重或参数不合法的调用全部拒绝。

```dotenv
AI_SDLC_WORK_ITEM_MCP_ADAPTERS=[{"id":"linear-readonly","label":"Linear（只读）","command":"/opt/ai-sdlc/mcp-bin/linear-mcp","args":[],"toolName":"get_issue","referenceArgument":"issueId","fixedArguments":{},"secretEnv":{"LINEAR_API_TOKEN":"AI_SDLC_LINEAR_API_TOKEN"},"mapping":{"title":"issue.title","description":"issue.description","externalId":"issue.identifier","url":"issue.url","acceptanceCriteria":"issue.acceptanceCriteria","labels":"issue.labels"},"defaultWorkType":"feature"}]
AI_SDLC_LINEAR_API_TOKEN=replace-me
AI_SDLC_WORK_ITEM_MCP_TIMEOUT_MS=20000
AI_SDLC_WORK_ITEM_MCP_MAX_OUTPUT_BYTES=2097152
AI_SDLC_WORK_ITEM_MCP_MAX_CONCURRENT=4
```

`command` 必须是 API 运行环境里的绝对可执行路径；Compose 默认镜像不会偷偷下载或执行 `npx` 最新版。先把固定版本的 Adapter 安装进一个专用 Host 目录，再通过 `AI_SDLC_MCP_BIN_ROOT` 只读挂载：

```bash
mkdir -p mcp-bin
install -m 0755 /你审核并固定版本的/linear-mcp mcp-bin/linear-mcp
```

Compose 内的配置统一写 `/opt/ai-sdlc/mcp-bin/linear-mcp`，不要写 Host 绝对路径。`mcp-bin/` 默认不进入 Git；二进制来源、版本和校验值由运维者自己记录。Adapter 必须完成 MCP `initialize`，随后接受固定的 `tools/call`，并返回 `structuredContent` 或包含 JSON 的 text content。字段路径由 `mapping` 明确配置，平台不会让 LLM 猜厂商响应。超时、输出和并发都有硬限制；请求结束时 API 会等待子进程退出，必要时强制结束，再释放并发名额。stderr、底层路径和 Secret 不返回浏览器。

Linear 官方远程 MCP 地址及只读方式见 [Linear MCP 文档](https://linear.app/docs/mcp)；Jira 可通过 [Atlassian Rovo MCP 的 Jira 工具](https://support.atlassian.com/atlassian-rovo-mcp-server/docs/supported-tools/)接入。两者的 OAuth、Cloud ID、工具名和返回字段可能变化，属于管理员 Adapter 配置，不应写死在浏览器。列表中的“已配置”不代表远端已经联网；真正读取工作项时仍会按协议调用并清楚报告失败。

## 配置对话与 DeepWiki Provider

OpenAI、LM Studio、Ollama 和 Custom 共用一套服务端 Provider Registry。它们负责 Agent Session 里的聊天、任务规划、只读 MCP 选择和手工 DeepWiki；输入框可为下一条消息切换 Provider，历史不会清空，并会记录实际 Provider 与模型。仓库检索只发送有界片段并校验引用；Secret、忽略文件、常见敏感文件、生成目录、二进制、符号链接和超大文件会被排除。

生产六阶段的文件修改与命令执行目前仍由受限 Docker Worker 内的 Codex Runtime 完成。普通对话 Provider 只有在明确声明并真实支持原生 tool calling 时，才可以启动工作回合；平台不会解析一段普通模型文本来伪造工具调用，也不会把“能聊天”说成“能安全改代码”。

Provider configuration lives only in the API process environment. A browser request can select a configured Provider, but it cannot provide or override an endpoint, API key, protocol, system prompt, or repository path. Restart the API after changing these values.

### OpenAI

```dotenv
AI_SDLC_ASK_OPENAI_MODEL=gpt-5.6-terra
AI_SDLC_ASK_OPENAI_API_KEY=replace-me
# AI_SDLC_ASK_OPENAI_BASE_URL=https://api.openai.com/v1
```

OpenAI uses the Responses protocol. Source excerpts selected for the question leave the local machine and are sent to the configured endpoint.

### LM Studio

Start the LM Studio server, load a model, and copy its exact model identifier:

```dotenv
AI_SDLC_ASK_LM_STUDIO_MODEL=openai/gpt-oss-20b
AI_SDLC_ASK_LM_STUDIO_BASE_URL=http://127.0.0.1:1234/v1
# Compose 部署改用 http://host.docker.internal:1234/v1，并显式开启：
# AI_SDLC_ASK_LM_STUDIO_ALLOW_INSECURE_HTTP=1
# Set only when LM Studio API authentication is enabled.
# AI_SDLC_ASK_LM_STUDIO_API_KEY=replace-me
# Set to 1 only after verifying the loaded model returns native tool calls.
# AI_SDLC_ASK_LM_STUDIO_TOOL_CALLING=0
```

LM Studio uses its OpenAI-compatible Responses endpoint. The default address is loopback-only; plain HTTP is rejected for non-loopback hosts.

在 Compose 里，`127.0.0.1` 是 API 容器自己，不是 Docker Host。Compose 已把 `host.docker.internal` 映射到 Host gateway；只有你明确控制该 Host 服务时，才同时使用这个主机名和 Provider 自己的 `*_ALLOW_INSECURE_HTTP=1`。这个开关只放宽该 Provider 的传输检查，不会改变 Git 仓库网络策略。

### Ollama

Start Ollama and make sure the configured model is already present:

```dotenv
AI_SDLC_ASK_OLLAMA_MODEL=qwen3-coder:latest
AI_SDLC_ASK_OLLAMA_BASE_URL=http://127.0.0.1:11434
# Compose 部署改用 http://host.docker.internal:11434，并显式开启：
# AI_SDLC_ASK_OLLAMA_ALLOW_INSECURE_HTTP=1
# Set only when the configured Ollama-compatible service requires Bearer auth.
# AI_SDLC_ASK_OLLAMA_API_KEY=replace-me
# Set to 1 only for a model that supports Ollama tool calling.
# AI_SDLC_ASK_OLLAMA_TOOL_CALLING=0
```

Ollama uses its native `/api/chat` protocol. The platform never pulls a missing model and never substitutes another model silently.

### Custom compatible endpoint

Custom Provider support is deliberately explicit. Choose one protocol implemented by the endpoint:

```dotenv
AI_SDLC_ASK_CUSTOM_LABEL=团队模型服务
AI_SDLC_ASK_CUSTOM_PROTOCOL=openai-chat
AI_SDLC_ASK_CUSTOM_MODEL=team-code-model
AI_SDLC_ASK_CUSTOM_BASE_URL=https://llm.example.com/v1
AI_SDLC_ASK_CUSTOM_API_KEY=replace-me
# Set to 1 only if an openai-chat endpoint supports response_format: json_schema.
AI_SDLC_ASK_CUSTOM_STRUCTURED_OUTPUT=0
# Set to 1 only if this exact endpoint and model return native function calls.
AI_SDLC_ASK_CUSTOM_TOOL_CALLING=0
```

`AI_SDLC_ASK_CUSTOM_PROTOCOL` accepts `openai-responses`, `openai-chat`, or `ollama-chat`. For the widest Chat-compatible support, `openai-chat` defaults to prompt-only JSON plus server validation; opt into native JSON Schema only when the endpoint documents it. This does not claim compatibility with arbitrary private request or response formats.

OpenAI Responses tool calling is enabled when OpenAI itself is configured. LM Studio, Ollama, and Custom require their `*_TOOL_CALLING=1` switch because support and output quality depend on the exact server version and selected model. The switch means “offer strict function definitions and parse native calls”; it cannot make an unsupported model learn tool use. A compatible endpoint may still reject `tools` at request time, and malformed or multiple calls are rejected before any MCP operation runs. Ollama supports automatic tool selection but does not document OpenAI's forced `tool_choice`, so the platform does not send that field to Ollama.

Shared bounds are configurable with `AI_SDLC_ASK_TIMEOUT_MS` and `AI_SDLC_ASK_MAX_RESPONSE_BYTES`. Any Provider can override them with `<PROVIDER_PREFIX>_TIMEOUT_MS` and `<PROVIDER_PREFIX>_MAX_RESPONSE_BYTES`, such as `AI_SDLC_ASK_OLLAMA_TIMEOUT_MS`. Open the Agent 工作台设置 to see the sanitized Provider state and run a connection check. The check distinguishes missing configuration, authentication failure, unreachable endpoints, missing models, and incompatible responses without returning credentials or raw upstream bodies.

Use the check result as the next-action guide:

| State | What it means | What to do |
|---|---|---|
| `ready` | The endpoint answered the required small JSON check and reported the actual model. | Ask a repository question. |
| `not_configured` | One or more required server variables are missing. | Read the Provider message, set the named variables in `.env`, and restart the API. |
| `authentication_failed` | The endpoint rejected its server-side credential. | Replace the relevant `*_API_KEY`; do not put the key in the browser. |
| `unreachable` | The endpoint timed out, refused the connection, returned a server error, or rate-limited the check. | Confirm the service is running, its port is reachable from the API process, and its request limit has recovered. |
| `model_unavailable` | The configured model is absent or not loaded. | Copy the endpoint's exact model ID into `*_MODEL` and load or provision it outside the Platform. Ask never pulls a model. |
| `protocol_error` | The URL or selected protocol does not match the response shape Ask requires. | Check the base path (`/v1` where applicable), custom protocol, structured-output flag, and endpoint documentation. |

Minimal repeatable verification after the API restarts:

```bash
curl -fsS -H "Authorization: Bearer $AI_SDLC_ACCESS_TOKEN" http://127.0.0.1:4100/api/ask/providers
curl -fsS -X POST -H "Authorization: Bearer $AI_SDLC_ACCESS_TOKEN" -H 'Content-Type: application/json' \
  -d '{}' http://127.0.0.1:4100/api/ask/providers/openai/check
```

Replace `openai` in the second command with `lmstudio`, `ollama`, or `custom`. The response must say `ready` before the Provider handles a project turn. The check performs one small model request but sends no repository excerpt. The equivalent Web action is **Agent 工作台 → 项目设置 → Provider → 重新检查**.

Cloud Agent Session 保存在 PostgreSQL，并固定主 Project 与 raw Git source revision。浏览器只提交新消息、客户端幂等 ID、预期 sequence 和可选的下一轮 Provider，不提交权威 history；服务端从数据库恢复受限上下文。项目同步后，旧 Session 继续使用旧 revision，不会静默切换源码。

一个 Session 只有主仓库可写。消息里明确提到的额外 `@repo` 会按服务端 alias 绑定成只读仓并固定自己的 exact revision；平台只把经过校验、受大小限制的语言、入口、文档、测试、构建和关键路径 Manifest 交给 Planner，并写进不可变 Change Contract，供六角色看到同一份参考。附加仓不会挂载给 Worker，不传整仓源码正文，也不能获得写权限。每轮最多引用 4 个附加仓；需要新增或替换 Run 的仓库上下文时，应新建 Agent Session。

`involve Architect`、`involve Tester` 之类的文字只是关注点：流程到该角色自己的阶段时重点处理。它不能跳过 PM/BA，也不能阻塞当前角色；六角色始终按 PM/BA → Designer → Architect → Software Engineer → Tester → DevOps 运行并保留产物。

一个 Session 的首个工作任务会建立持久 Sandbox，并让该 Session 的 Run 直接复用同一 Workspace。显式“继续当前 Run”会沿用它；另一项工作应创建新 Session，平台不会悄悄把两个 Run 混进一个可写 Sandbox。旧的独立 Ask Thread / Run API 仍作为兼容和高级入口保留。

The execution dialog obtains the project-scoped Codex model catalog and records the selected model and reasoning effort for each real phase run. Optional model allowlists and defaults are documented in the [runtime contract](docs/runtime-contract.md).

## Legacy local 兼容

旧数据和 `sourceKind: legacy-local` 请求仍可使用原有本地目录 Definition 与 Host runner，方便已有安装逐步迁移。Cloud Web 不再提供本地绝对路径、initialize 或 Agent Client 表单。Legacy real runner 没有远程 Docker Worker 的隔离保证，不能用于不可信仓库，也不应暴露成公共服务。

## Cloud Verification 的范围

Cloud Tester 只运行远程仓库里已经存在、且能在 Worker 中执行的测试命令或浏览器套件。它不会要求用户再绑定本地 E2E 目录，也不会在云端伪装成已经完成测试脚本创作、独立浏览器安装和完整证据晋升；缺少验收必需的浏览器证据时会明确 Blocked。

带第二个本地 Workspace、staging author、人工脚本哈希审核和独立 Playwright 执行的完整 Linked E2E 流程只属于 `legacy-local`。具体边界见 [runtime contract](docs/runtime-contract.md)。

## Fake and real jobs

Real execution is the default:

```dotenv
AI_SDLC_CODEX_FAKE=0
```

Use `AI_SDLC_CODEX_FAKE=1` for UI development, tests, and deterministic demonstrations. A fake execution proves only platform state handling; it is never evidence that a real Agent, test, or Release task succeeded.

真实阶段还要求两个显式条件：配置 `AI_SDLC_WORKER_IMAGE`，并把项目导入时保存的**完整、精确仓库 URL**列入 `AI_SDLC_REAL_EXECUTION_TRUSTED_REPOSITORIES`。Origin allowlist 只代表“允许拉取”，不是“允许执行”；执行信任列表为空时一律拒绝。建议 Worker 使用单独、低额度、可快速轮换的模型密钥。

`AI_SDLC_MAX_CONCURRENT_PHASES` 默认是 `1`，而且只是当前 API 进程内的上限。MVP 没有耐久队列、暂停/取消或多 API 实例协调；超出并发时直接返回 429。不要用多个 API 副本共享同一个 Managed Root。

`yarn test:docker-smoke` 是显式的 Tier-D 检查：它会真的启动配置的 Worker 镜像，验证 Worker 能读取只读 Control Pack、能写 Run Workspace、不能改 `.git` 或 Control，并且看不到 Docker socket。普通 CI 没有 Docker 时，该用例保持清楚的 Skip；发布环境应显式执行并通过。

Before running real jobs, review the [runtime contract](docs/runtime-contract.md) and [security model](docs/security-model.md). The runtime contract explains selected outputs, human revisions, Architecture checkpoints, E2E staging and promotion, Release readiness, and direct-IDE versus Web guarantees.

## Architecture at a glance

```text
Browser → Web/Nginx → Fastify API（Bearer + exact CORS）
                         ├─ PostgreSQL：Project / Agent Session / Run / Artifact / Review
                         ├─ Git Broker：短时使用 Credential Profile 拉取 HTTPS 仓库
                         ├─ Managed Root
                         │    ├─ Project Snapshot：Repository Manifest / Ask / DeepWiki
                         │    ├─ Session Sandbox：一个任务的持久 exact-revision Workspace
                         │    ├─ Run：直接复用该 Session Sandbox，六角色共享代码状态
                         │    └─ Control Pack：仓库外的固定六阶段 Prompt / Role / Template
                         └─ Docker Worker：每阶段短生命周期，只拿 Session repo、只读 .git、只读 Control 和最小模型凭据
```

API 是可信协调层，不是租户隔离边界。Worker 不拿 Git Token、数据库凭据、平台 Token 或 Docker socket。最终输出是可审核 Changeset / Patch；外部写入仍由人或另一个明确授权系统完成。

## DeepWiki、Prompt 与 Control Pack 的真实边界

绑定仓库时只建立不花模型额度的 Repository Manifest：它针对一个 exact revision 确定性记录文件/语言规模、常见入口、文档、测试/构建线索和关键路径摘要。LLM DeepWiki 在绑定后由用户手工选择 Provider 生成，并保存 revision、模型、引用和用量。源码更新后，旧 LLM DeepWiki 会标记为 stale；旧 Session 和旧 Run 仍固定旧版本。

这不是 DeepWiki 网站的完整复刻，也不是全仓向量搜索或可浏览语义图谱。它的目标是让 Agent 在不依赖仓库内 `CLAUDE.md` 的情况下，拿到可验证、版本固定的项目上下文。

用户无需维护 `CLAUDE.md` 或一根超长 Prompt。平台把角色边界、当前阶段流程、产物模板、Change Contract、DeepWiki 线索和已批准上游产物分层组装，按需给 Worker。这里的承诺是“由平台管理、可追踪、分层有边界”，不是“最终 Prompt 一定很短”：复杂 Run 的产物上下文字符预算最高约 180,000，超过预算会截断或拒绝，不能把它当作无限上下文。

Project 和 Run 会 pin 创建时的 Control Pack `definitionVersion`。平台升级模板不会静默改变旧 Run，也不会自动改写已导入 Project；要采用新版本，应重新导入/登记 Project 并创建新 Run，先在非关键项目验证。MVP 没有 Control Pack 原地升级或自动迁移按钮。

## 清理无引用 Workspace

平台不会自动删除成功 Run Workspace，因为它仍是产物、Changeset 和 Patch 的交付证据。日常清理只处理达到年龄阈值、处于非活动状态、且没有被 Project 当前快照、Ask Thread 或 Run 引用的残留 Workspace。先 dry-run，并在单 API 实例空闲、没有导入/创建 Run/阶段执行等维护并发时操作：

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $AI_SDLC_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"dryRun":true,"olderThanHours":24,"limit":100}' \
  http://127.0.0.1:8080/api/operator/workspaces/prune

curl -fsS -X POST \
  -H "Authorization: Bearer $AI_SDLC_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"dryRun":false,"olderThanHours":24,"limit":100}' \
  http://127.0.0.1:8080/api/operator/workspaces/prune
```

远程入口把 URL 改为 `https://sdlc.example.com/api/operator/workspaces/prune`；只有本地开发直连 API 时才使用 `http://127.0.0.1:4100`。`olderThanHours` 取 `0`～`8760`，`limit` 取 `1`～`500`；建议保留默认 `24` 小时和 `100` 条分批处理。确认 dry-run 的 `candidates` 后再正式执行，并检查 `removed`、`retained`、`failed` 与 `moreAvailable`。Ask/Run 引用会被再次检查并保留，但该接口不是多节点垃圾回收器，也不能替代 Managed Root 的容量监控和备份。

## Related documentation

- [Repository overview](../README.md)
- [Platform runtime contract](docs/runtime-contract.md)
- [Platform security model](docs/security-model.md)
- [End-to-End Workflow](../guidelines/workflow/README.md)
- [Configuration and artifact paths](../guidelines/configuration/README.md)
- [Role and Prompt layers](../guidelines/roles/README.md)

## Repository boundary

`platform/` is an independent Yarn 4 workspace with its own dependency graph and Docker service. Commands in this directory operate on platform workspaces. The repository-root initializer remains the canonical source for newly initialized AI-native projects.
