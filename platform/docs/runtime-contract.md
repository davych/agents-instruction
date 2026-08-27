# Platform runtime contract

This document defines the behavior the local AI SDLC Platform adds around the canonical six-phase workflow. For installation and daily commands, start with the [Platform README](../README.md). For phase ownership and impact routing, see [End-to-End Workflow](../../guidelines/workflow/README.md). For artifact resolution, see [Configuration](../../guidelines/configuration/README.md).

The platform coordinates local execution and records evidence. It does not transfer product, architecture, risk, merge, deployment, or release authority from humans to Agents.

## Shared workflow, different execution guarantees

Direct IDE clients and the Web platform consume the same:

- six canonical role bodies;
- fixed phase owners;
- registered artifact IDs;
- owner-aware path rules;
- role procedures and output templates.

The native client selected during initialization controls the files installed for GitHub Copilot, Claude Code, or Codex discovery. Real Web jobs always use the local Codex runner.

Only the Web platform can claim events it actually persisted, including:

- impact clearances and current-Run imports;
- artifact head and review history;
- selected-output execution contracts;
- task-and-Run path pins;
- Architecture selection checkpoints;
- Linked E2E Workspace bindings;
- staging-author manifests and exact-hash reviews;
- trusted command events and semantic-gate results.

A direct IDE session may follow the same artifact schema but has no Web execution contract. It uses the bounded human-supplied execution brief and registered basename paths defined by the shared workflow, and must not invent or claim Web guarantees.

## Project initialization and registration

An existing-project registration requires an initialized project with `ai-native.yaml`. Registration stores platform metadata and never reruns the initializer.

For a new project, the API invokes the repository initializer with the selected native client and registers the project only after initialization succeeds. The filesystem success is the commit point. A later client disconnect does not cancel durable registration work; if the response is uncertain, reload the project list before retrying.

The initializer remains create-only, preflights every destination, rejects conflicts, symlink parents, and path escape, and cleans up transaction-owned files after a normal failure or cancellation. Crash recovery verifies ownership before removing remnants and fails closed when bytes or identities cannot be proven. It is not an in-place upgrader or a general merge tool.

## Real and fake execution

Real jobs require the configured `AI_SDLC_CODEX_BIN`. The default timeout is 30 minutes and can be changed with `AI_SDLC_CODEX_TIMEOUT_MS`.

Before each real phase run, the execution dialog reads the account- and project-scoped Codex model catalog. The user chooses a supported model and reasoning effort for that execution. The resolved values are passed to `codex exec`, stored with the execution, and shown in its timeline.

Optional server controls are:

- `AI_SDLC_CODEX_MODELS`;
- `AI_SDLC_CODEX_REASONING_EFFORTS`;
- `AI_SDLC_CODEX_DEFAULT_MODEL`;
- `AI_SDLC_CODEX_DEFAULT_REASONING_EFFORT`.

`AI_SDLC_CODEX_FAKE=1` is for tests and deterministic demonstrations. Fake output may exercise state transitions and artifact handling, but it cannot satisfy a real Implementation, Verification, or Release evidence requirement.

## Artifact identity, paths, and selected outputs

Artifact ID is the stable identity. Physical paths are resolved from `ai-native.yaml`, the artifact owner's role config, and the active execution contract. They must stay beneath `paths.outputs`, inside the owner's configured namespace where one exists, outside project-control and native Agent paths, and non-overlapping with other artifacts.

For platform-created Runs, the following physical files are pinned with a safe task title and full Run ID:

- `change-contract`;
- `design-spec`;
- all seven engineering evidence artifacts;
- `test-report`;
- `release-runbook`.

The pin survives failures and reruns even if a configured default basename changes later. A rerun replaces only selected artifact heads and carries forward the latest unselected heads. The runner snapshots other registered artifacts and project controls and rejects or restores unauthorized changes according to the applicable workspace policy.

Older persisted paths are not silently migrated. If two pre-upgrade Runs share one legacy `test-report` path, do not rerun Verification for either Run until an authorized explicit backfill gives each Run a separate pinned report path.

## Human revisions and downstream invalidation

Every phase artifact can be reviewed and edited by a human. A save:

1. checks the expected current content hash;
2. writes the registered project file;
3. appends a new immutable revision;
4. marks the previous head superseded;
5. reopens the phase and invalidates affected downstream approvals.

Directory artifacts are edited through their aggregated relative-path sections while preserving the file list. A stale browser cannot approve an unseen newer head because reviews bind the exact artifact head IDs shown to the reviewer.

The Run-level **Decisions and follow-ups** inbox distinguishes:

- a decision only a human can make;
- incomplete work that stays with the current role;
- a dependency that must return to an upstream phase.

A human answer is stored in review history and reopens the owning phase. The item closes only when the owner updates the formal artifact; a review comment alone does not silently clear a gate.

## Design outputs and Figma

The first Design execution includes the required `design-baseline` and `design-spec`. A user may additionally select a self-contained `design-prototype` HTML file and `figma-handoff`. Later runs may select only outputs that need regeneration.

Prototype preview uses a unique-origin sandbox. Scripts, external resources, forms, popups, embedded frames, objects, and top-level navigation are disabled; the original source remains reviewable.

Figma output is available only when the project-scoped Codex context reports an accessible Codex Desktop Figma connector or official Figma MCP connection. The user must select a writable plan/new private Draft or provide the canonical URL of an existing writable Figma Design file. The platform does not guess a plan or fabricate a URL.

Figma success requires a completed design mutation against the selected file plus matching file/node evidence in `figma-handoff`. Credential presence or an empty created file is not proof of completed work. The browser receives normalized readiness and plan capabilities, not raw connector responses or account credentials.

## Architecture checkpoint

Full Architecture uses separate review moments:

1. Resolve concrete blocking decision cards.
2. Run the bootstrap execution for the index, discovery context, and Options.
3. Let a human select one current option against the exact Options revision.
4. Run the selected-state continuation for C4, ADR, pattern, NFR, and adversarial evidence.
5. Review and accept the completed pack separately.

Selecting an option is not final Architecture approval. A changed rulebook digest, checkpoint revision, or blocking rule invalidates the old selection evidence.

## Implementation review

Software Engineer changes the real repository and emits the seven registered engineering evidence artifacts. Platform approval checks current source and evidence rather than treating Markdown as implementation.

The gate rejects unfinished tasks, missing or failed command evidence, unresolved severe or security findings, incomplete adversarial review, weak provenance, contradictory publication claims, and stale upstream inputs. Tier C or Limited independent-test isolation stays blocked unless the human review contains the complete scoped exception contract and compensating evidence. Artifact prose cannot grant its own exception.

Passing Implementation unlocks Tester. It does not publish or merge a pull request.

## Verification and Linked E2E

Tester first maps acceptance criteria, regressions, deferred Design checks, NFRs, and risks to the strongest appropriate evidence. A criterion proven more directly by unit, integration, or contract testing need not become E2E.

When durable E2E is required, the Web contract is:

1. A human explicitly binds a separate, non-nested Linked E2E Workspace. The platform never scans for or adopts a sibling or legacy repository.
2. Structured preflight validates the binding, package manager and script identifiers, Playwright package, configured Chromium executable and real launch probe, product start script, loopback target, evidence paths, and cleanup capability.
3. Playwright MCP may be used for transient exploration. Its transcript, DOM dump, and generated actions do not enter the Test Author context and cannot satisfy the gate.
4. The platform freezes spec-only AC and risk intent.
5. The platform copies the linked workspace to an ephemeral staging workspace and starts a fresh Tier A/B Test Author there.
6. The author sees only approved behavior, frozen intent, and the minimum public harness. It may change only allowlisted test and fixture paths and does not execute the new scripts.
7. The platform validates the staged changes and promotes only the validated allowlisted files back to the unchanged linked root. Product files and control paths remain protected.
8. From the linked root, the platform enumerates and re-hashes the complete promoted executable suite, including unchanged test and fixture files. A human approves that exact baseline and aggregate hash; any relevant byte, file set, binding, product revision, or E2E revision change invalidates approval.
9. After script approval, the platform supervises the product server and runs fixed-argv standalone Playwright from the linked root with the configured real headless Chromium.
10. Tester records product/E2E revisions, trusted command and cwd, exit result, cleanup, and report/trace/screenshot/video/log hashes in the Run-scoped `test-report`.

Script approval authorizes only execution of those exact bytes. It does not approve Verification, CI policy, merge, risk, or Release. A local pass is not a remote CI pass.

Product source, product-repository tests, and testability interfaces remain Software Engineer-owned. A defect in those assets returns through Implementation evidence refresh and reapproval. A linked test-script defect stays in the staging-author, promotion, complete-baseline-review, and standalone-execution loop.

An authorized human or repository/provider system configures credentials, browser provisioning, retention, branch protection, CI policy, and required checks. Tester supplies the command/evidence contract; DevOps may record the expected required-check name and missing provider evidence in the runbook but does not configure it.

## Release readiness

DevOps consumes the current Change Contract, applicable accepted Architecture evidence, `implementation-notes`, `engineering-provenance`, and `test-report`, then prepares only the Run-scoped `release-runbook`.

The Web Release gate requires a real execution and re-resolves current approved input heads. The runbook must bind:

- the exact Run ID;
- every selected artifact ID, project-relative path, and platform-recorded SHA-256;
- source/product revision and build or release identity;
- provenance and supply-chain applicability;
- preconditions and ordered rollout;
- health, smoke, and monitoring signal/threshold/window/owner/action;
- rollback trigger, RTO, data compatibility, recovery, and verification;
- incident escalation, risks, blockers, and the named human release owner.

Fake or legacy runner executions, stale inputs, placeholders, missing evidence, and claims that preparation executed an external action are rejected. Passing means only `Ready for human go/no-go`.

DevOps does not configure CI or required checks, use secrets, change branch policy, commit, push, publish or merge a PR, deploy, roll back, publish a release, accept risk, or decide go/no-go. Those actions require a separately authorized human or external system.

## Related documentation

- [Repository overview](../../README.md)
- [Platform operator guide](../README.md)
- [Platform security model](security-model.md)
- [End-to-End Workflow](../../guidelines/workflow/README.md)
- [Configuration and artifact paths](../../guidelines/configuration/README.md)
- [Role and Prompt layers](../../guidelines/roles/README.md)
