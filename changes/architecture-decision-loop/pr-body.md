# PR body — Architecture decision loop

## Summary

- replace the generic Architecture rerun loop with a concrete OBS-002 decision card;
- show current A/B/C options as one-click comparison cards after blockers close;
- record selection against current Discovery/Options heads and open one Architect continuation;
- accept safe legacy option-heading variants while enforcing canonical new output;
- incrementally backfill only Architect support files in FE-cc.

## Verification

- Initializer 3/3; platform 541/541; platform typecheck/build pass.
- FE-cc test 5/5, lint, and build pass.
- Live-page smoke test confirmed the concrete card and staged UX.
- Formal FE-cc Architecture artifact hashes remained unchanged.

## Provenance and authority

- Spec: `changes/architecture-decision-loop/delta.md`
- Session: `sessions/architecture-decision-loop/session-log.md`
- Tests: `changes/architecture-decision-loop/test-evidence.md`
- Review: `reviews/architecture-decision-loop/review.md`
- PR published by Agent: No
- Merge performed by Agent: No
- Release performed by Agent: No
- Human decisions recorded by this change: No

