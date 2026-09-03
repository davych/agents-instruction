# create-ai-native-sdlc

A small Node.js CLI that adds an AI-native delivery workflow to an existing project.

## Setup

Requirements: Node.js 20 or later.

Initialize the current project:

```bash
npx --yes --package=github:davych/my-sdlc-workflow \
  create-ai-native-sdlc init .
```

The CLI asks for the project name, a short summary, the AI tool, and whether to initialize each of the six dedicated role agents. Every role is optional and independent. You can initialize only Architect, only Designer and Tester, all roles, or no dedicated roles.

You can also pass every value directly:

```bash
npx --yes --package=github:davych/my-sdlc-workflow \
  create-ai-native-sdlc init ./my-project \
  --name "My Project" \
  --summary "A small tool for my team" \
  --tool codex \
  --roles pm-ba,designer,architect
```

The target defaults to the current directory. Non-interactive use supplies `--roles` with a comma-separated list. Use `--roles all` for all six agents or `--roles none` when this repository only needs the shared workflow, artifact routes, and bridge skill.

## Update an existing installation

Run the latest CLI against a project that was already initialized:

```bash
npx --yes --package=github:davych/my-sdlc-workflow \
  create-ai-native-sdlc update .
```

Update is non-interactive. New installations record the initialized AI tool and roles in `.ai-sdlc/installation.json`. For an older installation without that file, update verifies the generated project instructions and derives the roles from the project profile or existing role files. If more than one legacy tool installation is recognized, select one with `--tool copilot`, `--tool claude`, or `--tool codex`.

The command replaces the CLI-managed workflow, technology-planning guide, templates, artifact bridge Skill, and selected role agent files with the versions shipped by the current CLI. It also creates newly shipped files in those managed locations. When a supported legacy installation does not yet have the installation record, project profile, or artifact host registry, update creates the missing file from the detected installation; it never replaces an existing profile or registry. It does not add or remove roles, and it does not delete files that are no longer shipped.

Project state is preserved. Update does not change the root project instructions or replace an existing `.ai-sdlc/project-profile.md` or `.ai-sdlc/artifact-hosts.json`. It also preserves `docs/ai-sdlc/index.md`, delivery documents under `docs/ai-sdlc/`, unknown role agents, and other project files. `.ai-sdlc/installation.json` is CLI-owned identification metadata. Custom changes inside a CLI-managed file are replaced, so keep project-specific rules and working documents in the preserved locations.

## Generated files

Only the selected AI tool is configured.

| Tool | Project instructions | Selected role agents |
|---|---|---|
| GitHub Copilot in VS Code | `.github/copilot-instructions.md` | `.github/agents/*.agent.md` |
| Claude Code | `CLAUDE.md` | `.claude/agents/*.md` |
| Codex | `AGENTS.md` | `.codex/agents/*.toml` |

Initialization writes `.ai-sdlc/project-profile.md` as the human-readable description of local role coverage and detected project evidence. It also writes `.ai-sdlc/artifact-hosts.json` as the machine-readable registry for local and cross-repository artifact ownership, plus `.ai-sdlc/installation.json` so later updates can identify the selected AI tool and roles without guessing from common project filenames.

Stack and validation choices are intentionally not part of initialization. When the Architect first works, it looks for an existing technology profile locally and through the artifact routes. If none exists, it inspects evidence, asks the user only for material unresolved choices, and creates `docs/ai-sdlc/technology-profile.md`. This works even when no development role is installed, and it does not install dependencies, scaffold an application, or authorize a migration.

Every tool also gets the shared workflow and artifact templates:

```text
.agents/
  skills/
    sdlc-artifact-bridge/
      SKILL.md
.ai-sdlc/
  artifact-hosts.json
  installation.json
  project-profile.md
  technology-planning.md
  workflow.md
  templates/
    prd.md
    story.md
    design-baseline.md
    design-spec.md
    technology-profile.md
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

Templates are used only when they add value. Working documents are created under `docs/ai-sdlc/`. The local artifact index lists only documents owned by this repository that actually exist, with a link and a short description.

The `sdlc-artifact-bridge` is a repository skill, not an MCP server. It reads `.ai-sdlc/artifact-hosts.json` to resolve `/docs/...` references to this repository, another local repository, or a canonical HTTPS URL. It performs read-only context resolution: it does not clone, fetch, synchronize, copy, or write across repositories.

Invoke it with a routed path, or name a host explicitly:

```text
$sdlc-artifact-bridge /docs/ai-sdlc/prd.md
$sdlc-artifact-bridge product-repo:/docs/ai-sdlc/prd.md
```

Each phase has its own route in the registry. A selected local role starts with its route set to the local host; an unselected role starts with a null host and appears as `Unconfigured` in the project profile. To connect a separate product, design, or architecture repository later, add its filesystem or HTTPS host and point only the relevant route at it. The other roles remain independent.

For example, add this object as `hosts.product-repo` for a sibling repository:

```json
{
  "kind": "filesystem",
  "root": "../product-repo",
  "artifactIndex": "docs/ai-sdlc/index.md"
}
```

Then set the existing `routes.discovery.host` value to `"product-repo"` and preserve its generated `phase`, `role`, and `paths`. For an HTTPS document host, add this object as `hosts.product-docs`:

```json
{
  "kind": "url",
  "baseUrl": "https://example.com/product-docs/",
  "artifactIndex": "docs/ai-sdlc/index.md"
}
```

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

The phase names, order, and owners remain stable, but the initialized role set may be sparse. Roles first read artifacts in the local index, then use the bridge for configured external sources. A later role does not require every earlier role to be local, and the workflow never initializes a missing role or creates a filler upstream document automatically.

When the request and available evidence are sufficient, a selected role continues independently. When a required input is missing, it asks for the specific route, artifact, or decision that blocks the work and records the source once supplied.

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

Update checks every managed destination before writing and rejects symbolic links or other unsafe paths. If a later write fails, it restores files already replaced and removes unchanged files created by that update. A file changed or replaced by another process during rollback is kept and reported instead of being overwritten.

## CLI reference

```text
create-ai-native-sdlc init [target] [options]
create-ai-native-sdlc update [target] [--tool <tool>]

--name <name>               Project name
--summary <text>            Short project summary
--tool <tool>               copilot, claude, or codex
--roles <list>              Comma-separated role IDs, all, or none
-h, --help                  Show help
```

Role IDs are `pm-ba`, `designer`, `architect`, `software-engineer`, `tester`, and `devops`.

For `update`, `--tool` is needed only when more than one supported legacy tool installation is detected. The initialization-only `--name`, `--summary`, and `--roles` options are not accepted.

## Development

```bash
npm test
npm pack --dry-run
```

## License

MIT
