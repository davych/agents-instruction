# AI SDLC Platform

This directory is an independent Yarn 4 workspace for operating AI SDLC projects through a web app and API. It does not replace or modify the repository's existing `create-ai-native-sdlc` package or CLI.

The MVP stack is React + Vite, Tailwind CSS, shadcn/ui components backed by Radix primitives, Fastify, PostgreSQL 16, and the local Codex CLI execution protocol.

## Prerequisites

- Node.js 20 or newer with Corepack
- Docker; Compose v2 is used when present, otherwise the database script falls back to the Docker CLI
- Codex CLI only when running real jobs; the fake runner works without Codex

## Local development

From `platform/`:

```bash
corepack enable
cp .env.example .env
yarn install
yarn db:up
yarn dev
```

The web app is served at <http://localhost:5173> and the API at <http://localhost:4100>. Yarn injects the optional root `.env` into workspace scripts. PostgreSQL is exposed only for local development on host port `54329`; `db:up` waits for its healthcheck whether it uses Compose or the Docker CLI fallback.

Useful commands:

```bash
yarn build
yarn test
yarn typecheck
yarn db:logs
yarn db:down
```

`db:down` stops the database but keeps its named volume. Use Docker's explicit volume-removal option only when local data loss is intended.

## Register an existing project

1. Set `AI_SDLC_ALLOWED_PROJECT_ROOTS` in `.env` to the absolute parent directory that the platform may access. Use the host OS path delimiter for multiple roots.
2. Start the database and platform.
3. In the web app, choose the existing-project flow and provide a name, summary, and the project's absolute path (`initialize: false` in the API request).
4. The API validates that the resolved path stays inside an allowed root and registers the project without re-running initialization.

An existing project should already contain `ai-native.yaml`. Registration stores platform metadata; it does not overwrite the project's workflow files.

## Initialize a new project

1. Ensure the target's parent directory is included in `AI_SDLC_ALLOWED_PROJECT_ROOTS`.
2. In the web app, choose the new-project flow and provide the project name, summary, and target path (`initialize: true` in the API request).
3. The API invokes the repository's original initializer, then registers the initialized project. It discovers `bin/cli.js` automatically; an `AI_SDLC_CLI_PATH` override must be an absolute path.

Initialization retains the original CLI's safety boundary: a target that already has `ai-native.yaml`, or contains conflicting generated paths, is rejected instead of overwritten.

## Codex runner

Real jobs require the `codex` executable to be available to the API process. Override its command with `AI_SDLC_CODEX_BIN` when needed. Real execution is the default; the explicit setting is:

```dotenv
AI_SDLC_CODEX_FAKE=0
```

Real executions are terminated after 30 minutes by default. Adjust `AI_SDLC_CODEX_TIMEOUT_MS` when a known-long task needs a different local ceiling.

For UI development, tests, and deterministic demos, keep `AI_SDLC_CODEX_FAKE=1`. The fake runner exercises job state and output handling without launching Codex or making remote model calls; it is not evidence that a real Codex task succeeded.

Before every real phase run, the execution dialog reads the account- and project-scoped Codex model catalog. It defaults to the effective Codex configuration for that project and lets the user choose a supported model and reasoning effort for that single execution. The resolved pair is passed explicitly to `codex exec`, stored with the execution, and shown in its timeline. Optional server allowlists and defaults can be set with `AI_SDLC_CODEX_MODELS`, `AI_SDLC_CODEX_REASONING_EFFORTS`, `AI_SDLC_CODEX_DEFAULT_MODEL`, and `AI_SDLC_CODEX_DEFAULT_REASONING_EFFORT`.

## Design outputs and Figma

The first Design execution includes the downstream-required `design-baseline` and `design-spec`. A user can additionally select a self-contained `design-prototype` HTML file and a verified `figma-handoff`. Later executions may select only the outputs that need to be regenerated. The runner collects only the selected outputs, byte-snapshots every other registered artifact across all phases, restores any accidental changes on both success and failure paths, and records the selection with the execution.

The logical artifact ID remains `design-spec`, but its physical filename is task-scoped: `<safe-task-title>--<full-run-id>-design-spec.md`. This keeps multiple tasks—even tasks with the same title—from overwriting one another, while every local re-run of one task continues from the same file.

HTML prototypes open in the artifact review dialog with Preview and Source views. Preview runs in a unique-origin iframe sandbox with scripts, external resources, forms, popups, embedded frames, objects, and top-level navigation disabled. Native HTML/CSS states such as `details` and checkboxes remain usable; the full original file stays available in Source view.

Figma output is enabled when the same project-scoped Codex context used by the runner reports either an enabled, accessible Codex Desktop Figma App connector or an enabled official Figma MCP server with OAuth credentials. Before selecting the Figma output, the execution dialog also requires an explicit write target: either choose a writable plan and a filename for a new private Draft, or paste the canonical URL of an existing Figma Design file. When several writable plans are available, the platform never guesses on the user's behalf; View-only seats remain visible but cannot be selected. The Desktop connector is detected through Codex App Server; users who prefer a standalone MCP connection can use the official Codex MCP flow, then choose **重新检测** in the dialog:

```bash
codex mcp add figma --url https://mcp.figma.com/mcp
codex mcp login figma
```

The platform exposes only normalized readiness and plan capability fields; it never returns the raw MCP response, account email, handle, or credentials to the browser. Credential presence and an empty newly created file are not treated as proof of work: a Figma execution succeeds only when the current Codex JSONL contains a completed design mutation against the exact selected file and `figma-handoff.md` contains matching file and node evidence. It must not fabricate a Figma URL.

## Human revisions and local re-runs

Every phase artifact can be opened in the review dialog and adjusted by a human. Saving safely materializes the content back to the registered project file and creates a new append-only revision with an optimistic-lock content hash; the previous revision remains in the audit chain and is marked superseded. Directory artifacts keep their existing file list and are edited through the aggregated `## relative/path` sections. A human revision reopens the phase for review and marks downstream phases pending, rather than silently treating already-approved downstream work as current.

The execution dialog supports output-level local re-runs for every phase. A re-run replaces only the selected artifact heads and carries forward the latest versions of unselected outputs. The runner also receives the current phase snapshots—including human revisions—and recent change-request comments as its modification context. If a previously approved phase is revised or re-run, the workflow becomes active again and downstream phases must be revalidated explicitly.

## Architecture

```text
apps/web        browser UI (Vite, port 5173)
    |
    v
apps/api        project registry, initialization API, and job runner (port 4100)
    | \
    |  +------> local project directories, constrained by allowed roots
    v
PostgreSQL      project and job state (Docker host port 54329)

packages/*      contracts and other code shared by workspace apps
```

The platform API is the trust boundary for filesystem and command access. The browser never receives database credentials and must not directly read project directories. Keep allowed roots narrow, use the real runner by default, enable the fake runner only explicitly for tests or deterministic demos, and retain explicit human approval for consequential project changes.

### MVP approval boundary

The human gate controls workflow state: only approved artifact snapshots can be selected by a later role, and a rejected revision is never promoted by a later rerun. Review requests carry the exact artifact head IDs shown to the reviewer, so a stale browser cannot approve a newer unseen revision. In this MVP, however, Codex still runs with `workspace-write` in the registered project so it can create the configured outputs and implement code. Review does **not** roll selected-output or implementation changes back. Use the MVP on disposable or recoverable project state. A production version should execute each phase in an isolated Git worktree or staging workspace and apply its patch only after approval.

Workflow definitions are currently read from the project's live `ai-native.yaml` for each action. The resolved `design-spec` path is pinned atomically when the run is created, so first execution, failures, and later reruns keep the same path even if the configured default basename or directory changes. Legacy runs without a stored pin reuse their latest recorded `design-spec` path. Freezing the complete definition version per run remains a production-hardening step; avoid changing other workflow configuration while a run is active.

## Repository boundary

`platform/` has its own `package.json`, Yarn configuration, dependency graph, and Docker service. Commands in this directory operate only on the platform workspaces. The repository-root initializer remains the source for newly initialized AI-native projects; its design artifact templates are kept aligned with the platform's selectable Design outputs.
