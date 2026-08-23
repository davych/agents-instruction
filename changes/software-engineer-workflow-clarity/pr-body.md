# Software Engineer workflow clarity — PR provenance

## Summary

Present Implementation as a four-step flow, explain all seven evidence artifacts in plain language, replace normal-path document choices with automatic bundles, prioritize three human-facing review documents over four audit-detail records, stop internally blocked inputs before Codex execution, route blockers to their owning roles, render semantic approval failures as ordered recovery actions, recognize stable acceptance criteria from approved selected User Stories in legacy Runs, and add a structured cross-phase human-decision inbox with capture, downstream invalidation, and role rerun.

## Evidence links

- Spec: `changes/software-engineer-workflow-clarity/delta.md`
- Plan: `changes/software-engineer-workflow-clarity/plan.md`
- Tasks: `changes/software-engineer-workflow-clarity/tasks.md`
- Session log: `sessions/software-engineer-workflow-clarity/session-log.md`
- Tests: `changes/software-engineer-workflow-clarity/test-evidence.md`
- Review: `reviews/software-engineer-workflow-clarity/review.md`

## Provenance

- Context: canonical Software Engineer role pack, API review service, User Story snapshot parser, Web phase/execute/review UI, reported FE-cc Run, and current platform database state.
- Verification: focused decision/readiness/routing checks, root 3/3, platform 389/389, typecheck, build, package dry-run, diff check, and real-target resolver/readiness/decision/Git probes.
- Isolation: Limited, disclosed; no human exception claimed.
- Known limitation: the existing target evidence remains Blocked until the newly visible Product answers, Designer verification, and Architecture decisions are materialized into formal artifacts and real implementation plus tests are generated. The target also retains an unrelated tracked `eslint.config.js` diff from the repeated execution; this platform change does not silently revert project-owned work.

## Publication boundary

- PR published by Software Engineer: No
- Merge performed or approved by Software Engineer: No
- Deploy or release performed or approved by Software Engineer: No
