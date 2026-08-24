# Engineering Evidence Pack: <Run title>

> Keep every heading and evidence-index row. This is the stable index and Tester handoff for the seven registered, Run-scoped engineering artifacts. It summarizes real code and test changes; it does not replace them.

## Status

**State:** <Ready for verification / Blocked>
**Run:** <Run ID>
**Implementation revision:** <commit, diff, or execution reference>
**Blockers:** <None, or blocker + owner + evidence needed>

Use `Ready for verification` only when the registered evidence is current, the real implementation and necessary tests exist, Tier A/B independent verification passes or a complete human waiver is linked, required checks pass, and review has no unresolved blocker.

## Evidence index

| Registered evidence | Artifact link | Status | Revision / last checked |
|---|---|---|---|
| Implementation plan | `artifact:implementation-plan` | <status> | <revision/date> |
| Implementation tasks | `artifact:implementation-tasks` | <status> | <revision/date> |
| Engineering session log | `artifact:engineering-session-log` | <status> | <revision/date> |
| Engineering test evidence | `artifact:engineering-test-evidence` | <status> | <revision/date> |
| Engineering review | `artifact:engineering-review` | <status> | <revision/date> |
| Engineering provenance | `artifact:engineering-provenance` | <status> | <revision/date> |

The optional replay packet is not registered and is not part of this index or the Web phase gate. It may be created manually for a failed or disputed run only.

## Contract and active clearances

- **Change Contract:** `artifact:change-contract` at <revision and resolved path>
- **Product:** <direct / reuse / partial / full; evidence revision>
- **Design:** <skip / reuse / partial / full; evidence revision>
- **Architecture:** <skip / reuse / partial / full; index/clearance revision>
- **Trace IDs:** <stable IDs plus any CC-AC aliases derived by Change Contract array order without modifying it>

## Implemented scope

| Change Contract or story criterion | Code/configuration changed | Automated evidence | Result |
|---|---|---|---|
| <CC-AC-001 or stable story AC ID> | <real path or component> | <real test/check reference> | <Implemented / Blocked> |

## Changes

- <What changed and why, with real repository paths>
- <Confirmed non-goal and preserved behaviour>
- <Source/test diff or commit reference>

## Impact-check deviations

State `None` or identify any Product, Design, or Architecture impact discovered during implementation, its affected clearance, owner, and resolution evidence. A newly affected phase must be reassessed before handoff; do not expand scope behind an existing clearance.

## Verification, regression, and risks

- **Isolation:** <Tier A / B / C / Limited, evidence, and human waiver when applicable>
- **Checks run:** <exact commands and results; link engineering-test-evidence>
- **Targeted regression obligations:** <contract obligations and evidence>
- **Review verdict:** <Pass / Blocked and engineering-review link>
- **Known limits / untested scope:** <items or None>
- **Remaining risks:** <items, owner, and impact or None>

## Handoff

- **Next owner:** Tester
- **Ready for verification:** <Yes / No>
- **Criteria and regressions to verify:** <IDs>
- **Changed areas to inspect:** <real repository paths>
- **Evidence starting point:** `artifact:implementation-notes` -> Evidence index
- **Blocked items / human actions:** <items or None>
- **Publication boundary:** Engineering provenance is future-use traceability only; Software Engineer did not create, open, or publish a PR, merge, deploy, or approve release.
