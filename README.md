# create-ai-native-sdlc

A small Node.js CLI that adds an AI-native delivery workflow to an existing project.

## Setup

Requirements: Node.js 20 or later.

Initialize the current project:

```bash
npx --yes --package=github:davych/my-sdlc-workflow \
  create-ai-native-sdlc init .
```

The CLI asks for the project name, a short summary, the AI tool, whether the project performs development work, and the relevant stack and validation preferences. Stack and validation questions are skipped when development is not needed.

You can also pass every value directly:

```bash
npx --yes --package=github:davych/my-sdlc-workflow \
  create-ai-native-sdlc init ./my-project \
  --name "My Project" \
  --summary "A small tool for my team" \
  --tool codex \
  --development frontend \
  --stack react-shadcn \
  --validation standard
```

The target defaults to the current directory. Non-interactive use supplies `--development` and, for frontend or backend work, `--stack` and `--validation`.

## Generated files

Only the selected AI tool is configured.

| Tool | Project instructions | Role agents | shadcn MCP when selected |
|---|---|---|---|
| GitHub Copilot in VS Code | `.github/copilot-instructions.md` | `.github/agents/*.agent.md` | `.vscode/mcp.json` |
| Claude Code | `CLAUDE.md` | `.claude/agents/*.md` | `.mcp.json` |
| Codex | `AGENTS.md` | `.codex/agents/*.toml` | `.codex/config.toml` |

The MCP file is generated only for the `react-shadcn` frontend preset and runs `npx shadcn@latest mcp`. Registries can be configured through the target project's `components.json`. See the [shadcn MCP documentation](https://ui.shadcn.com/docs/mcp). Codex supports project-scoped MCP configuration in trusted projects; see the [official OpenAI MCP documentation](https://developers.openai.com/codex/mcp).

Initialization writes `.ai-sdlc/project-profile.md` as the single description of whether development is enabled, the frontend or backend area, stack preference, UI system, validation depth, active phases, dedicated agents, and detected project evidence.

| Development | Stack presets | Dedicated agents |
|---|---|---|
| `none` | Not applicable | PM / BA, Designer, Architect |
| `frontend` | `react-shadcn`, `react-antd`, `react-mui`, `frontend-existing` | All six roles |
| `backend` | `java-spring`, `node-typescript`, `python-fastapi`, `backend-existing` | All six roles |

The `*-existing` choices keep an established project on its current stack when none of the named presets is accurate. Root project files mark a named preset as `project evidence; recommended` only when the matching evidence is present. An existing target without a matching preset recommends `*-existing`; an empty target shows the questionnaire's ordinary default as `recommended`. Validation uses `lean`, `standard`, or `thorough`. These settings guide the agents; they do not install dependencies, create an application, or authorize a framework migration.

Every tool also gets the shared workflow and artifact templates:

```text
.ai-sdlc/
  project-profile.md
  workflow.md
  templates/
    prd.md
    story.md
    design-baseline.md
    design-spec.md
    architecture.md
    architecture-discovery-context.md
    architecture-options.md
    architecture-c4-context.mmd
    architecture-c4-containers.mmd
    architecture-adr.md
    architecture-patterns.md
    architecture-nfrs.md
    architecture-risk-review.md
    implementation-plan.md
    implementation-tasks.md
    implementation-notes.md
    test-report.md
    release-runbook.md
docs/
  ai-sdlc/
    index.md
```

Templates are used only when they add value. Working documents are created under `docs/ai-sdlc/`. The artifact index lists only documents that actually exist, with a link and a short description. A frontend, backend, or another tool can use `docs/ai-sdlc/index.md` as the stable discovery entry point.

## Delivery workflow

The workflow keeps this phase order and ownership:

| Phase | Owner | Typical work |
|---|---|---|
| Discovery | PM / BA | PRD, user stories, business rules, and acceptance criteria |
| Design | Designer | Project baseline, user flow, real states, responsive and accessible behavior, and configured UI-system choices |
| Architecture | Architect | Architecture Pack, C4 context and containers, ADRs, patterns, NFRs, and material risks |
| Implementation | Software Engineer | Plan and tasks when useful, production changes, tests, checks, and implementation notes |
| Verification | Tester | Requirement and risk-based test results |
| Release | DevOps | Release, health-check, monitoring, and rollback steps |

Start a change with:

```text
Follow .ai-sdlc/workflow.md for this change: <describe the change>.
```

The roles coordinate through the existing artifacts listed in `docs/ai-sdlc/index.md`.

The six phases and owners remain fixed. A `none` development profile keeps Discovery, Design, and Architecture active; the workflow records that Implementation, Verification, and Release have no active work without generating their dedicated agents or filler documents.

When work needs a human decision, the agent asks immediately with two or three clear options and a recommended choice. It continues after the answer and records the selected result instead of leaving an unresolved question at the end of a document.

## Architecture Pack

The Architecture Pack is a project-level baseline that is maintained when architecture changes. Small changes can reuse it without producing filler documents.

- `architecture.md` summarizes the current direction and links the pack.
- C4 Context records people, the focal system, and external systems.
- C4 Containers records deployable frontends, services, data stores, and their relationships.
- Architecture Patterns contains the required project-wide rules and reusable implementation patterns.
- ADRs record durable choices, cross-repository decisions, migrations, and exceptions.
- Options, NFRs, discovery context, and risk review are used when the decision needs them.

## Write safety

Initialization is create-only. It checks every planned destination before writing and stops when any destination already exists. If a later write fails, it removes only unchanged files created by that command.

## CLI reference

```text
create-ai-native-sdlc init [target] [options]

--name <name>               Project name
--summary <text>            Short project summary
--tool <tool>               copilot, claude, or codex
--development <mode>        none, frontend, or backend
--stack <preset>            Frontend or backend stack preset
--validation <preference>   lean, standard, or thorough
-h, --help                  Show help
```

## Development

```bash
npm test
npm pack --dry-run
```

## License

MIT
