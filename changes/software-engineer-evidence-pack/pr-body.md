# Software Engineer evidence pack — PR provenance

## Summary

Replace the Software Engineer placeholder with a canonical policy Agent, project-native role workflow, seven Run-scoped Web-reviewable evidence outputs, semantic approval validation, hardened execution boundaries, legacy compatibility, and an incremental FE-cc backfill.

## Provenance

- Tool/model: Codex primary agent with implementation-blind testing and separate code-review subagents; the exact backend model version is not exposed to repository evidence.
- Context loaded: `AGENTS.md`, stack/testing context, gap log, user course extract, delta/plan/tasks, Architect integration precedent, platform contracts/API/Web/tests, and FE-cc target state.
- Verification gates: Tier A independent tests; validator 176/176; runner 15/15; focused engineering regression 238/238; root 3/3; platform 370/370 plus typecheck/build; FE-cc lint, 5/5 tests, build, and seven-path loader smoke.
- Human decisions: none made by the Software Engineer. Product scope, architecture/security exceptions, verification waivers, merge, and release remain human-owned.
- Known limitations: failed real executions restore protected evidence/control resources but do not transactionally revert source/test edits; no live model execution was launched in FE-cc during the backfill smoke.
- Session duration: not automatically measured; no fabricated duration is asserted.
- SDD approach: Brownfield delta with preserved behavior, ADDED/MODIFIED/REMOVED inventory, REMOVED audit, smallest complete vertical slice, frozen independent tests, seven-lens review, and adversarial pass.

## Evidence links

- Spec: `changes/software-engineer-evidence-pack/delta.md`
- Plan: `changes/software-engineer-evidence-pack/plan.md`
- Tasks: `changes/software-engineer-evidence-pack/tasks.md`
- Session log: `sessions/software-engineer-evidence-pack/session-log.md`
- Tests: `changes/software-engineer-evidence-pack/test-evidence.md`
- Review: `reviews/software-engineer-evidence-pack/review.md`

## Publication boundary

- PR published by Software Engineer: No
- Merge performed or approved by Software Engineer: No
- Deploy or release performed or approved by Software Engineer: No
