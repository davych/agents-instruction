# Session log: scoped engineering profiles

## Inputs

- Spec: `changes/scoped-engineering-profiles/delta.md`
- Context: `AGENTS.md`, `docs/context/stack.md`,
  `docs/context/architecture.md`, `docs/context/testing.md`
- Cold gap record: `context/cold/gap-log.md`

## Decisions already authorized

- Initialization selects developer responsibility, not technology.
- Architect-only delivery repositories do not initialize developer agents.
- Architect first use creates scoped profiles in the delivery repository.
- Code repositories may initialize one frontend/backend/full-stack agent or two
  separate specialists, then read delivery artifacts through the bridge.
- Each code repository has one stable repository ID for exact catalog matching;
  technology selection still remains outside initialization.
- Backward compatibility is intentionally not required for schema v1.

## Work log

- Created the acceptance delta and layered context bundle before implementation.
- Created branch `codex/scoped-engineering-profiles` from a clean `main` worktree.
- Parallelized CLI/schema work, role and profile templates, and Tier A black-box
  acceptance tests. The independent test author received the delta and public
  interface but did not inspect `bin/cli.js`.
- Implemented schema-v2 role profiles, scoped developer rendering, external
  Architecture hosts, stable repository identity, scoped artifact routes, and
  clean rejection of legacy metadata.
- Added the technology catalog, frontend/backend child templates, Architect
  first-use branches, developer scope fragments, and shared engineering
  discipline.
- Updated applicable legacy tests without retaining schema-v1 migration
  behavior. Final focused results: init 43/43, scoped acceptance 16/16, update
  34/34.
- First adversarial pass found and drove fixes for unknown and nested duplicate
  configuration fields, JSON member-order sensitivity, bridge-incompatible
  relative child paths, interactive duplicate-scope handling, and false update
  success after a concurrent managed-file change.
- Later adversarial passes drove fixes for non-canonical role order, conflicting
  developer identities, unsafe scope paths, preflight-unchanged concurrent file
  changes, missing Architect code-host registration, repository identity and
  Unicode confusables, greenfield sources not yet created, multi-deployable
  selection, and separate-agent shared-file ownership.
- Removed the redundant `--engineer-mode`: `frontend,backend` now directly
  creates two specialists while `fullstack` creates one agent.
- Independent usability exercises covered Architect-only, standalone frontend,
  standalone backend, monorepo full-stack, and monorepo separate paths.

## Final verification

- `npm test`: 93 tests passed, 0 failed.
- `node --test test/scoped-engineering.test.js test/update.test.js`: 50 tests
  passed, 0 failed.
- `npm pack --dry-run`: the first attempt was blocked by root-owned files in the
  user's global npm cache; the same command passed with an isolated temporary
  `npm_config_cache`, packaging 40 files.
- `node --check bin/cli.js`: passed.
- `git diff --check`: passed.
