# create-ai-native-sdlc

一个以 YAML 为唯一事实源的 AI-native SDLC 脚手架。它把 one-person company 的产品、设计、架构、开发、测试和交付流程初始化到任意项目，并为 GitHub Copilot、Claude Code 和 OpenAI Codex 生成各自原生的项目配置。

## 快速开始

在空目录或已有项目根目录执行：

```bash
npx create-ai-native-sdlc@latest init . \
  --name "My Product" \
  --summary "一句话说明产品解决的问题"
```

初始化后，先编辑根目录的 `ai-native.yaml`，再同步：

```bash
npx create-ai-native-sdlc@latest sync .
npx create-ai-native-sdlc@latest check .
```

`ai-native.yaml` 是项目名称、角色、阶段、gate、baseline 和业务产物路径的唯一配置源。三家 AI 工具的文件都由它派生，不需要维护三套角色说明。`@latest` 命令需要先将本包发布到 npm；发布前可按文末的 tarball 方式本地使用。

## 默认生成内容

```text
target-project/
├── ai-native.yaml
├── AGENTS.md
├── CLAUDE.md
├── .gitignore
├── .gitattributes
├── .ai-sdlc/
│   ├── manifest.json
│   ├── baseline/
│   │   ├── project-charter.md
│   │   ├── workflow.md
│   │   ├── definition-of-done.md
│   │   └── role-registry.md
│   └── roles/
│       ├── pm-ba.md
│       ├── designer.md
│       ├── architect.md
│       ├── software-engineer.md
│       ├── tester.md
│       └── devops.md
├── .github/
│   ├── copilot-instructions.md
│   └── agents/*.agent.md
├── .claude/
│   ├── agents/*.md
│   └── skills/*/SKILL.md
├── .codex/
│   └── agents/*.toml
├── .agents/
│   └── skills/*/SKILL.md
└── docs/ai-sdlc/
    ├── product/{product-brief,requirements}.md
    ├── design/design-spec.md
    ├── architecture/architecture.md
    ├── engineering/implementation-plan.md
    ├── testing/test-plan.md
    └── operations/release-runbook.md
```

六个默认角色是：

| Role ID | 职责 |
| --- | --- |
| `pm-ba` | 产品方向、业务分析、需求和验收标准 |
| `designer` | 用户旅程、交互、视觉约束和无障碍 |
| `architect` | 技术边界、接口、质量属性和架构决策 |
| `software-engineer` | 实现、自动化测试和变更证据 |
| `tester` | 风险分析、验证、回归和质量结论 |
| `devops` | CI/CD、可观察性、发布和回滚 |

## 配置模型

默认配置包含以下顶层字段：

```yaml
schemaVersion: 1
templateSet: core/v1
project: {}
paths: {}
integrations:
  githubCopilot: true
  claudeCode: true
  codex: true
roles: []
workflow:
  phases: []
  definitionOfDone: []
baselines: []
artifacts: []
generation:
  maxParallelAgents: 6
```

配置使用严格 JSON Schema 校验：未知字段、重复 YAML key、重复 ID、未知角色/产物、不安全路径、绝对路径和 `..` 路径穿越都会在任何写入前失败。当前版本只接受显式的 `templateSet: core/v1`；未来的不兼容配置需要新的 template-set 版本。

## 文件所有权与安全更新

生成器区分三种文件：

| 模式 | 例子 | 同步行为 |
| --- | --- | --- |
| `managed` | baseline、角色、agent、skill | 内容仍等于 manifest 哈希时才自动更新；人工修改会报冲突 |
| `seed` | requirements、test plan 等业务产物 | 只创建一次，以后始终保留用户内容 |
| `block` | `AGENTS.md`、`CLAUDE.md`、Copilot instructions、`.gitignore`、`.gitattributes` | 只维护成对标记之间的区块，区块外内容原样保留 |

默认冲突策略是失败并且零部分写入。确认要恢复 generated 内容时可使用：

```bash
npx create-ai-native-sdlc sync . --force
```

被强制覆盖的文件会先备份到 `.ai-sdlc/backups/<run-id>/`。当配置禁用 provider 或角色后，生成器先把旧文件报告为 `stale`；显式清理未被人工修改的 generated 内容：

```bash
npx create-ai-native-sdlc sync . --prune
```

seed 文件永远不会自动删除。需要删除时请人工确认，删除后再运行 `sync --prune` 清理 manifest 记录。禁用角色时，要同时移除或改派它的 deliverables 和 phase；对应 seed 仍按这一规则保留。

`.ai-sdlc/manifest.json` 是生成器的所有权账本，并非加密签名。请将它与代码一起审查、不要手工修改，也不要对不可信仓库盲目执行 `--prune`。整文件删除和强制覆盖都会先写入权限不宽于原文件的备份；回滚也只会恢复仍等于本次落盘状态的文件，不会覆盖并发用户修改。

输出路径可动态修改，但同一次同步不会把一个文件直接改成它自己的目录（或反向操作）。这种路径形状迁移请先改到临时同级路径并执行 `sync --prune`；若是目录改文件，还要确认无用户文件并手动删除空目录；最后再改到目标路径。

## CLI

```text
create-ai-native-sdlc init [target] [options]
create-ai-native-sdlc sync [target] [options]
create-ai-native-sdlc check [target] [options]
```

- `init`：创建配置和完整 boilerplate；已有配置时拒绝重复初始化。
- `sync`：按配置计算完整 desired tree，预检全部冲突后再写入。
- `check`：严格只读地检查配置、漂移、冲突和 stale 产物。
- `--dry-run`：显示 `init` 或 `sync` 计划，文件系统保持不变。
- `--force`：备份后覆盖冲突的 generated 内容，不覆盖 seed。
- `--prune`：清理不再由配置声明且可证明由生成器拥有的内容。
- `--json`：输出适合 CI 的机器可读结果。
- `--config <path>`：使用自定义的项目内 YAML 相对路径。

在项目子目录运行 `sync` 或 `check` 时，CLI 会向上查找最近的配置文件。

退出码：`0` 表示成功或一致，`1` 表示配置错误或 `check` 发现漂移，`2` 表示文件冲突。

## 三家工具的适配原则

- GitHub Copilot：仓库指令使用 `.github/copilot-instructions.md`，角色使用 `.github/agents/*.agent.md`。
- Claude Code：根 `CLAUDE.md` 导入公共 `AGENTS.md`，角色使用 `.claude/agents/*.md`，阶段技能使用 `.claude/skills`。
- OpenAI Codex：公共指令使用 `AGENTS.md`，角色使用 `.codex/agents/*.toml`，共享阶段技能使用 `.agents/skills`。

这些路径遵循各工具当前官方约定：[GitHub Copilot custom agents](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/create-custom-agents)、[Claude Code subagents](https://code.claude.com/docs/en/sub-agents)、[Claude Code memory](https://code.claude.com/docs/en/memory)、[Codex AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)、[Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)。

## 本地开发与发布验收

```bash
npm install
npm run check
npm test
npm run test:pack
```

`test:pack` 会先执行 `npm pack`，再从仓库外安装真实 tarball，并通过 `npx --no-install create-ai-native-sdlc` 完成初始化、同步与检查。

发布前可以检查包内容：

```bash
npm pack --dry-run
npm publish
```

发布前本地试用：

```bash
npm pack
mkdir /tmp/my-ai-native-project
cd /tmp/my-ai-native-project
npm exec --yes --package=/absolute/path/create-ai-native-sdlc-0.1.0.tgz -- \
  create-ai-native-sdlc init .
```

## License

MIT
