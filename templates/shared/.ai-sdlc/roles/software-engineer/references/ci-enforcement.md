# CI enforcement and project checks

Local hooks improve feedback speed; shared required checks enforce the team gate. A hook result is not a substitute for the required CI-equivalent command set because hooks may be absent, skipped, or tool-specific.

## Discover commands from evidence

Use the repository's current manifests, lockfiles, build configuration, CI workflows, and contributor instructions to identify commands. Prefer existing scripts and focused checks. Do not paste illustrative commands such as `pytest` or `ruff` into a project that does not use them, install a new tool merely to satisfy this guide, or claim remote CI passed when only a local equivalent ran.

Record for each check:

- exact command and working directory;
- reason and affected criterion or risk;
- start/end or duration when available;
- exit status and concise result;
- evidence location such as test report or log;
- whether it is focused, regression, or required CI-equivalent;
- reason, owner, and release impact when it did not run.

## Risk-proportionate floor

| Change risk | Typical examples | Minimum engineering evidence |
|---|---|---|
| Low | Local rename or behaviour-preserving cleanup | Focused tests plus existing required lint/type/build checks affected by the change |
| Medium | New interface, changed persistence behaviour, or cross-module refactor | Focused and targeted regression tests, relevant integration checks, context and verification record |
| High | Authentication, authorization, billing, sensitive data, migration, compatibility, or operational boundary | Complete provenance, Tier A/B independent verification, security review, required CI-equivalent checks, and independent human review before merge |

Risk level follows confirmed scope and observed impact. The Agent may identify a higher risk than initially recorded, but it cannot lower a human or policy classification to reduce evidence.

## Enforcement rules

- A required check failure blocks completion even when a focused test passes.
- A flaky, unavailable, or prohibitively slow required check is recorded as blocked unless an authorized human gate exception exists.
- Do not change or delete a required check simply to make the current change green.
- Do not weaken assertions, coverage, security scanning, type safety, or lint rules without an approved scope and evidence-backed decision.
- Test and build output must come from the changed revision; stale results do not satisfy the gate.
- Remote CI status must be distinguished from a local CI-equivalent run.
- High-risk changes cannot use a Tier C or Limited verification result without the explicit verification waiver, and such a waiver does not replace security or merge review.
- A downstream Tester-owned browser, accessibility, E2E, or deferred runtime validation is not an Implementation project check. Preserve it in limitations and the Tester handoff instead of listing it as skipped, unrun, failed, or blocked in the Software Engineer command/gate tables. This does not excuse any test or project check that the Change Contract or repository policy actually assigns to Implementation.

## CI ownership boundary

Software Engineer may edit an in-scope CI definition when the Change Contract and accepted architecture require it. Otherwise CI policy changes, required-check exceptions, credentials, deployment, and release approval are returned to the responsible human or DevOps owner. The engineering phase records readiness evidence; it does not assert that a remote workflow, merge, or deployment occurred unless the platform supplies durable evidence from that action.
