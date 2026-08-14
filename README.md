# create-ai-native-sdlc

一个很薄的交互式初始化器：把一套通用 AI Agent、工作流和 Markdown 模板复制到目标项目。

它不区分客户端品牌，不生成格式适配器，也不会为同一个角色复制多份 Agent。

## 使用方式

包发布到 npm 后运行：

```bash
npx create-ai-native-sdlc@latest init .
```

CLI 只询问：

```text
项目名称（默认 my-project）：
项目简介：
原始 Agent 初始化目录（默认 .ai-sdlc/agents）：
Designer 额外输入 Markdown（项目相对路径，多个用逗号分隔，可留空）：
Designer 组件清单模块（项目相对 .mjs 路径，可留空）：
```

项目名称、简介和目录不通过命令参数传递。

这个包目前还没有发布到 npm。首次发布前，可以从 Git 仓库运行：

```bash
npx --yes --package=github:davych/my-sdlc-workflow \
  create-ai-native-sdlc init .
```

## 只有一套 Agent

六个角色的原始文件在 [`templates/agents`](templates/agents)，每个角色只有一个 Markdown：

- PM / BA
- Designer
- Architect
- Software Engineer
- Tester
- DevOps

初始化时，这六个文件只会复制到你输入的一个目录。回车使用默认目录：

```text
.ai-sdlc/
  agents/       # 六个原始 Agent，每个角色一份 Markdown
  roles/        # 角色自己的配置、规则、引用和脚本
  guides/       # 人类使用指南
  workflows/    # 工作流
  templates/    # AI 产物模板
  tasks/        # 任务区
```

如果你的工具从其他目录读取 Agent，在初始化问题中填写那个项目相对目录即可。初始化器只处理目录，不识别客户端名称，也不额外生成 TOML、专属后缀或第二份 Agent。

## YAML 与产物

`ai-native.yaml` 永远会初始化，并记录：

```yaml
paths:
  agents: ".ai-sdlc/agents"
  outputs: docs
```

AI 产物默认写到目标项目的 `docs/`。修改 `paths.outputs` 可以整体调整产物根目录。

Designer 的配置位于 `.ai-sdlc/roles/designer/config.yaml`：

- `resources` 和 `inputs.markdown` 决定读取哪些 Markdown。
- `inputs.artifacts` 从 `ai-native.yaml` 解析上游产物。
- `output.subdirectory` 只能决定 Designer 子目录。
- 输出根始终来自 `ai-native.yaml`，artifact 文件名也登记在全局 YAML。
- `component-query.mjs` 可以接入初始化时填写的项目组件清单模块，也可以初始化后直接补充。

默认 Designer 输出目录为 `docs/ai-native/design/`。组件查询和 SPEC 校验不绑定任何具体 UI 库或前端框架。

Designer 的完整使用说明会初始化到 `.ai-sdlc/guides/designer.md`，其中分别说明 GitHub Copilot、Claude Code 和 Codex 如何读取同一份 Designer Agent。Figma 工作流位于 `.ai-sdlc/roles/designer/references/figma-workflow.md`；它保留组件实例、auto-layout、变量和截图验证流程，但不绑定特定 UI 库或固定工具名称。

如果目标项目已经存在 `ai-native.yaml` 或将要写入的同名文件，CLI 会停止，不覆盖已有文件。

## CLI

```text
create-ai-native-sdlc init [target]
create-ai-native-sdlc --help
```

## CI 与 npm 发布

CI 只运行基础初始化测试和 npm 打包检查。

发布流程位于 [`.github/workflows/publish.yml`](.github/workflows/publish.yml)。后续配置 `NPM_TOKEN`，更新版本并推送 `v*` tag，或手动运行发布 workflow，即可执行 npm 发布。

发布成功前，不应宣称 `npx create-ai-native-sdlc@latest` 已经可用。

## 本地验证

```bash
npm test
npm pack --dry-run
```

## License

MIT
