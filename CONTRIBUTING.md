# Contributing

感谢你愿意一起把 AI SDLC Cloud 做得更好。这个项目优先接受能让“远程仓库 → 工作项 → 六阶段 → 人工审核 → Patch”更可靠、更容易理解的改进。

## 开始之前

- Bug 请先给出复现步骤、预期结果、实际结果和已脱敏日志。
- 新能力请先说明用户问题、最小范围和不做什么。改变固定六阶段顺序、角色归属、安全边界或数据结构前，必须先开 Issue 讨论。
- 不要提交 Token、模型密钥、私有仓库内容、真实 Jira/Linear 数据或本机绝对路径。
- 保持产物和界面文案是简单白话；必要术语第一次出现时解释清楚。

## 本地开发

需要 Node.js 20 或更高版本，并启用 Corepack。

```bash
npm ci
npm test

cd platform
corepack enable
yarn install --immutable
cp .env.example .env
yarn db:up
yarn dev
```

Cloud Compose、Provider、Git 白名单和 MCP Adapter 的配置见 [platform/README.md](platform/README.md)。

## 提交前检查

```bash
npm test
npm pack --dry-run

cd platform
yarn typecheck
yarn test
yarn build
```

如果修改 Docker Worker，请另外构建固定 Worker 镜像并执行 `yarn workspace @ai-sdlc/api test:docker-smoke`。没有 Docker 时，请在 PR 中明确写出未运行原因。

## 代码和内容约定

- canonical role 内容放在 `templates/agents/`；不要为某个客户端复制一套角色真相。
- role 程序放在 `templates/shared/.ai-sdlc/roles/<role>/`；`workflow.md` 只管顺序，`references/` 只管聚焦规则，artifact template 只管输出格式。
- Platform contract、API、Web 分别放在 `platform/packages/contracts`、`platform/apps/api`、`platform/apps/web`。
- 新增可在 Web 审核的产物时，要注册到 `templates/ai-native.yaml`，并通过 owner 解析路径。
- 保持已初始化项目向后兼容；使用明确的增量 backfill，不要整体重写用户内容。
- 维护本仓库时不要新建顶层 `changes/`、`sessions/`、`reviews/` 或冷热上下文档案。

## Pull Request

一个 PR 尽量只解决一个问题。请写清：

1. 用户会看到什么变化；
2. 关键取舍和安全边界；
3. 运行过哪些检查；
4. 哪些检查没有运行以及原因；
5. 是否需要配置、迁移或运维动作。

提交 PR 代表你同意贡献按本仓库的 MIT License 发布。
