# Getting Started

Use this guide to install the canonical workflow in a target project and begin its first Run. For repository development commands, return to the [root README](../../README.md).

## Before you start

You need:

- Node.js 20 or later;
- a target project directory where new files may be created;
- an AI coding client that can read project files;
- Corepack and Docker only when using the optional Web Platform;
- Codex CLI only for real Web jobs.

The initializer renders exactly one native Agent set from the same six canonical role sources. Choose GitHub Copilot, Claude Code, or Codex during initialization.

## Run the initializer

The package is not published on npm yet. Run the current repository version from GitHub:

```bash
npx --yes --package=github:davych/my-sdlc-workflow \
  create-ai-native-sdlc init .
```

Replace `.` with a different target directory when needed:

```bash
npx --yes --package=github:davych/my-sdlc-workflow \
  create-ai-native-sdlc init ./my-project
```

After the first npm release, the command will be:

```bash
npx create-ai-native-sdlc@latest init .
```

Do not use the npm command before the package is published.

## Answer the interactive questions

| Value | Required | Meaning |
|---|---:|---|
| Project name | No | Defaults to the target directory name |
| Project summary | Yes | One sentence describing the problem the product solves |
| Target AI client | Yes | Chooses GitHub Copilot, Claude Code, or Codex native Agent files |
| Designer Markdown inputs | No | Comma-separated project-relative Markdown sources |
| Designer component catalog module | No | Project-relative `.mjs` module for querying real components |

Project name and summary remain interactive. The optional client flag answers only the client question:

```bash
npx create-ai-native-sdlc@latest init . --client codex
```

Valid CLI values are `copilot`, `claude`, and `codex`. The generated definition records `github-copilot`, `claude-code`, or `codex`. You do not choose an Agent directory manually.

## Write safety and existing projects

The initializer preflights every planned destination and stops when:

- `ai-native.yaml` already exists;
- another planned file already exists;
- a planned file conflicts with a directory;
- a parent is a file or symbolic link;
- a path could escape the target project.

Initialization is create-only and fail-closed. It does not merge into or overwrite an initialized project. A normal failed or cancelled attempt cleans up transaction-owned unchanged files; unverifiable crash remnants are preserved for human inspection.

Do not rerun the initializer over an existing project or replace project-owned workflow files wholesale. Adopt newer contracts through an explicit, reviewed incremental backfill that preserves local content, keeps the six phase IDs and owners, diffs every affected file, and validates the updated project before using new gates.

## Generated structure

Every target project receives the shared contract:

```text
ai-native.yaml
.ai-sdlc/
  workflows/
    default.md
  roles/
    pm-ba/
    designer/
    architect/
    software-engineer/
    tester/
    devops/
  templates/
```

It also receives exactly one native Agent set:

| Selected client | Generated files |
|---|---|
| GitHub Copilot | `.github/agents/<role>.agent.md` |
| Claude Code | `.claude/agents/<role>.md` |
| Codex | `.codex/agents/<role>.toml` |

The native files are renderings, not separate role definitions. Agent files own role identity and authority; each role's `workflow.md` owns its ordered procedure; focused `references/` own specialist rules; `.ai-sdlc/templates/` own output schemas.

The initializer does not create product deliverables under `docs/`. Agents create only artifacts selected by a real Run or direct local workflow.

## Start the first Run

Choose one operating surface.

### Web Platform

1. Follow the [Platform operator guide](../../platform/README.md).
2. Register the initialized project.
3. Create a Run and its immutable Change Contract.
4. As the human/operator, record Product, Design, and Architecture impact dispositions.
5. Execute only roles required by those dispositions.
6. Review current artifacts and gates before advancing.

The Web Platform persists clearances, revisions, path pins, reviews, and trusted runner events. Read its [runtime contract](../../platform/docs/runtime-contract.md) and [security model](../../platform/docs/security-model.md) before real execution.

### Direct IDE client

1. Open `ai-native.yaml` and confirm the project summary, output root, role list, phase order, and artifact registry.
2. Start the Run from `.ai-sdlc/templates/change-contract.md`; treat the completed Change Contract as immutable.
3. Record Product, Design, and Architecture dispositions as human decisions with durable evidence references; do not represent them as Web clearances.
4. Before invoking a required native Agent, give it one direct-IDE execution brief naming the phase, resolved Change Contract path, upstream evidence references, selected registered output IDs, and allowed product-source scope.
5. Review its registered artifacts before handing current evidence to the next phase.

Use the Agent's own `Start` section and the role's canonical `workflow.md`. Do not paste or maintain a second procedural prompt in project guidance.

A direct IDE session follows the same role, artifact, and human-authority contract, but it has no Web execution contract, task-and-Run path pins, or persisted artifact-head revisions. It uses the owner-aware registered basename paths and cannot claim Web clearances, manifest approvals, mutation guards, trusted command events, or semantic-gate results that the Platform did not produce.

## Continue from here

| Goal | Guide |
|---|---|
| Understand phase order, impact routes, and feedback | [End-to-End Workflow](../workflow/README.md) |
| Understand role ownership and Prompt layers | [Role Relationships](../roles/README.md) |
| Configure artifacts, inputs, and output paths | [Configuration](../configuration/README.md) |
| Review one role's human contract | [Role guides](../roles/README.md#ownership-matrix) |
| Operate the Web application | [Platform README](../../platform/README.md) |
| Learn the repository in Chinese | [AI-SDLC 学习手册](../learning/README.md) |
