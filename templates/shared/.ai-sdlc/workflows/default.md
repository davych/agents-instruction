# Default workflow

Use `ai-native.yaml` as the source of truth and work in this order:

1. The platform or human creates one immutable, task-scoped `change-contract` for the Run.
2. Product Impact records `direct`, `reuse`, `partial`, or `full`; PM / BA runs only for `partial` or `full` and does not rewrite the Change Contract.
3. Design Impact records `skip`, `reuse`, `partial`, or `full`; Designer runs only for `partial` or `full` and keeps the design baseline project-wide and design specs task-scoped.
4. Architecture Impact records `skip`, `reuse`, `partial`, or `full`; Architect runs only for `partial` or `full`.
5. After all three clearances pass, Software Engineer implements the confirmed work in the repository and delivers the complete seven-artifact engineering evidence pack: `implementation-notes`, `implementation-plan`, `implementation-tasks`, `engineering-session-log`, `engineering-test-evidence`, `engineering-review`, and `engineering-provenance`.
6. Tester consumes the applicable `design-spec` (including every `deferred_validations` obligation), `implementation-notes`, `engineering-test-evidence`, and `engineering-review` alongside the Change Contract, acceptance criteria, risks, and regression obligations. Playwright MCP is optional transient exploration. When E2E is required, a human explicitly binds a separate Linked E2E Workspace; the platform freezes spec-only intent, a fresh Test Author writes only in that linked root, a human approves the exact generated-script manifest hash, and the platform executes standalone Playwright with a real headless Chromium. Product source and product-repository tests remain Software Engineer-owned and read-only during Verification. Tester then creates the Run-scoped test report with product/E2E dual provenance.
7. DevOps binds the current Change Contract, implementation provenance, architecture evidence, and Test Report into a repeatable release, monitoring, rollback, and incident-escalation runbook. It may document required-check expectations, but only an authorized human or system configures CI or executes the release.

Start artifacts from `.ai-sdlc/templates/`. Resolve every input and output artifact in this order:

1. Find the artifact in `ai-native.yaml` and read its `owner` and `path`.
2. Start with `paths.outputs` from `ai-native.yaml`.
3. If `.ai-sdlc/roles/<owner>/config.yaml` exists, append that role's `output.subdirectory`.
4. Append the artifact `path`.

For a platform-managed task, use the resolved paths in the active execution contract after applying the steps above. In particular, `change-contract`, `design-spec`, all seven registered engineering evidence artifacts, and `test-report` receive task-scoped filenames derived from the task title and run ID; never replace them with configured default basenames or a cross-Run “latest” file. The optional engineering replay packet and Tester exploration notes are not registered and are not part of the Web phase gate. The Change Contract is an immutable human artifact. A local re-run may select only part of a phase's outputs, so every unselected output must remain unchanged.

The phase inputs in `ai-native.yaml` declare the complete evidence vocabulary. The platform's recorded disposition and active execution contract resolve the concrete input alternative for a Run. A valid `direct`, `skip`, or `reuse` clearance can therefore satisfy a phase without manufacturing empty PRDs, stories, design specs, or Agent executions. Older initialized projects that do not list `change-contract` are extended by the platform without rewriting their project-owned YAML.

## Impact routing

- Product `direct`: the Change Contract and an authoritative expected-behavior reference are sufficient; run no PM / BA Agent.
- Product `reuse`: import approved PRD/story revisions with provenance; run no PM / BA Agent.
- Product `partial`: import the baseline and let PM / BA update only selected PRD/story outputs.
- Product `full`: create or comprehensively revise PRD and stories for a new or materially changed product model.
- Design `skip`: record evidence that no interface, interaction, copy, responsive, or accessibility behavior changes; run no Designer.
- Design `reuse`: import approved design evidence that exactly covers the Run; run no Designer.
- Design `partial`: update only affected design outputs; keep inherited outputs unchanged.
- Design `full`: create the task-scoped design contract for a new journey or material experience model, reusing the project baseline where valid.
- Architecture `skip`: for a bounded bug or technical task with no architecture impact, record an explicit waiver and run no Architect.
- Architecture `reuse`: import the accepted pack with provenance and run no Architect.
- Architecture `partial`: update only declared pack outputs while preserving the selected direction.
- Architecture `full`: use the normal options, human selection, and selected-state pack flow.

`skip`, `direct`, and `reuse` skip role execution, not review evidence. Unknown impact is never grounds for skipping. If implementation reveals a product, design, or architecture impact that the current disposition excluded, invalidate downstream clearance and reassess that phase before continuing.

The platform-managed Architect phase has an explicit selection checkpoint. Its first execution requires only `architecture`, `architecture-discovery-context`, and `architecture-options`. A human records exactly one documented choice in a `request_changes` review using an independent line `Selected option: <ID>` against the current options revision. Only then does the next execution unlock `architecture` plus the six selected-state outputs. The phase cannot be approved until every registered Architect output exists and every selected-state output was refreshed after that review. The platform rejects attempts to select C4, ADR, pattern, NFR, or adversarial outputs before valid selection evidence exists.

Always use the artifact owner's config, not the active role's config. The global output root always comes from `ai-native.yaml` and defaults to `docs/`.

An artifact path may name one file or a directory. When it names a directory, read only the files required by that artifact's role contract. Start architecture work and every downstream architecture handoff at the `architecture` index, then follow its active links instead of scanning the whole output tree. Child architecture artifacts listed as phase inputs declare the exact evidence that role needs; they never override the index status or make a pending item active.

Meet the phase gate in `ai-native.yaml` before moving forward. Record handoff evidence in the active task file.

## Human and machine language

Use `project.locale` for explanatory prose. Keep artifact IDs, stable requirement/blocker IDs, enum values, JSON/YAML keys, exact validator headings, selection markers, sentinels, hashes, and other machine-contract tokens in their canonical form; do not translate or paraphrase them. When localized prose and a machine token disagree, stop and repair the contract instead of guessing.

## E2E evidence lifecycle

The three E2E stages and their readiness/script-review checkpoints are a Verification subflow, not new global phases:

0. **Linked workspace and readiness** — E2E-required Runs use only a human-configured separate, non-nested allowed root plus loopback target, validated package-manager/start/test scripts, Playwright package, configured Chromium executable, and a real headless launch probe. The platform never searches for or adopts a sibling or legacy E2E repository.
1. **Exploration** — Tester may operate the runnable app with Playwright MCP to diagnose the path. The session is optional and transient; “MCP ran through” cannot pass repeatable acceptance or CI evidence by itself, and its transcript/code never enters the author context.
2. **Crystallization and script review** — The platform freezes AC-mapped intent from approved evidence and launches a fresh Tier A/B Test Author only in the Linked E2E Workspace, without product implementation or exploration context. The author records an exact file manifest and hashes but does not execute it. A human must approve the current aggregate manifest hash before those bytes may run; this does not approve Verification or Release.
3. **Execution** — The platform supervises the product server and invokes the linked project's real standalone Playwright wrapper with fixed argv, `shell: false`, and a real headless Chromium. Tester records the trusted linked cwd, exit, report/trace/screenshot hashes, and both product and E2E revisions in `test-report`. CI never depends on MCP; DevOps or an authorized owner configures the required check.

Only a failure requiring product source, product-repository test, or product testability-interface changes returns to Software Engineer for an evidence refresh and Implementation reapproval. Linked-workspace test bugs stay in the fresh-author and manifest-hash-review loop. The normal linked-workspace path never requires a handwritten crystallization review marker.

Read `.ai-sdlc/roles/tester/workflow.md` and its Playwright reference for selector policy, data safety, evidence fields, and failure routing.

## Release evidence lifecycle

Release remains the sixth fixed phase and is owned by DevOps. Start at the immutable Change Contract, then bind the exact current Run and every selected upstream artifact ID/project-relative path/platform-provided content hash, the current Implementation and Verification revisions, `engineering-provenance`, applicable accepted Architecture evidence, and the release artifact identity/digest when one exists. A valid Architecture `skip` or `reuse` clearance is evidence; never create placeholder architecture files merely to satisfy an input list.

DevOps starts from `.ai-sdlc/roles/devops/workflow.md` and `.ai-sdlc/templates/release-runbook.md`. It records the trusted input binding manifest, provenance and SBOM applicability, preconditions, ordered rollout, health/smoke checks, monitoring threshold/window/owner/action, rollback trigger/RTO/data compatibility/recovery verification, incident escalation, risks, and the human release owner. Required unknowns, placeholders, stale revisions, failed or blocked Verification, and unverified critical recovery steps keep the runbook `Blocked`. In the Web path, a fake or legacy Release execution can be reviewed as a simulation but cannot be approved as readiness.

Preparing or validating a runbook does not authorize deployment, rollback, production migration or smoke execution, CI/required-check changes, secret/environment changes, branch-policy changes, commit, push, PR/release/artifact publication, risk acceptance, or final go/no-go. Those actions remain with a separately authorized human or system. Operational feedback routes to the existing owning phase or creates a new Run; it never creates a seventh phase.

## Bug fast path

A bounded bug can proceed as `Product: direct → Design: skip or reuse → Architecture: skip or reuse → Software Engineer → Tester`. Architecture `skip` is an explicit waiver for a bug or technical task with no boundary, API/schema, data, integration, security, NFR, deployment, or operational impact; use `reuse` when an accepted pack exists and applies. This path still requires an immutable Change Contract, an authoritative expected-behavior source, observable fix criteria, reproduction evidence when available, and targeted regression evidence. Verification is never skipped for a production-code change.
