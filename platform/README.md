# AI SDLC Platform

This directory is an independent Yarn 4 workspace for operating AI SDLC projects through a web app and API. It does not replace or modify the repository's existing `create-ai-native-sdlc` package or CLI.

The MVP stack is React + Vite, Tailwind CSS, shadcn/ui components backed by Radix primitives, Fastify, PostgreSQL 16, and the local Codex CLI execution protocol.

> **Security boundary:** this V1 is only for local, trusted, disposable or otherwise recoverable project state. The API has no authentication, and the real Codex process is not isolated by an OS sandbox. Do not expose the service remotely or register an untrusted repository. Authentication, credential isolation, network policy, and an isolated worktree/container runner remain unresolved security-architecture blockers.

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

The web app is served at <http://localhost:5174> and the API at <http://localhost:4100>. Yarn injects the optional root `.env` into workspace scripts. PostgreSQL is exposed only for local development on host port `54329`; `db:up` waits for its healthcheck whether it uses Compose or the Docker CLI fallback.

Useful commands:

```bash
yarn build
yarn test
yarn typecheck
yarn db:logs
yarn db:down
```

Repository CI also runs the root initializer checks. From the repository root, the complete local validation contract is:

```bash
npm test
npm pack --dry-run

cd platform
yarn typecheck
yarn test
yarn build
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
2. In the web app, choose the new-project flow and provide the project name, summary, target path, and native Agent client: Codex, Claude Code, or GitHub Copilot (`initialize: true` in the API request).
3. The API invokes the repository's original initializer with that client choice, then registers the initialized project. It discovers `bin/cli.js` automatically; an `AI_SDLC_CLI_PATH` override must be an absolute path.

Initialization retains the CLI's safety boundary and is abort-safe. It preflights all destinations, stages and publishes files exclusively, rejects existing `ai-native.yaml`, conflicts, symlink parents, and path escape, and rolls back files plus newly empty directories created by a failed, timed-out, or cancelled attempt. If the initializer process crashes after its canonical journal is published, the next invocation verifies and removes only unchanged transaction-owned remnants before retrying; modified or replaced remnants are preserved and recovery fails closed. A pre-journal hidden staging remainder is detected and preserved for human inspection instead of being silently ignored or unsafely deleted. Publication is therefore crash-recoverable, not simultaneously visible as one multi-file operation. The API registers a project only after initialization reports success. That success is the filesystem commit point: a later request disconnect no longer cancels registration, preventing a committed initialized tree from being stranded outside the database. If a disconnect races an already-started database insert, reload the project list to reconcile the durable result before retrying; HTTP cancellation is not a distributed rollback.

## Codex runner

Real jobs require the `codex` executable to be available to the API process. Override its command with `AI_SDLC_CODEX_BIN` when needed. Real execution is the default; the explicit setting is:

```dotenv
AI_SDLC_CODEX_FAKE=0
```

Real executions are terminated after 30 minutes by default. Adjust `AI_SDLC_CODEX_TIMEOUT_MS` when a known-long task needs a different local ceiling.

The native Agent client selected during initialization controls the files installed in the project and is validated against the standard directory and all six role files. It does **not** select the Web execution engine: real Web phase jobs still run through the local Codex runner, which reads the selected client's canonical rendering and the same registered role/artifact contract. Choosing Claude Code or GitHub Copilot supports direct IDE discovery while preserving Web contract compatibility; it does not mean the Web server launches those clients.

For UI development, tests, and deterministic demos, keep `AI_SDLC_CODEX_FAKE=1`. The fake runner exercises job state and output handling without launching Codex or making remote model calls; it is not evidence that a real Codex task succeeded.

Before every real phase run, the execution dialog reads the account- and project-scoped Codex model catalog. It defaults to the effective Codex configuration for that project and lets the user choose a supported model and reasoning effort for that single execution. The resolved pair is passed explicitly to `codex exec`, stored with the execution, and shown in its timeline. Optional server allowlists and defaults can be set with `AI_SDLC_CODEX_MODELS`, `AI_SDLC_CODEX_REASONING_EFFORTS`, `AI_SDLC_CODEX_DEFAULT_MODEL`, and `AI_SDLC_CODEX_DEFAULT_REASONING_EFFORT`.

## Design outputs and Figma

The first Design execution includes the downstream-required `design-baseline` and `design-spec`. A user can additionally select a self-contained `design-prototype` HTML file and a verified `figma-handoff`. Later executions may select only the outputs that need to be regenerated. The runner collects only the selected outputs, byte-snapshots every other registered artifact across all phases, restores any accidental changes on both success and failure paths, and records the selection with the execution.

The logical artifact ID remains `design-spec`, but its physical filename is task-scoped: `<safe-task-title>--<full-run-id>-design-spec.md`. The Software Engineer evidence pack uses the same namespace for its plan, tasks, implementation index, session log, independent-test evidence, seven-lens review, and PR provenance. Tester's `test-report` and DevOps's `release-runbook` are task-scoped in the same way. This keeps multiple new tasks—even tasks with the same title—from overwriting one another, while every local re-run of one task continues from its original files. A pre-upgrade Run that already points to a shared legacy report basename is not silently moved. If two old Runs share that file, do not rerun Verification for either Run—sequentially or concurrently—until an authorized explicit backfill gives each Run its own pinned report path.

Resolved artifacts must remain under `paths.outputs`, under the owner's configured namespace when one exists, and outside `ai-native.yaml`, `.ai-sdlc/`, `.git/`, and the selected native Agent directory. Raw artifact paths and role subdirectories reject absolute paths, traversal, backslashes, control characters, cross-owner `ai-native/*` placement, case/Unicode-equivalent collisions, and file/directory overlap.

HTML prototypes open in the artifact review dialog with Preview and Source views. Preview runs in a unique-origin iframe sandbox with scripts, external resources, forms, popups, embedded frames, objects, and top-level navigation disabled. Native HTML/CSS states such as `details` and checkboxes remain usable; the full original file stays available in Source view.

Figma output is enabled when the same project-scoped Codex context used by the runner reports either an enabled, accessible Codex Desktop Figma App connector or an enabled official Figma MCP server with OAuth credentials. Before selecting the Figma output, the execution dialog also requires an explicit write target: either choose a writable plan and a filename for a new private Draft, or paste the canonical URL of an existing Figma Design file. When several writable plans are available, the platform never guesses on the user's behalf; View-only seats remain visible but cannot be selected. The Desktop connector is detected through Codex App Server; users who prefer a standalone MCP connection can use the official Codex MCP flow, then choose **重新检测** in the dialog:

```bash
codex mcp add figma --url https://mcp.figma.com/mcp
codex mcp login figma
```

The platform exposes only normalized readiness and plan capability fields; it never returns the raw MCP response, account email, handle, or credentials to the browser. Credential presence and an empty newly created file are not treated as proof of work: a Figma execution succeeds only when the current Codex JSONL contains a completed design mutation against the exact selected file and `figma-handoff.md` contains matching file and node evidence. It must not fabricate a Figma URL.

## Human revisions and local re-runs

Every phase artifact can be opened in the review dialog and adjusted by a human. Saving safely materializes the content back to the registered project file and creates a new append-only revision with an optimistic-lock content hash; the previous revision remains in the audit chain and is marked superseded. Directory artifacts keep their existing file list and are edited through the aggregated `## relative/path` sections. A human revision reopens the phase for review and marks downstream phases pending, rather than silently treating already-approved downstream work as current.

The Run page also derives one **Decisions and follow-ups** inbox from active Product, Design, and Architecture artifacts. It separates three cases: a decision the human must answer, work the current role must finish, and a dependency that must return to an upstream phase. Product, Design, and Architecture cannot approve while this inbox has blocking items. For a legacy Run whose phase was already approved despite a blocker, the page marks the approval as inconsistent instead of treating it as healthy progress. Saving a structured answer appends an auditable `request_changes` review, invalidates downstream phases, and opens the owning role's rerun dialog; the item closes only when that role updates the formal artifact.

Architecture adds a staged checkpoint to prevent rerun loops. Concrete rule gaps such as `ARCH-OBS-002` appear as decision cards with safe presets before option selection is enabled. After Architect materializes the answer, the review reads the current Options artifact and shows A/B/C cards with the recommendation, advantage, and cost. Clicking a card writes the strict current-revision selection marker and opens one Architect continuation; it never silently selects or approves for the human. The completed selected-state pack still requires a separate final approval.

Software Engineer approval additionally validates both structure and semantics: Change Contract acceptance rows and real command results must pass; unfinished tasks, blocked dispositions, unresolved severe/security findings, missing pre-mortem or edge-case-hunter passes, weak provenance links, and contradictory publication claims are rejected. Tier C or Limited stays blocked unless the human approval comment carries the exact seven-line exception contract (header/reason, non-Agent owner, durable reference, affected CC-AC scope, compensating evidence, residual risk, and revisit condition); artifact text cannot grant a waiver.

The Verification card follows the linked-workspace lifecycle: audit the current engineering handoff, map risk, explicitly bind a separate non-nested Linked E2E Workspace when E2E is required, run structured package/browser/server preflight, optionally use Playwright MCP for transient exploration, freeze spec-only intent, let a fresh Tier A/B Test Author write only allowlisted linked-workspace tests/fixtures, obtain human approval of the exact aggregate manifest hash, and then use platform-supervised fixed-argv standalone Playwright with a real headless Chromium. The report binds trusted cwd, product/E2E revisions, exit and evidence hashes. Product source, product-repository tests, and testability interfaces stay Software Engineer-owned; the platform never searches for a sibling or legacy E2E repository.

These Linked E2E bindings, mutation guards, manifest reviews, command events, and semantic gates are Web capabilities. A direct IDE client consumes the same canonical Tester and artifact contract, but it cannot claim the Web's trusted events unless the platform actually produced them. A local pass is never represented as a remote CI pass. CI policy, credentials, retention, branch protection, and required-check configuration remain with a separately authorized human or repository system, not the DevOps Agent.

Release has its own review contract. DevOps consumes the current `change-contract`, `implementation-notes`, `engineering-provenance`, accepted architecture evidence, and `test-report`, then prepares only the task-scoped `release-runbook`. Approval re-resolves the completed execution's current approved input heads, verifies their workspace bytes, and requires the runbook to contain the exact Run ID plus every selected artifact ID, project-relative path, and platform-recorded SHA-256 content hash. Simulated or legacy runner executions cannot be approved as release readiness. The semantic gate also rejects unresolved placeholders, stale or missing revision/digest/provenance bindings, incomplete supply-chain applicability, preconditions, rollout, smoke/health, monitoring threshold/window/owner/action, rollback trigger/RTO/data compatibility/recovery verification, incident escalation, unresolved blockers, or any claim that preparation executed deployment or granted final authority. Passing means `Ready for human go/no-go`; it does not deploy, configure CI or secrets, merge, publish, roll back, or make the decision.

The execution dialog supports output-level local re-runs for every phase. A re-run replaces only the selected artifact heads and carries forward the latest versions of unselected outputs. The runner also receives the current phase snapshots—including human revisions—and recent change-request comments as its modification context. If a previously approved phase is revised or re-run, the workflow becomes active again and downstream phases must be revalidated explicitly.

## Architecture

```text
apps/web        browser UI (Vite, port 5174)
    |
    v
apps/api        project registry, initialization API, and job runner (port 4100)
    | \
    |  +------> local project directories, constrained by allowed roots
    v
PostgreSQL      project and job state (Docker host port 54329)

packages/*      contracts and other code shared by workspace apps
```

The platform API is the application-level coordination boundary for filesystem and command access; it is not an authentication or process-isolation boundary in this V1. The browser never receives database credentials and must not directly read project directories, but a real Codex execution sends the task context needed by the Agent to the configured model service. Keep allowed roots narrow, bind only trusted local projects, use disposable/recoverable state, enable the fake runner only explicitly for tests or deterministic demos, and retain explicit human approval for consequential project changes.

### MVP approval boundary

The human gate controls workflow state: only approved artifact snapshots can be selected by a later role, and a rejected revision is never promoted by a later rerun. Review requests carry the exact artifact head IDs shown to the reviewer, so a stale browser cannot approve a newer unseen revision. The real Codex command currently uses `--dangerously-bypass-approvals-and-sandbox` with the registered project as its working directory so it can create configured outputs and implement code. The runner fail-closes and restores selected-output paths when an execution fails, and protects non-selected artifacts plus project-control resources during a phase, but approval does **not** provide general rollback of all implementation changes or an OS isolation boundary. This remains local/trusted/disposable-only. A production version needs authenticated users plus an isolated Git worktree, container, or staging workspace with apply-only promotion after approval.

Verification adds a workspace mutation detector and rollback layer around that general MVP boundary. During the synchronous runner window it snapshots tracked and untracked files plus directory topology without relying on Git, then restores and rejects protected changes observed by the end scan; discovery or restoration errors fail closed. For a supported repository, the canonical Git top level must equal the registered project root and both the Git directory and common directory must resolve inside it. The project-root `.git` directory—including `HEAD`, config, index, refs, hooks, and logs—is protected like other project control state. A `.git` pointer file is snapshot-protected, but linked worktrees with external metadata and project roots nested below a parent repository are unsupported and blocked before the runner starts because their mutable Git control state cannot be restored inside the registered root.

The selected Run-scoped `test-report` is allowed only as a standalone `.md` report file. Its path must not overlap Git metadata (including a nonstandard in-project git-dir/common-dir or any `.git` component), `ai-native.yaml`, root Agent/environment controls, `.ai-sdlc/`, `.codex/`, `.claude/`, `.github/`, runtime-evidence roots, or snapshot-excluded trees. The only additional retained writes are the project-root runtime evidence trees `test-results/`, `playwright-report/`, and `blob-report/`. The byte snapshot omits these exact dependency/cache/build exclusions: any directory component named `node_modules`, `.pnpm-store`, `.cache`, `.next`, `.nuxt`, `.turbo`, `dist`, `build`, `target`, `coverage`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `__pycache__`, `.gradle`, `.venv`, or `venv`, plus `.yarn/cache/` and `.yarn/unplugged/`. Those technical exclusions may retain ephemeral changes but are not part of approval evidence; authoritative source, tests, role/workflow resources, and project controls must not live there. The same SHA-256 `workspaceRevisionToken` is supplied to the Tester prompt and execution evidence so review can bind the report to the protected pre-run worktree.

Release uses the same detector with a stricter policy: only the selected standalone Markdown `release-runbook` is writable. It has no runtime-evidence roots and no dependency/cache/build snapshot exclusions, so `test-results`, `dist`, `build`, cache trees, dependency stores, virtual environments, and Git metadata are all protected during the synchronous Release window. The 512 MiB/200,000-entry default snapshot bounds fail closed; very large worktrees must use a separately designed isolated runner rather than silently weakening the Release boundary. Release also sets `GIT_OPTIONAL_LOCKS=0`.

These layers are not OS process sandboxes and cannot contain an escaped background or detached descendant that writes after the runner has returned and the end scan has completed. Verification and Release therefore forbid background/detached commands, require every child process to finish before the runner returns, and must be used on disposable or otherwise recoverable project state. Isolated staging/worktree execution with apply-only output promotion remains the production security boundary.

Workflow definitions are currently read from the project's live `ai-native.yaml` for each action. Run creation pins every task-scoped path atomically: `change-contract`, `design-spec`, all seven engineering evidence files, `test-report`, and `release-runbook`. First execution, failures, and later reruns therefore keep the same path even if a configured default basename or directory changes. Legacy runs without a stored pin reuse the latest recorded path for each task-scoped artifact. Freezing the complete definition version per run remains a production-hardening step; avoid changing other workflow configuration while a run is active.

## V1 review evidence

- [Six-role prompt eval](../reviews/workflow-completion-v1/prompt-eval.md)
- [NIST SSDF / OWASP SAMM / SLSA map](../reviews/workflow-completion-v1/sdlc-standards-map.md)

These reviews describe implemented coverage and explicit gaps; they are not a compliance certification or a claim that untrusted execution is safe.

## Repository boundary

`platform/` has its own `package.json`, Yarn configuration, dependency graph, and Docker service. Commands in this directory operate only on the platform workspaces. The repository-root initializer remains the source for newly initialized AI-native projects; its design artifact templates are kept aligned with the platform's selectable Design outputs.
