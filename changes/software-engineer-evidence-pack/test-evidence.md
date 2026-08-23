# Software Engineer evidence pack — independent test evidence

## Status

- State: Pass
- Isolation tier: Tier A
- Test author: implementation-blind subagent `independent_tests`
- Requirements visible while authoring: `changes/software-engineer-evidence-pack/delta.md` and the agreed public artifact/validator/UI contracts
- Implementation visible while authoring: No
- Test intent: frozen before each targeted run; implementation was changed only after the subagent reported exact black-box failures
- Later implementation access: None; fixture corrections used failure output and public template contracts only

## Acceptance coverage

| Acceptance criteria | Primary executable evidence |
|---|---|
| AC-ENG-001, AC-ENG-002 | `test/init.test.js`; Agent, role pack, upstream clearances, single-Agent/no-Skill, and Tester handoff assertions |
| AC-ENG-003 | `test/init.test.js`, `platform/apps/api/checks/workflow.check.ts`, `platform/apps/web/checks/phase-output-selection.check.ts` |
| AC-ENG-004 | `platform/apps/api/checks/task-artifact-paths.check.ts` |
| AC-ENG-005 | `platform/apps/api/checks/definition-loader.check.ts`, legacy Web output-selection checks, FE-cc loader smoke |
| AC-ENG-006 | `platform/apps/web/checks/engineering-evidence-ui.check.ts`, `phase-output-selection.check.ts` |
| AC-ENG-007 | `platform/apps/api/checks/engineering-evidence-validator.check.ts`, `engineering-evidence-workflow-service.check.ts` |
| AC-ENG-008 | `platform/apps/api/checks/engineering-evidence-runner.check.ts` |
| AC-ENG-009 | FE-cc role/template/Agent byte comparison and seven-path loader smoke |
| AC-ENG-010 | Root and platform full checks plus FE-cc lint/test/build |
| AC-ENG-011 | Brownfield delta assertions and REMOVED-audit validator cases |
| AC-ENG-012 | Agent boundary assertions, adversarial review/provenance validator cases, and Tester handoff checks |

## Focused commands and results

| Command | Result |
|---|---|
| `npm test` | 3/3 pass |
| `yarn exec node --import tsx --test apps/api/checks/engineering-evidence-validator.check.ts` | 176/176 pass |
| `yarn exec node --import tsx --test apps/api/checks/engineering-evidence-runner.check.ts` | 15/15 pass |
| `yarn exec node --import tsx --test apps/api/checks/engineering-evidence-workflow-service.check.ts` | 1/1 pass |
| Focused API/Web engineering checks | 238/238 pass |
| `yarn typecheck` | Pass |
| `yarn test` | 370/370 pass |
| `yarn build` | Pass |
| FE-cc `npm run lint` | Pass |
| FE-cc `npm test` | 5/5 pass |
| FE-cc `npm run build` | Pass |
| `git diff --check` | Pass |

## Failure classification and resolution

- Implementation bugs: approval accepted negated/skipped results, weak waivers, contradictory provenance, incomplete review findings, incomplete isolation metadata, unsafe legacy path fallback, control/resource mutations, permission-only changes, environment symlinks, and legacy Web partial selection. Each was reproduced by a frozen test and is now locked by a passing case.
- Test bugs: legacy fixtures assumed one output or the old three-column evidence format, and several early assertions over-constrained basename/envelope wording. Fixtures were corrected to the public canonical templates without weakening the behavior under test.
- Pre-existing regression harness bug: the Figma plan stub omitted the current `codex_apps=ready` startup notification. One test-only notification fixed the three deterministic timeouts; the Figma file passes 30/30.
- Specification ambiguity: none remains for the delivered scope.

## Coverage gaps and residual risk

- No live browser click-through was required because the existing generic Web execution/review surface is covered at the selection, label, description, contract, and service layers.
- FE-cc was smoke-tested through its real loader, lint, tests, and production build; an actual implementation Run was not launched because that would invoke a model and create project evidence rather than merely validate the backfill.
- Real source/test writes are not transactionally rolled back after every failed Codex execution. Protected workflow/evidence/control resources are restored and the limitation is explicit in `context/cold/gap-log.md`.

## Conclusion

All twelve acceptance criteria have passing independent or full-regression evidence. The evidence supports a ready-for-human-review conclusion; it does not publish a PR, approve a merge, or authorize release.
