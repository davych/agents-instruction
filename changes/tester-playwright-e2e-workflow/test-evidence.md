# Tester Playwright E2E workflow — verification evidence

## Status

- State: Pass
- Original acceptance isolation: Tier A for AC-TESTER-001 through AC-TESTER-013. A fresh test-authoring subagent derived the contract suite from the user requirements before seeing the implementation diff. Its initial red state was 6/13 pass and 7/13 fail.
- Linked-workspace isolation: Tier B for AC-TESTER-014 through AC-TESTER-020. A fresh spec-only verifier froze an adversarial matrix before repository inspection, reproduced path-traversal, missing-target-preflight, UI fail-open, npm-lifecycle, and provenance URL-binding defects, then independently re-ran the fixed implementation.
- Implementation-authored focused checks are corroborating regression evidence; they are not represented as independent acceptance authorship.
- Final independent verdict: Pass, with no remaining P1/P2 in the supported POSIX local-execution scope.
- Final acceptance, script approval, CI policy, merge, and release remain human-owned.

## Acceptance coverage

| Criterion | Automated test path and test name | Durable evidence | Result |
|---|---|---|---|
| AC-TESTER-001 | `test/tester-e2e-workflow.test.js` :: `AC-TESTER-001: root guidance explains how one generated engineering evidence pack is reviewed` | `node --test test/tester-e2e-workflow.test.js` | Pass |
| AC-TESTER-002 | `test/tester-e2e-workflow.test.js` :: `AC-TESTER-002: root guidance separates Run deliverables from repository development evidence` | `node --test test/tester-e2e-workflow.test.js` | Pass |
| AC-TESTER-003 | `test/tester-e2e-workflow.test.js` :: `AC-TESTER-003: initializer installs one ordinary Tester role pack without a duplicate Skill or Agent` | `npm test` | Pass |
| AC-TESTER-004 | `test/tester-e2e-workflow.test.js` :: `AC-TESTER-004: Playwright MCP exploration is optional diagnostic work and never gate evidence by itself` | `node --test test/tester-e2e-workflow.test.js` | Pass |
| AC-TESTER-005 | `test/tester-e2e-workflow.test.js` :: `AC-TESTER-005: crystallization freezes AC intent in a fresh Tier A or B spec-only session` | `node --test test/tester-e2e-workflow.test.js` | Pass |
| AC-TESTER-006 | `platform/apps/api/checks/e2e-automation-runner.check.ts` :: `fresh Test Author is ephemeral, spec-only, and applies only tests/fixtures with hashes` | focused Linked E2E command below | Pass |
| AC-TESTER-007 | `platform/apps/api/checks/e2e-automation-runner.check.ts` :: `real automation uses fixed npm scripts, supervises the server, and hashes durable evidence` | `changes/tester-playwright-e2e-workflow/artifacts/real-chromium-smoke.json` | Pass |
| AC-TESTER-008 | `test/tester-e2e-workflow.test.js` :: `AC-TESTER-008: Tester owns the E2E contract while DevOps or the repository owner owns the required CI check` | `node --test test/tester-e2e-workflow.test.js` | Pass |
| AC-TESTER-009 | `platform/apps/api/checks/verification-evidence-provenance.check.ts` :: legacy, linked, tamper, revision, command, cwd, and evidence-hash cases | focused Linked E2E command below | Pass |
| AC-TESTER-010 | `test/tester-e2e-workflow.test.js` :: `AC-TESTER-010: the documented workflow has a detailed Mermaid graph, node table, failure loops, and no seventh phase` | `node --test test/tester-e2e-workflow.test.js` | Pass |
| AC-TESTER-011 | `platform/apps/web/checks/testing-workflow.check.ts` and `verification-e2e-panel.check.ts` :: Tester lifecycle and state-aware actions | `yarn test` from `platform/` | Pass |
| AC-TESTER-012 | `platform/apps/api/checks/task-artifact-paths.check.ts` :: Run-scoped test-report and persisted-path pinning | `yarn test` from `platform/` | Pass |
| AC-TESTER-013 | root, platform, typecheck, build, package, and diff gates listed below | command results below | Pass |
| AC-TESTER-014 | `platform/apps/api/checks/e2e-workspace-service.check.ts` :: safe initialization and raw traversal/nonempty/nested/symlink/out-of-policy rejection | focused Linked E2E command below | Pass |
| AC-TESTER-015 | `platform/apps/api/checks/e2e-automation-runner.check.ts` :: supervised target preflight, browser launch, HTTP timeout, and cleanup | `changes/tester-playwright-e2e-workflow/artifacts/real-chromium-smoke.json` | Pass |
| AC-TESTER-016 | `platform/apps/api/checks/e2e-automation-runner.check.ts` :: ephemeral spec-only Test Author and allowlisted full-suite manifest | focused Linked E2E command below | Pass |
| AC-TESTER-017 | `platform/apps/api/checks/verification-e2e-workflow-service.check.ts` :: DB review authority, latest-wins, stale/tamper/cross-Run rejection | focused Linked E2E command below | Pass |
| AC-TESTER-018 | `platform/apps/api/checks/e2e-automation-runner.check.ts` :: real target probe, fixed argv, durable success/failure evidence, timeout, and process-group cleanup | `changes/tester-playwright-e2e-workflow/artifacts/real-chromium-runner-manifest.json` | Pass |
| AC-TESTER-019 | `platform/apps/api/checks/verification-evidence-provenance.check.ts` :: dual revision, exact URL/cwd, script and evidence re-hash | focused Linked E2E command below | Pass |
| AC-TESTER-020 | `platform/apps/web/checks/verification-e2e-panel.check.ts` and `platform/apps/api/checks/verification-e2e-workflow-service.check.ts` :: one state-aware UI path and sticky linked obligation | `yarn test` from `platform/` | Pass |

## Real-browser smoke

The final temporary platform-runner fixture used `@playwright/test 1.62.1` to launch Chromium `151.0.7922.34`, navigate to `http://127.0.0.1:43137/`, receive HTTP 200, run the Playwright suite with exit code 0, and stop the supervised server with `sigterm`. The temporary product/E2E directories were deleted after the sanitized manifests were retained.

This is real-browser evidence for the platform runner itself, not acceptance evidence for any user's product. A product Run still needs AC-specific Playwright scripts and evidence against that product revision.

## Commands and results

| Command | Result |
|---|---|
| `node --test test/tester-e2e-workflow.test.js` | 20/20 pass |
| `yarn workspace @ai-sdlc/api exec node --import tsx --test checks/e2e-workspace-service.check.ts checks/e2e-automation-runner.check.ts checks/verification-e2e-coordinator.check.ts checks/verification-e2e-workflow-service.check.ts checks/verification-evidence-provenance.check.ts` | 93/93 pass |
| `npm test` | 23/23 pass |
| `yarn test` from `platform/` | 683/683 pass |
| `yarn typecheck` from `platform/` | Pass |
| `yarn build` from `platform/` | Pass; existing Vite chunk-size warning only |
| `npm pack --dry-run --cache /private/tmp/ai-sdlc-pack-cache-linked-e2e-final` | Pass; 81 files, 148.5 kB packed, 468.7 kB unpacked |
| `git diff --check` | Pass |

## Scope and residual boundaries

- The explicitly linked workspace is initialized from a new empty directory and is never inferred from or connected to a legacy sibling E2E project.
- The workspace guard is synchronous rollback protection, not an OS sandbox. POSIX process-group and port cleanup are verified; Windows has no equivalent descendant-tree coverage in this change, but retained port occupancy fails closed.
- The script-review payload is bounded to 200 kB and must show the complete executable `tests/**` and `fixtures/**` baseline.
- Dependency/browser preparation is an explicit operator action and may require network access. Remote CI identity is not provider-authenticated without a CI connector.
- No commit, push, PR, merge, deploy, or release was performed.
