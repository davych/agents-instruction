# AI SDLC Platform

The Platform is a local React/Fastify application for operating projects initialized by [`create-ai-native-sdlc`](../README.md). It persists Runs, impact decisions, executions, artifact revisions, reviews, and semantic-gate results. It does not replace the repository initializer.

> **Security boundary:** this V1 has no authentication. Real jobs run Codex with approval and CLI sandbox bypassed, without an OS process-isolation boundary. Use it only for local, trusted, disposable or otherwise recoverable projects. Do not expose it remotely or register untrusted repositories. Read the [full security model](docs/security-model.md) before enabling real execution.

## Prerequisites

- Node.js 20 or newer with Corepack;
- Docker; Compose v2 is used when available, with a Docker CLI fallback;
- Codex CLI for real jobs. The fake runner does not require Codex.

## Start locally

From `platform/`:

```bash
corepack enable
[ -e .env ] || cp .env.example .env
yarn install
yarn db:up
yarn dev
```

Edit `.env` before registering a project. At minimum, replace `AI_SDLC_ALLOWED_PROJECT_ROOTS` with the narrowest trusted absolute parent directory the platform may access.

The Web app is served at <http://localhost:5174> and the API at <http://localhost:4100>. PostgreSQL uses host port `54329` by default. `yarn db:up` waits for the database health check.

Useful commands:

```bash
yarn typecheck
yarn test
yarn build
yarn db:logs
yarn db:down
```

`yarn db:down` stops PostgreSQL but keeps its named volume. Remove the volume only when local data loss is intended.

## Configure local access and execution

| Variable | Purpose |
|---|---|
| `AI_SDLC_ALLOWED_PROJECT_ROOTS` | Host-delimited list of absolute parent directories the API may access |
| `AI_SDLC_CODEX_BIN` | Codex executable used for real jobs; defaults to `codex` |
| `AI_SDLC_CODEX_TIMEOUT_MS` | Real-execution timeout; defaults to 30 minutes |
| `AI_SDLC_CODEX_FAKE` | `0` for real execution; `1` only for tests or deterministic demos |
| `AI_SDLC_CLI_PATH` | Optional absolute override for this repository's `bin/cli.js` |
| `DATABASE_URL` | PostgreSQL connection used by the API |
| `HOST` / `PORT` | API bind address and port |
| `VITE_API_URL` | API URL used by the Web app |

The execution dialog obtains the project-scoped Codex model catalog and records the selected model and reasoning effort for each real phase run. Optional model allowlists and defaults are documented in the [runtime contract](docs/runtime-contract.md).

## Register an initialized project

1. Confirm that the project already contains `ai-native.yaml`.
2. Add its parent directory to `AI_SDLC_ALLOWED_PROJECT_ROOTS`.
3. Start the database and application.
4. In the Web app, choose the existing-project flow and enter the name, summary, and absolute project path.

Registration stores platform metadata. It does not rerun the initializer or overwrite workflow files.

## Initialize and register a new project

1. Add the target's parent directory to `AI_SDLC_ALLOWED_PROJECT_ROOTS`.
2. In the Web app, choose the new-project flow.
3. Enter the project name, summary, target path, and native Agent client: Codex, Claude Code, or GitHub Copilot.

The API runs the repository initializer and registers the project only after filesystem initialization succeeds. Initialization remains create-only and fail-closed; an existing `ai-native.yaml`, unsafe path, symlink parent, or file conflict is rejected. If a response is lost after initialization, refresh the project list before retrying so an already committed project is not duplicated.

The selected native client controls the Agent files installed for direct IDE discovery. Web jobs still execute through the local Codex runner; selecting Claude Code or GitHub Copilot does not make the API launch that client.

## Fake and real jobs

Real execution is the default:

```dotenv
AI_SDLC_CODEX_FAKE=0
```

Use `AI_SDLC_CODEX_FAKE=1` for UI development, tests, and deterministic demonstrations. A fake execution proves only platform state handling; it is never evidence that a real Agent, test, or Release task succeeded.

Before running real jobs, review the [runtime contract](docs/runtime-contract.md) and [security model](docs/security-model.md). The runtime contract explains selected outputs, human revisions, Architecture checkpoints, E2E staging and promotion, Release readiness, and direct-IDE versus Web guarantees.

## Architecture at a glance

```text
apps/web        browser UI (Vite, port 5174)
    |
    v
apps/api        project registry, workflow coordination, and local runner (port 4100)
    | \
    |  +------> allowed local project roots
    v
PostgreSQL      Run, revision, review, and execution state (host port 54329)

packages/contracts   shared API contracts and validation
```

The API is the application-level boundary for filesystem and command access; it is not an authentication or process-isolation boundary. Keep allowed roots narrow and retain explicit human review for consequential project changes.

## Related documentation

- [Repository overview](../README.md)
- [Platform runtime contract](docs/runtime-contract.md)
- [Platform security model](docs/security-model.md)
- [End-to-End Workflow](../guidelines/workflow/README.md)
- [Configuration and artifact paths](../guidelines/configuration/README.md)
- [Role and Prompt layers](../guidelines/roles/README.md)

## Repository boundary

`platform/` is an independent Yarn 4 workspace with its own dependency graph and Docker service. Commands in this directory operate on platform workspaces. The repository-root initializer remains the canonical source for newly initialized AI-native projects.
