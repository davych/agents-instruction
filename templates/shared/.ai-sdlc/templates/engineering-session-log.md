# Engineering Session Log: <Run title>

> Keep every heading and table column. Record events as they occur. Do not reconstruct an idealized history or include secrets, credentials, or production data.

## Status

**State:** <In progress / Blocked / Complete>
**Run:** <Run ID>
**Execution/session:** <platform execution ID or local session reference>
**Started:** <timestamp or Unknown>
**Ended/duration:** <timestamp/duration or Unknown>

## Task contract

- **Immutable Change Contract:** `artifact:change-contract` at <revision>
- **Implementation plan:** `artifact:implementation-plan` at <revision>
- **Implementation tasks:** `artifact:implementation-tasks` at <revision>
- **Selected scope / criteria:** <IDs>
- **Targeted regressions:** <IDs>

## Context loaded

| Order | Layer / type | Exact path or artifact revision | Purpose | Resulting fact, constraint, or gap |
|---|---|---|---|---|
| 1 | Project instruction | <path / None> | <purpose> | <result> |
| 2 | Upstream artifact | <artifact and revision> | <purpose> | <result> |
| 3 | Repository evidence | <path> | <purpose> | <result> |
| 4 | Configured reference | <path / None> | <purpose> | <result> |

## Ordered action log

| Sequence | Action | Repository targets | Result | Evidence / next action |
|---|---|---|---|---|
| 1 | <read / plan / edit / command / review> | <paths or artifacts> | <success / failure / blocked> | <diff, command result, artifact, or follow-up> |

## Change inventory

| Path | Change type | Criterion / task IDs | Purpose | Current evidence |
|---|---|---|---|---|
| <real source, test, configuration, or evidence path> | <Added / Modified / Removed> | <IDs> | <reason> | <diff, test, command, or artifact> |

## Rejected alternatives

| Alternative | Why considered | Evidence-based reason rejected | Human decision needed? |
|---|---|---|---|
| <option or None> | <reason> | <reason> | <No or owner + decision> |

## Human decisions and escalations

| Decision or escalation | Owner | Requested evidence | Durable decision reference | Effect on work |
|---|---|---|---|---|
| <item or None> | <owner> | <evidence> | <reference or Pending> | <effect> |

## Verification gates

> Record only gates that Software Engineer must complete before handoff. A downstream Tester-owned browser, accessibility, E2E, or other deferred validation belongs in `Outcome` as an unresolved risk/handoff item; it is not a Blocked or Failed Implementation gate when every Implementation-owned check has passed. Keep a gate Blocked when its own required evidence is genuinely missing or failing.

| Gate | Evidence | Result | Blocker / waiver |
|---|---|---|---|
| Upstream clearances current | <references> | <Pass / Blocked> | <None or item> |
| Real implementation present | <paths/diff> | <Pass / Blocked> | <None or item> |
| Independent tests | `artifact:engineering-test-evidence` | <Pass / Blocked> | <tier and waiver> |
| Project checks | <commands/results> | <Pass / Blocked> | <None or item> |
| Seven-lens review | `artifact:engineering-review` | <Pass / Blocked> | <None or item> |
| Provenance complete | `artifact:engineering-provenance` | <Pass / Blocked> | <None or item> |

## Outcome

- **Result:** <Complete / Partially complete / Failed / Blocked>
- **Changed source/test areas:** <paths or None>
- **Satisfied criteria:** <IDs or None>
- **Unresolved criteria/risks:** <IDs, reason, owner, and impact or None; put downstream Tester-owned deferred validation here>
- **Next owner/action:** <Tester, upstream role, or human action>
