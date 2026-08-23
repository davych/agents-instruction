# Tester Playwright E2E workflow — implementation plan

## Strategy

Keep the six-phase and artifact ownership model intact. Add an ordinary Tester role pack, make the evidence boundary explicit in the test-report contract, surface the operating sequence in documentation and Web guidance, and reuse the existing task-path resolver for Run-scoped reports.

## Vertical slice

1. A human reviews the Software Engineer evidence pack in the documented order and either returns a concrete gap or approves Implementation.
2. Tester maps authoritative criteria and risks, optionally explores the runnable UI with Playwright MCP, and records that exploration as diagnostic only.
3. If a durable E2E test is missing, Tester returns the gap to Software Engineer. A fresh Tier A/B authoring session freezes intent from the specification, produces the repository test, and refreshes engineering evidence.
4. The platform snapshots the protected synchronous Verification tree, rejects and restores unauthorized tracked/untracked source, test, control, and in-project Git changes outside the exact documented exclusions, and carries a current marked crystallization request to the later Engineer rerun as bounded read-only feedback.
5. Tester runs the integrated test with one canonical standalone command, records traceable evidence in the Run-scoped `test-report`, and routes failures to the owning role. Verification approval binds the current report head to the real successful execution, exact project-root command, workspace/Git revision, hashed local evidence, AC/regression mapping, open gaps, and any remote CI claim.
6. DevOps or the authorized repository owner enforces the applicable repository suite as a required CI check; when E2E applies, it reuses the standalone command. A human retains release approval.

## Constraints

- Do not add, remove, or reorder a global phase.
- Do not change role ownership of repository source and test integration.
- Do not add a Tester client-native Skill or second canonical Agent.
- Do not register exploration notes as a Web artifact.
- Do not require Playwright for a Run where risk-based test design selects another valid evidence level.
- Do not add Playwright to this initializer repository; target projects must use their real existing runner or obtain explicit dependency approval.
- Preserve existing persisted artifact paths when a Run already has a `test-report` revision.
- Treat the workspace guard as synchronous rollback, not a process sandbox: prohibit background/detached commands and require disposable or recoverable project state.
- Do not claim provider-authenticated remote CI proof without a provider connector.

## Verification

- Independent structural tests derived from the acceptance criteria before implementation.
- Root initializer install/content checks.
- Focused Web guidance and API task-path checks.
- Root and platform full regression, typecheck, build, package dry-run, and `git diff --check`.
