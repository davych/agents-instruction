# Workflow completion V1 — Session log

## Task and fixed boundaries

- Complete the first usable six-role workflow after Tester, adversarially review all material initializer/platform/Web paths, evaluate every canonical prompt, compare the workflow with secure SDLC guidance, and update documentation.
- Preserve the exact phase order `discovery -> design -> architecture -> implementation -> verification -> release` and owners `pm-ba`, `designer`, `architect`, `software-engineer`, `tester`, `devops`.
- Preserve `templates/agents/` as the single canonical Agent source. Do not add client-specific Skills or rewrite initialized projects.
- Do not make authentication, OS sandboxing, credential isolation, deployment, merge, publication, DDL, or risk-acceptance decisions on behalf of the human owner.

## Context used

- Hot: `AGENTS.md`, `changes/workflow-completion-v1/delta.md`, current tests, package scripts, and executable role/platform contracts.
- Warm: `context/warm/workflow-completion-v1.md`, all six canonical role prompts and directly loaded workflows, Web/API/contracts boundaries, and existing role guides.
- Cold: `context/cold/workflow-completion-v1-decisions.md`, NIST SSDF, OWASP SAMM, SLSA, and official OpenAI eval/prompt guidance.

## Ordered work record

1. Established a clean baseline: root initializer tests, package dry-run with an isolated npm cache, platform typecheck/tests/build, and repository status.
2. Wrote the spec delta and acceptance criteria before implementation.
3. Ran three independent audits in parallel: platform/security/compatibility, six-role prompt and SDLC design, and Web interaction/accessibility.
4. Classified security-sensitive architecture choices as human-owned. The V1 remains limited to local, trusted, disposable or recoverable projects because the API is unauthenticated and the real runner bypasses approvals and OS sandboxing.
5. Completed DevOps V1: canonical Agent, role config/workflow, runbook template, Release graph inputs, task-scoped output, fake-runner fixture, Web guidance, and a capability-gated semantic approval validator.
6. Hardened definition loading and initialization: owner/output-root path boundaries, raw-segment/control-path/collision checks, regular role config/native Agent checks, three-client Web selection, create-only exclusive per-file publication, abort propagation, and rollback of only initializer-owned output.
7. Hardened execution state: pre-`mkdir` runtime path checks, selected-output rollback across database persistence failure, complete prompt manifests with hashes and explicit preview truncation, common control protection, and full-workspace read-only guards for Verification and Release.
8. Fixed the loaded-definition compatibility path so older projects remain readable and the new Release validator activates only when the complete DevOps V1 pack exists.
9. Fixed Web interaction defects: narrow-screen Markdown containment, single-column mobile actions, pending/dirty close policy, current-head viewing progress, architecture comment preservation, route scroll/focus/title, Release wording, and fail-closed parsing for core API responses.
10. Reproduced and fixed three guard-order regressions. The Architecture-specific rulebook error contract and Verification path-specific workspace errors now remain stable while the common protection layer stays in place.
11. Performed real browser checks at 650x900 and 320x720. The Review dialog no longer expands to Markdown max-content width; wide tables scroll locally, and the mobile approval action is horizontally and vertically reachable.
12. Updated all twelve README surfaces and their Mermaid diagrams, preserving the fixed six phases and documenting IDE/Web capability differences and the local-only security boundary.
13. Dispatched spec-first independent acceptance tests and a separate seven-lens/adversarial review. The first pass found generic acceptance-criteria false positives, Release field parsing gaps, legacy capability ambiguity, Release workspace write holes, stale self-asserted evidence, initialization races/crash residue, a compatibility output collision, and navigation/cancellation gaps.
14. Remediated the first-pass findings with executable contracts: current Run and selected-input path/hash bindings, real-execution-only Release readiness, a strict Release workspace mode, versioned DevOps capability markers, owner-aware legacy path normalization, provenance-aware platform backfill collision blocking, stable `ENOTDIR` handling, and route/create cancellation guards.
15. Added a create-only initialization journal. Content is staged and synced before exclusive hard-link publication; completed files are removed only after stable regular-file, inode, and content-hash checks, while an incomplete initializer-owned write remains safely removable by its recorded inode. The next invocation validates and recovers an interrupted dead-owner transaction. Modified, replaced, malformed, active-owner, or ambiguous remnants are preserved and fail closed. This is not described as simultaneous multi-file visibility.
16. Re-ran the complete root and platform suites. An intermediate API run correctly rejected two stale minimal fixtures that copied the fresh Release capability declaration without its pack; the fixtures were explicitly marked legacy and the full suite was rerun without weakening production validation.
17. Re-dispatched the independent reviewer after each repair batch and required current-snapshot replays rather than carrying forward findings from intermediate code.
18. Replaced Release prose/substrings with structured exact current Run/path/hash binding, applied explicit-human ownership to every owner field and evidence table, and rejected contradictory past, present, or future Agent deployment/go-no-go claims. Normal fake and complete Release paths remained valid.
19. Strengthened DevOps capability discovery so comments, padded headings, low-information filler, missing native Agents, owner-path symlinks, old full paths, and platform-backfill collisions cannot masquerade as a complete current pack.
20. Closed initializer commit and rollback races: cooperative pre-commit signals cleanly roll back; post-commit signals report success; same-inode external edits are hash-detected and preserved; unverifiable pre-marker crash remnants fail closed for manual inspection.
21. Re-exercised the review dialog in the real in-app browser at 650×900 and 320×720 and verified dirty-draft cancellation for both Browser Back and Forward. Wide Markdown tables remain locally scrollable and approval actions reachable.
22. Defined the Web project-creation commit boundary. Cancellation remains effective before CLI filesystem commit; after a successful initializer return, registration completes despite a late disconnect so a valid initialized tree is not stranded. An already-started database insert is explicitly refresh-and-reconcile, not a claimed distributed rollback.
23. Recorded the frozen command ledger, browser measurements, adversarial cases, client evidence, residual boundaries, and final independent seven-lens verdict in `reviews/workflow-completion-v1/independent-test-evidence.md` and `reviews/workflow-completion-v1/review.md`.

## Alternatives rejected or deferred

- Adding a seventh Security/Operations phase: rejected; obligations remain within existing owners or route to a new/reopened Run.
- Treating direct IDE and Web operation as identical: rejected; they share role/artifact contracts, while only Web can produce persisted clearances, semantic gates, mutation guards, and supervised Linked E2E events.
- Enabling Release validation for every legacy project: rejected; it would impose a new schema on project-owned older prompts and templates.
- Claiming path guards make the real runner safe for untrusted repositories: rejected; they are synchronous detection/rollback controls, not process isolation.
- Adding authentication/container execution, a shared prompt-injection trust policy, risk-adaptive architecture floors, or an in-place upgrader: deferred for explicit security/architecture/workflow-owner decisions.
- Adding a required model-sampled eval to CI: deferred until model, credentials, budget, sampling, and flake policy are approved. Deterministic prompt contracts remain the V1 gate.

## Verification ledger

Final commands, pass counts, isolation tiers, browser measurements, and residual gaps are recorded in `reviews/workflow-completion-v1/independent-test-evidence.md` and `reviews/workflow-completion-v1/review.md`.

## Outcome

The repository now has a coherent local/trusted V1 from Discovery through Release preparation, native initialization for three IDE clients, Web orchestration through the Codex runner, task-scoped release evidence, human go/no-go boundaries, responsive review interaction, and synchronized guidance. It is not represented as an authenticated, isolated, remote, or untrusted-project execution service.
