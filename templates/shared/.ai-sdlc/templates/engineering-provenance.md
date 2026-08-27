# Engineering Provenance: <Run title>

> Keep every heading. Use exact artifact revisions and real repository evidence. `Unknown`, `Not run`, and `Blocked` are valid; invented evidence is not.

## Status

**State:** <Complete / Blocked>
**Run:** <Run ID>
**Implementation revision:** <commit, diff, or execution reference>

## Tool/model

| Activity | Tool/model | Session or execution reference |
|---|---|---|
| Implementation | <actual value or Unknown> | <reference> |
| Independent test authoring | <actual value or Unknown> | <reference> |
| Seven-lens review | <actual value or Unknown> | <reference> |

## Context loaded

| Type | Exact artifact revision or path | Purpose |
|---|---|---|
| Immutable specification | `artifact:change-contract` at <revision> | <scope/criteria/regressions> |
| Product clearance | <reference> | <purpose> |
| Design clearance | <reference> | <purpose> |
| Architecture clearance | <reference> | <purpose> |
| Project instructions / configured references | <exact paths or None> | <purpose> |
| Repository evidence | <exact paths or None> | <purpose> |

## Verification gates

> These are Implementation-owned readiness gates only. Keep downstream Tester-owned deferred validation in `Known limitations` and the handoff; do not present future Tester work as a failed or blocked Implementation result when the engineering gates themselves passed.

| Gate | Evidence | Result |
|---|---|---|
| Acceptance and regression coverage | `artifact:engineering-test-evidence` | <Pass / Blocked> |
| Isolation | <Tier A / B / C / Limited and evidence> | <Pass / Blocked / Human waiver> |
| Project checks | <command evidence> | <Pass / Blocked> |
| Seven-lens plus adversarial review | `artifact:engineering-review` | <Pass / Blocked> |

## Human decisions

| Decision / waiver / override | Human owner | Durable evidence | Scope and effect |
|---|---|---|---|
| <item or None> | <owner> | <reference> | <effect> |

## Known limitations

- <Untested scope, unavailable environment, uncertainty, or residual risk with owner and impact, or None>

## Session duration

- **Started:** <timestamp or Unknown>
- **Ended:** <timestamp or Unknown>
- **Duration:** <duration or Unknown>

## SDD approach

**Mode:** <greenfield / brownfield / hybrid>

**Preserved behaviour / boundary reference:** <implementation-plan section>

**Specification authority:** The immutable Change Contract and active PM / BA evidence; no parallel engineering `spec.md` was created.

## Evidence links

| Evidence | Exact artifact, repository path, or revision | Status |
|---|---|---|
| Spec | `artifact:change-contract` at <revision>; immutable specification authority | <Current / Blocked> |
| Active clearances | <Product, Design, Architecture references> | <Current / Blocked> |
| Implementation plan | `artifact:implementation-plan` | <status> |
| Implementation tasks | `artifact:implementation-tasks` | <status> |
| Implementation notes/index | `artifact:implementation-notes` | <status> |
| Session log | `artifact:engineering-session-log` | <status> |
| Tests | `artifact:engineering-test-evidence` plus real test paths | <status> |
| Review | `artifact:engineering-review` | <status> |
| Source diff/commit | <repository reference> | <status> |

## Publication boundary

**PR provenance generated:** <Yes / No; reason; future-use traceability only>

**PR created or opened by Software Engineer:** No

**PR published by Software Engineer:** No

**Merge/deploy/release performed by Software Engineer:** No

This content is traceability that may be copied into a future PR; generating it does not create, open, or publish a PR. An outer platform or human owns any future PR action, merge, deployment, release approval, and the resulting external evidence.
