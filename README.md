# create-ai-native-sdlc

一个很薄的 AI-native 项目初始化器：读取 `ai-native.yaml`，把 Markdown / TOML 模板复制到目标项目。

它只做 `init`，不做同步引擎、manifest、迁移或文件所有权管理。

## 现在如何使用

这个包目前还没有发布到 npm。npm registry 会返回 `E404`，所以现在不要使用：

```bash
npx create-ai-native-sdlc@latest init .
```

在首次 npm 发布前，可以让 `npx` 直接从 GitHub 运行：

```bash
npx --yes --package=github:davych/my-sdlc-workflow \
  create-ai-native-sdlc init . \
  --name "My Product" \
  --summary "一句话说明产品解决的问题"
```

也可以克隆本仓库后本地运行：

```bash
npm install
node bin/cli.js init /path/to/target \
  --name "My Product" \
  --summary "一句话说明产品解决的问题"
```

## npm 发布后

首次发布成功后，下面的命令才会生效：

```bash
npx create-ai-native-sdlc@latest init . \
  --name "My Product" \
  --summary "一句话说明产品解决的问题"
```

## YAML 配置

[templates/ai-native.yaml](templates/ai-native.yaml) 是默认配置。它包含：

- 项目名称与简介
- GitHub Copilot、Claude Code、Codex 开关
- PM/BA、设计师、架构师、软件工程师、测试、DevOps 六个角色
- discovery → design → architecture → implementation → verification → release 流程
- baseline 和业务产物输出路径

如果目标项目已经有 `ai-native.yaml`，初始化器会直接读取它：

```bash
create-ai-native-sdlc init .
```

也可以从其他 YAML 文件初始化：

```bash
create-ai-native-sdlc init . --config /path/to/ai-native.yaml
```

已有同名文件默认跳过，不会覆盖。确实要全部覆盖时才使用 `--force`。

## 默认生成内容

```text
ai-native.yaml
AGENTS.md
CLAUDE.md
.ai-native/
  baseline/
  roles/
.github/
  copilot-instructions.md
  agents/*.agent.md
.claude/
  agents/*.md
.codex/
  agents/*.toml
docs/ai-native/
  product/
  design/
  architecture/
  engineering/
  testing/
  operations/
```

三家工具使用各自的原生项目文件；内容都来自同一个 YAML 和同一组模板。

## CLI

```text
create-ai-native-sdlc init [target]

--config <yaml>   从指定 YAML 初始化
--name <name>     覆盖项目名
--summary <text>  覆盖项目简介
--force           覆盖已有同名文件
--help            显示帮助
```

## CI 与 npm 发布

CI 只有一个 Ubuntu / Node 20 job：安装依赖、运行两个基础初始化测试，再检查 npm 包可以打包。

发布流程已经放在 `.github/workflows/publish.yml`。以后只需要：

1. 在 GitHub 仓库 Secrets 中配置 `NPM_TOKEN`。
2. 更新 `package.json` 的版本。
3. 推送对应的 `v*` tag，或手动运行 `Publish to npm` workflow。
4. Workflow 测试通过后执行 `npm publish --access public`。
5. 用 `npm view create-ai-native-sdlc version` 确认发布成功，再对外使用 `@latest` 命令。

## 本地验证

```bash
npm test
npm pack --dry-run
```

## License

MIT
