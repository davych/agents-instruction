# Tester Playwright E2E workflow — verification evidence

## Status

- State: Pass
- Isolation tier: Tier A for the acceptance-contract test
- Independence: a fresh subagent authored `test/tester-e2e-workflow.test.js` from the user requirements and public repository contracts before the implementation was available. It did not receive or inspect the later implementation diff.
- Initial red state: 6 pass / 7 fail, exposing the absent/mismatched Tester reference, workflow detail, and Web guidance.
- Final state: every focused, root, and platform check passed. Final acceptance, CI policy, merge, and release remain human-owned.

## Acceptance coverage

| Criterion | Evidence | Result |
|---|---|---|
| AC-TESTER-001 | Independent root README contract test checks evidence-pack meaning, review order, real diff, and approve/return action | Pass |
| AC-TESTER-002 | Independent README test distinguishes initialized Run artifacts from `changes/`, `sessions/`, and `reviews/` | Pass |
| AC-TESTER-003 | Initializer fixture compares installed Tester workflow/reference with canonical sources and rejects a Tester `SKILL.md` | Pass |
| AC-TESTER-004 | Independent content test rejects MCP exploration as repeatable gate evidence | Pass |
| AC-TESTER-005 | Independent content test requires a fresh Tier A/B, spec-only intent contract and excluded implementation/exploration context | Pass |
| AC-TESTER-006 | Contract and runtime checks require Software Engineer integration/reapproval, reject and restore tracked/untracked source/test/control/Git mutations, inject only a strictly parsed current marked request as bounded feedback, and retire stale markers | Pass |
| AC-TESTER-007 | Independent content test requires standalone `playwright test`, current revision, result, and durable evidence with no MCP | Pass |
| AC-TESTER-008 | Independent content test separates Tester command/report ownership from DevOps required-check configuration | Pass |
| AC-TESTER-009 | Semantic and provenance tests bind the current report head to a real successful Verification execution, one canonical project-root command, workspace/Git revision, AC/REG coverage, and hashed evidence; adversarial cases cover stale/human heads, invented IDs, ambiguous shell, false E2E-no, missing evidence, and MCP-only proof | Pass |
| AC-TESTER-010 | Independent registry/document test checks the fixed six phases, unchanged artifact registry, W01-W21 graph, node details, and return loops | Pass |
| AC-TESTER-011 | `testing-workflow.check.ts` checks the three-stage Web guidance before execution/review and rejects MCP-only proof | Pass |
| AC-TESTER-012 | `task-artifact-paths.check.ts` checks stable Run scoping and pinning across a later config-path change | Pass |
| AC-TESTER-013 | Independent 13/13, guard 40/40, provenance 27/27, root 16/16, platform 574/574, typecheck, build, package, and diff checks | Pass |

## Commands and results

| Command | Result |
|---|---|
| `node --test --test-reporter=dot test/tester-e2e-workflow.test.js` | 13/13 pass; independently authored contract suite |
| `yarn exec node --import tsx --test apps/api/checks/verification-workspace-runner.check.ts` | 40/40 pass; arbitrary nested, mode, symlink, topology, Git, selected-output, and fail-closed restoration cases |
| `yarn exec node --import tsx --test apps/api/checks/verification-evidence-provenance.check.ts` | 27/27 pass; current execution, canonical command/cwd, Git/workspace revision, and evidence-hash binding cases |
| `yarn exec node --import tsx --test apps/api/checks/verification-evidence-provenance.check.ts apps/api/checks/verification-evidence-workflow-service.check.ts apps/api/checks/tester-e2e-crystallization-workflow-service.check.ts` | 75/75 pass; combined provenance, semantic approval, and bounded feedback cases |
| `npm test` | 16/16 pass |
| `yarn typecheck` | Pass |
| `yarn test` | 574/574 pass |
| `yarn build` | Pass; existing Vite chunk-size warning only |
| `npm pack --dry-run --cache /private/tmp/ai-sdlc-pack-cache-tester-e2e-final` | Pass, 81 files; Tester workflow and E2E reference included. A task-local cache avoids an unrelated historical ownership problem in the user's default npm cache. |
| `git diff --check` | Pass |

## Scope boundary

This repository defines and installs the workflow; it is not the target application from the checkout-coupon example. No Playwright dependency was added and no fabricated browser run was claimed. A real initialized target must discover and execute its own repository command and retain its own report/trace evidence. A pre-upgrade Run whose persisted report already uses a shared legacy basename remains pinned for non-destructive compatibility; new Runs are isolated. If two old Runs share the file, neither Run may rerun Verification—sequentially or concurrently—until an authorized per-Run backfill gives both distinct pinned paths.

The workspace guard protects and restores synchronous mutations observed during the runner window, with explicit size/entry limits and documented dependency/cache/build exclusions. It is not an OS process sandbox, so detached/background processes are prohibited and the runner must use disposable or recoverable state. Remote CI URL/run IDs are structurally and revision validated but are not provider-authenticated without a CI connector.
