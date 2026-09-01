# create-ai-native-sdlc

A small CLI that adds a clear six-role delivery workflow to a project.

It has one job: ask which AI coding tool you use, then create the right project instruction files for that tool.

## What it keeps

- One main Markdown file for each role.
- One fixed flow from product work to release planning.
- One small Markdown template for each phase.
- Human control over scope, architecture, risk, and release.

## What it does not include

- No web app.
- No server or database.
- No workflow runner.
- No dashboard.
- No sync or migration engine.
- No large group of reports for every code change.

## Quick start

Requirements: Node.js 20 or later.

The package is not published to npm yet. Run it from GitHub:

```bash
npx --yes --package=github:davych/my-sdlc-workflow \
  create-ai-native-sdlc init .
```

The CLI asks for:

1. Project name.
2. A short project summary.
3. Your AI tool: GitHub Copilot, Claude Code, or Codex.

You can also pass every value as an option:

```bash
create-ai-native-sdlc init ./my-project \
  --name "My Project" \
  --summary "A small tool for my team" \
  --tool codex
```

## Tool-specific files

The CLI creates only one tool set.

| Tool | Project instructions | Role agents |
|---|---|---|
| GitHub Copilot | `.github/copilot-instructions.md` | `.github/agents/*.agent.md` |
| Claude Code | `CLAUDE.md` | `.claude/agents/*.md` |
| Codex | `AGENTS.md` | `.codex/agents/*.toml` |

All role content comes from `templates/agents/*.md`. Codex role files use TOML because that is its native custom-agent format. The main source is still Markdown.

## Shared files

Every initialized project also gets:

```text
.ai-sdlc/
  workflow.md
  templates/
    prd.md
    design-spec.md
    architecture.md
    implementation-notes.md
    test-report.md
    release-runbook.md
```

The CLI installs templates only. The AI tool creates working documents under `docs/ai-sdlc/` when the work needs them.

## Roles

| Phase | Role | Main job |
|---|---|---|
| Discovery | PM / BA | Make the goal, scope, and acceptance checks clear. |
| Design | Designer | Define user behavior when the change affects the user experience. |
| Architecture | Architect | Record important technical decisions and risks. |
| Implementation | Software Engineer | Change code, add tests, and report real check results. |
| Verification | Tester | Check the result against the agreed behavior and risks. |
| Release | DevOps | Prepare release, health checks, and rollback steps. |

Small changes should stay small. A phase may record that no extra work is needed. Do not create detail only to fill a template.

## Write safety

Initialization is create-only.

- It checks every planned path before writing.
- It stops if any destination already exists.
- It does not merge or overwrite project files.
- If a write fails, it removes only unchanged files created by that command.

Review the generated files before using them in an existing project.

## CLI

```text
create-ai-native-sdlc init [target] [options]

--name <name>       Project name
--summary <text>    Short project summary
--tool <tool>       copilot, claude, or codex
-h, --help          Show help
```

## Develop

```bash
npm test
npm pack --dry-run
```

## License

MIT
