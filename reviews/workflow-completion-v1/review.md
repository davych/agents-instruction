# Workflow completion V1 — seven-lens and adversarial review

## Verdict

Ready for human review and first-version use inside the documented local, trusted, disposable or recoverable-project boundary. Final independent replay found no reproducible P0 or P1. The fixed six phases, owners, canonical Agent sources, and human release authority remain intact. Remote, multi-user, or untrusted-project operation is **not approved**: authentication, credential isolation, network policy, and an isolated runner are still security-architecture gates.

The frozen verification snapshot passes root 33/33, Contracts 24/24, Web 90/90, API 734/734, platform aggregate 848/848, typecheck, production build, npm dry-run packaging with 85 files, patch hygiene, and the tracked-deletion audit.

## 1. Behaviour preservation

No open blocker. Discovery, Design, Architecture, Implementation, Verification, and Release remain in their original order with owners PM / BA, Designer, Architect, Software Engineer, Tester, and DevOps. The six canonical role bodies still come only from `templates/agents/`; initialization renders exactly one client-native set. No phase, owner, Agent, registered artifact, initialized-project content, or unrelated tracked file was removed.

Legacy projects remain readable through in-memory compatibility backfills. New Release semantics activate only for a substantively complete DevOps V1 pack, and old owner-qualified Release paths normalize without rewriting project-owned YAML.

## 2. Hidden assumptions

No hidden blocker remains in the claimed boundary. The work now states rather than assumes that:

- direct IDE and Web operation share role/artifact contracts but not the same supervised evidence guarantees;
- Web always executes through the local Codex runner even when initialization renders Claude Code or GitHub Copilot Agents;
- Release prepares a runbook for a later human decision and never proves that a provider deployed anything;
- CLI publication is crash-recoverable and outcome-transactional, not simultaneously visible as one multi-file commit;
- HTTP cancellation cannot reverse an already-started database commit, so an uncertain response is reconciled by refreshing the project list.

## 3. Spec and architecture drift

No open finding. The implementation follows `changes/workflow-completion-v1/delta.md` without adding a seventh phase, changing owners, duplicating a client-specific Skill, introducing DDL, or silently upgrading initialized projects. DevOps adds evidence preparation, monitoring, rollback, incident handling, and human go/no-go readiness inside the existing Release phase.

The prompt review and standards map separately record deliberate non-changes: authentication/container isolation, risk acceptance, branch policy, remote provider trust, retirement governance, and model-sampled CI evals require explicit human architecture or operating decisions.

## 4. Confirmation without evidence

No open blocker. Release approval re-resolves the current trusted Run and selected-input manifest and compares structured path/hash cells exactly. It rejects stale or wrapped bindings, missing digests, placeholders, incomplete monitoring/rollback, simulated execution, any non-human owner field, and contradictory past, present, or future Agent deployment/go-no-go claims.

Verification and Linked E2E continue to require trusted runner events, exact revisions, reviewed script manifests, real Chromium evidence where applicable, durable hashes, and successful cleanup. Markdown prose, MCP exploration, an exit code alone, or a copied local record cannot substitute for those events.

## 5. Test independence

No open finding. Spec-first Tier A acceptance tests were authored separately from implementation inspection and cover Release evidence, generic acceptance-authority fallback, mutation rollback, prompt bounds, Web client initialization, and commit boundaries. A separate reviewer repeatedly replayed reported failures against the latest snapshot and discarded findings that no longer reproduced.

The final evidence does not overclaim three paid/authenticated IDE model runs, remote CI/provider authenticity, or a production deployment. Those remain explicit test gaps rather than inferred passes.

## 6. Security surface

No open P0/P1 within local/trusted V1. Owner/output-root path validation, control/native-Agent protection, Release/Verification full-tree restoration, Git lock suppression, exact evidence binding, create-only initialization, and inode-plus-content rollback checks all fail closed in the covered cases.

The guards are still synchronous detection and rollback, not an OS sandbox. Check/use races, concurrent external writers, detached processes, parent-directory swaps, project-external effects, credentials, and network access require process isolation before remote or untrusted use. This is an explicit NO-GO boundary, not accepted production risk.

## 7. Over-engineering

No open finding. The solution reuses the existing Node test runner, TypeScript, Zod, YAML, React, Fastify, PostgreSQL store, artifact registry, six phases, role packs, and Web review model. No runtime framework or dependency was added. Detailed procedures live in progressive-disclosure Markdown packs instead of expanding or duplicating the six client-facing role prompts.

The Release semantic validator and workspace guards are intentionally strict because they gate authority and persistent workspace changes. Authentication, containers, provider connectors, a seventh phase, an in-place upgrader, and model-sampled CI evals were not smuggled into this first version.

## Resolved finding register

| ID | Severity | Finding | Resolution and evidence | Status |
|---|---|---|---|---|
| WF-REV-001 | High | Artifact paths could escape owner namespaces or overlap controls. | Raw-segment, owner-root, output-root, control/native-Agent, Unicode/case, nested-path, symlink, and collision checks now fail before execution. | Resolved |
| WF-REV-002 | High | Web initialization did not prove three-client/six-role parity. | The client is explicit; loader verifies client directory and all six regular native files; fresh Codex, Claude Code, and Copilot cases pass. | Resolved |
| WF-REV-003 | High | Sequential initializer writes and signal/crash windows could leave unretryable state or delete external replacements. | Create-only staged publication, canonical journal recovery, signal commit point, stable inode/hash deletion, and same-inode external-edit preservation are covered by real child-process tests. | Resolved |
| WF-REV-004 | High | Runtime directory creation could precede a symlink-boundary check. | Runtime paths are validated before creation and fail closed on output-parent symlinks. | Resolved |
| WF-REV-005 | High | Generic legacy acceptance prose could displace approved executable Story criteria. | Generic text is filtered; stable approved authority wins; absence of executable criteria blocks Implementation. | Resolved |
| WF-REV-006 | High | Release evidence trusted self-asserted prose, substring bindings, and incomplete owner checks. | Structured current Run/path/hash equality, complete human-owner validation, authority-claim rejection, and semantic positive/negative tests now gate persistence. | Resolved |
| WF-REV-007 | High | Release reused a Verification guard that left generated/runtime-evidence write holes. | Dedicated Release mode protects source, controls, Git, generated output, caches, and runtime evidence while permitting only the selected runbook. | Resolved |
| WF-REV-008 | High | A partial or superficial DevOps pack could change legacy gate behavior. | Versioned capability plus substantive comment-stripped config/workflow/runbook validation rejects missing, padded, or low-information packs. | Resolved |
| WF-REV-009 | High | Workspace bytes could outlive a failed persistence commit. | Selected and non-selected artifact snapshots restore on runner or database failure; focused service tests cover the rollback. | Resolved |
| WF-REV-010 | High | Wide Markdown tables made mobile review actions unreachable; review could pass unseen heads. | Local table scrolling, responsive actions, current-head viewing progress, dirty/pending guards, and 650×900/320×720 browser checks close the interaction failure. | Resolved |
| WF-REV-011 | Medium | Malformed successful API payloads silently became empty UI state. | Core collection/entity responses validate fail-closed and surface `INVALID_API_RESPONSE` with retry UI. | Resolved |
| WF-REV-012 | Medium | Browser Back/Forward could leave URL and rendered review state inconsistent after a cancelled dirty exit. | Indexed restoration plus real Back and Forward dirty-cancel inspection restore URL, title, DOM, dialog, and draft in ordinary app-managed history. | Resolved in covered navigation; mixed/unknown entries remain a test gap |
| WF-REV-013 | Medium | A late disconnect after successful filesystem initialization could strand an unregistered project. | Successful initialization is the filesystem commit point; registration then completes despite cancellation, with Tier A coverage and explicit uncertain-INSERT reconciliation copy. | Resolved |

## Adversarial pass

### Pre-mortem

| ID | Plausible failure | Detection/evidence | Required action | Status |
|---|---|---|---|---|
| WF-ADV-PM-001 | A generated runbook claims the Agent deployed, approved, or owns a release decision. | Structured owner-table validation and multilingual past/future authority-claim negatives. | Keep final go/no-go and execution external to every Agent. | Resolved |
| WF-ADV-PM-002 | A successful Release/Verification run leaves source, Git, control, build, cache, or runtime-evidence mutations. | Full-tree before/after snapshots, restoration tests, and dedicated Release mode. | Preserve fail-closed bounds; move to an isolated runner before untrusted use. | Resolved within local/trusted scope |
| WF-ADV-PM-003 | An initializer abort deletes a file that another tool edited in place without changing its inode. | Stable content hashing during commit and rollback plus the same-inode regression. | Preserve externally changed bytes and return an aggregate recovery error. | Resolved |
| WF-ADV-PM-004 | An incomplete DevOps backfill silently enables or disables Release validation. | Capability version, required files/sections, visible-token checks, and legacy full-path replay. | Continue incremental, reviewed backfills; never infer completeness from filenames alone. | Resolved |
| WF-ADV-PM-005 | A reviewer approves a stale or never-opened artifact on a narrow screen. | Current ID/hash viewing ledger, optimistic locking, local table containment, and disabled approval. | Re-review every changed head; never carry viewing state across revisions. | Resolved |

### Edge-case-hunter

| ID | Edge condition | Expected and verified behaviour | Evidence | Status |
|---|---|---|---|---|
| WF-ADV-EC-001 | Absolute/traversal paths, Unicode/case collisions, nested artifacts, symlinked roots, `ENOTDIR`, or client-directory mismatch. | Definition load or runtime creation rejects with stable errors before unsafe writes. | Definition-loader, project-path, and workspace checks. | Resolved |
| WF-ADV-EC-002 | SIGINT/SIGTERM before commit, a signal after commit, SIGKILL with a journal, or SIGKILL before canonical marker publication. | Pre-commit rolls back; post-commit reports success; verified journal recovers; unverifiable pre-marker remnants are preserved and block retry for manual review. | Root initializer checks 13/13. | Resolved with documented manual boundary |
| WF-ADV-EC-003 | Release path/hash is wrapped as a substring, a duplicate current UUID appears in its legitimate task path, or an AI/model is named in any owner table. | Exact structured equality accepts the legitimate duplicate current ID and rejects foreign/wrapped bindings or non-human authority. | Release validator/runner/service replay. | Resolved |
| WF-ADV-EC-004 | HTML comments, headings, or repeated filler make a DevOps pack look complete. | Comment-stripped substantive token checks reject the pack as invalid. | Loader/fake/legacy replay 33/33. | Resolved |
| WF-ADV-EC-005 | User cancels dirty review through Back or Forward; viewport is 320 px with a very wide table. | App restores the rendered route/draft; table scrolls locally; approval remains reachable. | Real in-app browser and Web checks 90/90. | Resolved in covered cases |

## Residual boundaries

| ID | Priority | Boundary | Consequence and disposition |
|---|---|---|---|
| WF-RES-001 | P2 | An HTTP disconnect racing an already-started project INSERT cannot undo the database transaction. | Response outcome can be uncertain; UI and docs require a project-list refresh before retrying. Non-blocking for local V1. |
| WF-RES-002 | P2 | Path validation and workspace snapshots have check/use windows and do not isolate background/concurrent processes or effects outside the project. | Remote/untrusted use remains NO-GO pending an authenticated isolated worktree/container runner and credential/network policy. |
| WF-RES-003 | P2 | Release/Verification snapshot protection is bounded to 512 MiB and 200,000 entries. | Oversized repositories fail closed; benchmark and redesign with the isolated runner rather than silently raising limits. |
| WF-RES-004 | P3 | A crash before the canonical transaction marker exists leaves unverifiable hidden staging. | The next init preserves it and refuses before prompting; a human must inspect/remove it. |
| WF-RES-005 | P3 | No authenticated live model run was performed in all three IDE clients; no real provider deployment/CI trust, large-tree benchmark, multi-process stress, or mixed/unknown browser-history automation was run. | Static/native-format tests, full local suites, and ordinary real-browser navigation support V1; these gaps remain explicit follow-up work. |
| WF-RES-006 | P3 | Release authority checks necessarily parse constrained Markdown and natural-language claims. | Structured required fields are authoritative and adversarially covered; retain negative corpora and migrate external provider facts to signed structured events when connectors exist. |

## Human decision boundary

This review recommends readiness only for the stated local/trusted first version. It does not approve a security exception, remote exposure, generated scripts for a future Run, Verification, merge, npm publication, provider action, deployment, rollback, or final release.
