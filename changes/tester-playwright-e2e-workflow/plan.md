# Tester Playwright E2E workflow — implementation plan

## Strategy

Keep the six-phase and artifact ownership model intact. Add an ordinary Tester role pack, make the evidence boundary explicit in the test-report contract, surface the operating sequence in documentation and Web guidance, and reuse the existing task-path resolver for Run-scoped reports.

## Vertical slice

1. A human reviews the Software Engineer evidence pack in the documented order and either returns a concrete gap or approves Implementation.
2. Tester maps authoritative criteria and risks, optionally explores the runnable UI with Playwright MCP, and records that exploration as diagnostic only.
3. If durable E2E coverage is selected, the human explicitly configures a separate linked E2E workspace; the platform never scans for or adopts a sibling legacy repository.
4. The platform freezes intent from approved specification evidence and launches a fresh Test Author in only the linked E2E root. Product source stays read-only and implementation/exploration context is excluded.
5. The human reviews the complete executable `tests/**` and `fixtures/**` baseline and approves its exact manifest hash through a platform-owned review event. This approves executable test code only, not Verification, release, merge, or CI configuration.
6. The platform performs dependency/browser/start-script readiness, rejects an already occupied loopback target, supervises the current product server, launches real headless Chromium from the linked root with fixed argv, and persists target, command, exit, cleanup, report, trace, screenshot, and hash evidence.
7. Tester writes the Run-scoped `test-report` from the machine execution evidence and routes failures to the owning role. Verification approval binds the product and E2E revisions, the successful command event, evidence hashes, AC/regression mapping, and open gaps.
8. DevOps or the authorized repository owner enforces the applicable repository suite as a required CI check; when E2E applies, it reuses the standalone command. A human retains release approval.

## Constraints

- Do not add, remove, or reorder a global phase.
- Do not change role ownership of repository source and test integration.
- Do not add a Tester client-native Skill or second canonical Agent.
- Do not register exploration notes as a Web artifact.
- Do not require Playwright for a Run where risk-based test design selects another valid evidence level.
- Do not add Playwright to the product repository or this initializer repository. The explicitly initialized linked E2E workspace owns its Playwright package and lockfile; dependency/browser installation remains an explicit human setup action.
- Do not execute newly generated E2E code before its exact manifest hash receives a separate human script review.
- Do not let a linked Run fall back to an ordinary Tester report after Linked E2E has been selected; it must finish with a current successful linked execution.
- Do not accept raw shell commands from Web/API. Persist only validated package-manager and script identifiers, and spawn fixed argv with `shell: false`.
- Do not infer an E2E root by name, sibling location, repository history, or legacy documentation.
- Preserve existing persisted artifact paths when a Run already has a `test-report` revision.
- Treat the workspace guard as synchronous rollback, not a process sandbox: prohibit background/detached commands and require disposable or recoverable project state.
- Do not claim provider-authenticated remote CI proof without a provider connector.

## Verification

- Independent structural tests derived from the acceptance criteria before implementation.
- Root initializer install/content checks.
- Focused Web guidance and API task-path checks.
- Root and platform full regression, typecheck, build, package dry-run, and `git diff --check`.
