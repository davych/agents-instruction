# AI Project Scratchpad

This file is the short, durable orientation guide for AI agents working in this repository. Read it before changing workflow contracts, artifact rules, or platform state transitions.

## What this project is

`create-ai-native-sdlc` is both:

1. A Node.js initializer that installs an AI-native delivery workflow into another project.
2. A local Web/API platform that runs and reviews that workflow with Codex, PostgreSQL, and project files.

The goal is not to make every role run for every request. The platform preserves human-reviewable evidence while routing each change through only the Product, Design, and Architecture work it actually needs.

## Repository map

```text
bin/                         initializer CLI
templates/                   canonical files copied into initialized projects
guidelines/                  human-facing workflow and role documentation
test/                        initializer tests
platform/
  apps/api/                  Fastify API, workflow state, filesystem and Codex runner
  apps/web/                  React/Vite/Tailwind workflow UI
  packages/contracts/        shared strict request/response and workflow schemas
```

Important entry points:

- `templates/ai-native.yaml`: canonical phase, artifact, input, and output graph.
- `platform/packages/contracts/src/index.ts`: public data contracts.
- `platform/apps/api/src/services/workflow-service.ts`: application-level workflow orchestration.
- `platform/apps/api/src/db/store.ts`: transactional PostgreSQL state transitions.
- `platform/apps/api/src/domain/workflow.ts`: phase/output/selection invariants.
- `platform/apps/api/src/domain/change-routing.ts`: Change Contract routing invariants.
- `platform/apps/web/src/pages/project-page.tsx`: project and Run creation.
- `platform/apps/web/src/pages/run-page.tsx`: phase execution, Impact Check, review, and feedback UI.

## Workflow model

The six fixed phases remain:

```text
Discovery -> Design -> Architecture -> Implementation -> Verification -> Release
```

Every new Run begins with an immutable, task-scoped `change-contract` artifact. It records work type, current and expected behavior, scope, acceptance criteria, regression scope, risks, and evidence references.

The first three phases support evidence-backed routing:

| Phase | Modes | Meaning |
|---|---|---|
| Product / Discovery | `direct`, `reuse`, `partial`, `full` | Use only the Change Contract; reuse approved product evidence; update selected product outputs; or run PM/BA normally. |
| Design | `skip`, `reuse`, `partial`, `full` | Prove no design work; reuse an approved design baseline; update selected design outputs; or run Designer normally. |
| Architecture | `skip`, `reuse`, `partial`, `full` | Prove no architecture work; reuse an approved pack; update selected architecture outputs; or run Architect normally. |

`direct`, `skip`, `reuse`, and `partial` are persisted as auditable phase resolutions. `full` is normal role execution and is audited by the execution itself; it is deliberately not a PhaseResolution.

A bounded bug or technical change may take this fast path:

```text
Change Contract -> Product direct -> Design skip -> Architecture skip -> Implementation
```

That path is allowed only when the structured contract and evidence references justify it. Verification still consumes the contract and must run targeted regression checks.

## Artifact and approval rules

- Artifacts have append-only revisions in PostgreSQL and corresponding files in the registered project workspace.
- Downstream roles may consume only current, approved upstream artifact heads.
- The API validates database snapshots against physical workspace content before execution, reuse, and consequential review actions.
- `reuse` clones approved heads with provenance; it does not ask Codex to regenerate equivalent documents.
- `partial` protects every output outside `affectedOutputKeys` and requires genuine refreshed revisions before approval.
- `skip` and Product `direct` are explicit reviewed decisions, never silent missing artifacts.
- Human edits and upstream revisions invalidate downstream phases. A stale route cannot remain silently active.
- The task-scoped Change Contract is immutable and can never be selected as a Codex output.
- Legacy Runs without a Change Contract remain executable through a compatibility definition; do not silently synthesize new approval evidence for them.

## Architecture-specific behavior

A full Architecture run is intentionally two-stage:

1. Produce `architecture`, discovery context, and options; a human selects an option.
2. Produce the selected-state C4 context/container diagrams, ADR directory, patterns, NFRs, and adversarial review.

Architecture rules use an index plus conditionally loaded domain packs under:

```text
templates/shared/.ai-sdlc/roles/architect/references/rules/
```

The packs cover API, data, integration, security, observability, and frontend constraints. They are references, not registered workflow artifacts. Required-mode projects use machine-readable rulebook blocks and approval validation; do not weaken this to prompt-only enforcement.

## Change-routing design intent

- A new feature usually needs new or changed user stories, but not necessarily a rewritten project PRD.
- A local product change should reuse the last approved product baseline and update only affected PRD/story outputs.
- Existing designs should be reused or partially updated; a backend-only bug can skip Design with evidence.
- Existing architecture packs should be reused or partially updated; do not duplicate nearly identical ADRs and patterns per request.
- Project-level baselines and task-level evidence are different concepts. Preserve source Run, source phase, source artifact IDs, selected inputs, rationale, affected outputs, route version, and decision time.
- If an upstream change invalidates a previous resolution after the phase already has history, the safe current behavior is a full rerun. Do not invent a new partial attempt without an explicit attempt/epoch state model.

## Development commands

Initializer, from repository root:

```bash
npm test
npm pack --dry-run
```

Platform, from `platform/`:

```bash
corepack enable
yarn install
yarn typecheck
yarn test
yarn build
yarn db:up
yarn dev
```

The Web app defaults to `http://localhost:5173`; the API defaults to `http://localhost:4100`. Real executions require Codex. Set `AI_SDLC_CODEX_FAKE=1` only for deterministic development and tests.

## Rules for future AI changes

1. Keep templates, shared contracts, API state transitions, Web behavior, documentation, and tests aligned. A prompt-only change is not enough for a hard workflow invariant.
2. Preserve unselected artifact bytes and reject scope violations transactionally.
3. Treat non-null but invalid persisted JSON as corruption and fail closed.
4. Derive routable inputs and outputs from the loaded workflow definition; avoid fixed artifact-key assumptions except for explicit semantic anchors such as `change-contract`, `design-spec`, and the architecture index.
5. Do not register rule reference packs as workflow outputs.
6. Do not let a `full` choice auto-approve a phase. It must execute the corresponding role.
7. Add both service-level and store-level tests for authorization, concurrency, provenance, and partial-scope boundaries.
8. Before handoff, run root tests, platform tests, platform typecheck/build, and `git diff --check`.

## Current validation baseline

At the time this scratchpad was introduced:

- API checks: 166 passing.
- Web checks: 43 passing.
- Shared contract checks: 15 passing.
- Initializer checks: 3 passing.
- Platform typecheck and production build pass.
- npm dry-run packaging includes the Change Contract template and architecture rule packs.
