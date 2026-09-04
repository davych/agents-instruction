# create-ai-native-sdlc

A small Node.js CLI that adds an AI-native delivery workflow to an existing project.

## Setup

Requirements: Node.js 20 or later.

Initialize the current project:

```bash
npx --yes --package=github:davych/my-sdlc-workflow \
  create-ai-native-sdlc init .
```

The CLI asks for the project name, summary, AI tool, and any dedicated role agents. Every canonical role is optional and independent. When PM / BA, Designer, or Architect is selected, it also asks for `formal` or `rapid` delivery mode.

When Software Engineer is selected, initialization asks which developer identity this code repository needs: frontend, backend, or full-stack. This is responsibility scope, not technology selection. Initialization never asks for a language, framework, database, cloud, or other stack choice.

## Repository patterns

An Architect-only delivery project needs no developer scope at initialization:

```bash
npx --yes --package=github:davych/my-sdlc-workflow \
  create-ai-native-sdlc init ./delivery \
  --name "Product delivery" \
  --summary "Cross-repository product and architecture artifacts" \
  --tool codex \
  --roles architect \
  --delivery-mode formal
```

The Architect determines frontend/backend technology scopes later, when application architecture work first needs them.

For separate code repositories, initialize one specialist and optionally connect its Architecture route to the delivery project:

```bash
# Frontend repository
npx --yes --package=github:davych/my-sdlc-workflow \
  create-ai-native-sdlc init ./web-app \
  --name "Web app" \
  --repository-id web-app \
  --summary "Customer web application" \
  --tool codex \
  --roles software-engineer \
  --engineer-scope frontend \
  --architecture-source ../delivery

# Backend repository
npx --yes --package=github:davych/my-sdlc-workflow \
  create-ai-native-sdlc init ./api-service \
  --name "API service" \
  --repository-id api-service \
  --summary "Customer API" \
  --tool codex \
  --roles software-engineer \
  --engineer-scope backend \
  --architecture-source ../delivery
```

A monorepo can use one full-stack developer agent:

```bash
npx --yes --package=github:davych/my-sdlc-workflow \
  create-ai-native-sdlc init ./application \
  --name "Application" \
  --repository-id application \
  --summary "Frontend and backend monorepo" \
  --tool codex \
  --roles software-engineer \
  --engineer-scope fullstack \
  --architecture-source ../delivery
```

Or it can generate separate frontend and backend agents while retaining one canonical Software Engineer role and one Implementation phase:

```bash
npx --yes --package=github:davych/my-sdlc-workflow \
  create-ai-native-sdlc init ./application \
  --name "Application" \
  --repository-id application \
  --summary "Frontend and backend monorepo" \
  --tool codex \
  --roles software-engineer \
  --engineer-scope frontend,backend \
  --architecture-source ../delivery
```

`--architecture-source` accepts a filesystem path or an HTTPS base URL. It is available only for a project with Software Engineer and without a local Architect. It configures a read-only `delivery-project` host; it does not clone, copy, synchronize, or write across repositories.

Use `--roles all` for all six canonical roles; because it includes Software Engineer, also provide `--engineer-scope`. Use `--roles none` when a repository needs only the shared workflow, routes, and bridge. `--delivery-mode rapid` reduces ceremony for PM / BA, Designer, and Architect while preserving scope, evidence, safety, contracts, migration, and human-decision boundaries.

## Developer profiles

The canonical phase owner stays `software-engineer`. Schema-v2 installation metadata records the repository-specific generated identity:

```json
{
  "schemaVersion": 2,
  "repositoryId": "application",
  "tool": "codex",
  "roles": ["software-engineer"],
  "roleProfiles": {
    "software-engineer": {
      "areas": ["frontend", "backend"],
      "agentMode": "separate"
    }
  },
  "deliveryMode": "formal"
}
```

Single frontend or backend scope uses `agentMode: "specialist"`. `fullstack` records both areas with `agentMode: "fullstack"`. A project without Software Engineer omits `roleProfiles`.

The selected tool receives `frontend-developer`, `backend-developer`, or `fullstack-developer`; separate mode receives both specialists. Each agent combines the shared Software Engineer workflow and Clean Code discipline with a small responsibility-specific profile. In separate mode, a request or one user answer names the frontend/backend lead whenever shared files are needed. The lead records one owner and the edit order for shared workspace files, contracts, libraries, CI, root configuration, and common tests in its scoped plan; the other specialist reads that plan, and both never edit the same shared file. Frontend, backend, and full-stack implementation artifacts use separate locations:

```text
docs/ai-sdlc/implementation/frontend/{plan,tasks,notes}.md
docs/ai-sdlc/implementation/backend/{plan,tasks,notes}.md
docs/ai-sdlc/implementation/fullstack/{plan,tasks,notes}.md
```

These files are created by the developer only when useful, not by initialization.

## Architect first use and technology profiles

Technology decisions belong to the Architect's work, not CLI initialization. On the first application Architecture task, the Architect:

1. Looks for the local or routed technology catalog and child profiles.
2. For an existing or hybrid code repository that is not configured, asks for a unique host ID and its read-only filesystem root or HTTPS base URL, then adds only that host to the delivery repository registry without adding a phase route.
3. Reads the code repository's `.ai-sdlc/installation.json` and `.ai-sdlc/project-profile.md`, including its stable `repositoryId`, before inspecting further evidence.
4. If the catalog is absent or incomplete, asks whether the system includes frontend, backend, or both, then identifies the real deployable scopes.
5. Distinguishes existing, greenfield, and hybrid scopes, records proposals, and asks a person to accept material choices.

Existing technology is recorded as `Observed`, not silently accepted. When preserving that baseline is recommended, the target is recorded as `Proposed`, accepted once by a person, and then marked `Accepted`. Greenfield planning presents two or three viable candidates for each material decision. A hybrid profile applies the existing or greenfield treatment per concern and records compatibility or migration boundaries. Rapid mode may keep the documents short, but it does not skip them when application implementation needs technology decisions. Documentation-only, feasibility, data-only, or integration-only work does not force a frontend/backend choice.

The stable catalog and zero or more scoped profiles live in the delivery project:

```text
docs/ai-sdlc/technology-profile.md
docs/ai-sdlc/technology/frontend/<scope-id>.md
docs/ai-sdlc/technology/backend/<scope-id>.md
```

Documents use `Proposed`, `Confirmed`, or `Superseded`. Profile entries use `Observed`, `Required`, `Proposed`, `Accepted`, `Excluded`, or `Unknown`. Only `Required` and `Accepted` entries instruct implementation. Shared API or event contracts, identity and trust boundaries, compatibility, coordinated migration, and ADR links stay in the catalog or shared Architecture Pack instead of being duplicated in every child profile.

Each catalog row keeps `Repository ID` separate from `Source host/path`. Different code sources in one delivery project must have different Repository IDs; multiple checkouts of the same repository reuse one. A greenfield source that does not exist yet uses `Planned / Not created`, then records a host/path after creation. Developers read their exact `repositoryId` from local `.ai-sdlc/installation.json`, match it with their engineering area, and then select the deployable or Scope ID set affected by the current request and code paths. If that set remains ambiguous, they ask instead of combining profiles. The source host/path records where the Architect read evidence and is not used as identity.

Each `<scope-id>` is a stable lowercase kebab-case identifier such as `customer-web` or `billing-api`. It is one filename segment, never a repository path or URL.

The Architect operates in the delivery project. It may inspect configured code repositories through the read-only artifact bridge, but it does not modify their code, dependencies, schemas, or deployment configuration.

## Update an existing installation

Run the latest CLI against a schema-v2 installation:

```bash
npx --yes --package=github:davych/my-sdlc-workflow \
  create-ai-native-sdlc update .
```

Update is non-interactive. It reads `.ai-sdlc/installation.json` and restores the same tool-native scoped developer agent set, shared workflow, technology-planning guide, templates, and read-only bridge. It preserves the project profile, artifact registry, artifact index, delivery documents, code, and unrelated files. Custom changes inside a CLI-managed file are replaced.

Schema-v1 installation metadata is rejected clearly before writes. This exploratory release does not infer scope, migrate metadata, or add a compatibility system; initialize a clean schema-v2 target instead.

## Generated files

Only the selected AI tool is configured.

| Tool | Project instructions | Selected role agents |
|---|---|---|
| GitHub Copilot in VS Code | `.github/copilot-instructions.md` | `.github/agents/*.agent.md` |
| Claude Code | `CLAUDE.md` | `.claude/agents/*.md` |
| Codex | `AGENTS.md` | `.codex/agents/*.toml` |

Every installation includes:

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
    technology-profile-frontend.md
    technology-profile-backend.md
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

`.ai-sdlc/project-profile.md` is a readable initialization snapshot. `.ai-sdlc/installation.json` is the authoritative repository ID, tool, canonical-role, developer-profile, and delivery-mode record. `.ai-sdlc/artifact-hosts.json` is the route registry.

The `sdlc-artifact-bridge` is a repository skill, not an MCP server. It resolves `/docs/...` references to the local repository, another filesystem repository, or a canonical HTTPS URL. It only reads; it never clones, fetches, synchronizes, copies, or writes across repositories.

Invoke it with a routed path or an explicit host:

```text
$sdlc-artifact-bridge /docs/ai-sdlc/technology-profile.md
$sdlc-artifact-bridge delivery-project:/docs/ai-sdlc/technology/frontend/web-app.md
```

For scoped technology, resolve the catalog first, select rows matching the developer area and repository or host/path, then resolve the exact child paths listed by those rows. Do not infer a scope from a filename.

## Delivery workflow

The workflow keeps this phase order and ownership:

| Phase | Owner | Typical work |
|---|---|---|
| Discovery | PM / BA | PRD, stories, business rules, and acceptance criteria |
| Design | Designer | Baseline, flows, states, responsive and accessible behavior |
| Architecture | Architect | Technology catalog and child profiles, Architecture Pack, C4, ADRs, patterns, NFRs, and risks |
| Implementation | Software Engineer | Scoped plan/tasks when useful, production changes, tests, checks, and notes |
| Verification | Tester | Requirement and risk-based test results |
| Release | DevOps | Release, health-check, monitoring, and rollback steps |

Start a change with:

```text
Follow .ai-sdlc/workflow.md for this change: <describe the change>.
```

The initialized role set may be sparse. A missing local role is not a missing phase, does not initialize itself, and does not force a filler artifact. Roles read local artifacts first and use the bridge for configured sources.

When work needs a human decision, the agent asks immediately with two or three clear options and a recommended choice. It continues after the answer and records the selected result instead of hiding an unresolved question at the end of a document.

## Write safety

Initialization is create-only. It checks every destination before writing and stops when any destination already exists. If a later write fails, it removes only unchanged files created by that command.

Update checks every managed destination and rejects unsafe paths. If a later write fails, it restores files already replaced and removes unchanged files created by that update. A file changed concurrently is kept and reported.

## CLI reference

```text
create-ai-native-sdlc init [target] [options]
create-ai-native-sdlc update [target]

--name <name>                    Project name
--repository-id <id>             Stable catalog match ID (default: target-derived)
--summary <text>                 Short project summary
--tool <tool>                    copilot, claude, or codex
--roles <list>                   Comma-separated role IDs, all, or none
--delivery-mode <mode>           formal or rapid (default: formal)
--engineer-scope <scope>         frontend, backend, fullstack, or frontend,backend
--architecture-source <source>   Filesystem path or HTTPS base URL
-h, --help                       Show help
```

Role IDs are `pm-ba`, `designer`, `architect`, `software-engineer`, `tester`, and `devops`.

`--repository-id` is a stable ASCII lowercase kebab-case identity used to match this repository to technology catalog rows; by default it is derived from the target directory name. Set it explicitly when the Architect has already reserved an ID, when different directory names normalize to the same value (such as `api_service` and `api.service`), when distinct repositories share a directory name, or when several checkouts represent the same repository. It must be unique for each distinct code source within one delivery project. A target name that cannot produce an ASCII ID requires this option. `--engineer-scope` is required when Software Engineer is selected and invalid otherwise. `frontend,backend` directly means two separate specialist agents; `fullstack` means one agent. `--architecture-source` requires Software Engineer and cannot be combined with a local Architect. Initialization-only options are not accepted by `update`.

## Development

```bash
npm test
npm pack --dry-run
```

## License

MIT
