# Engineering Implementation Tasks: <Run title>

> Keep every heading and table column. This artifact records executable work and current state. Strategy and vertical-slice rationale belong in `implementation-plan`.

## Status

**State:** <Planned / In progress / Blocked / Complete>
**Run:** <Run ID>
**Plan:** `artifact:implementation-plan`
**Updated:** <YYYY-MM-DD or platform timestamp>

Allowed task states are `todo`, `in-progress`, `blocked`, and `done`. Do not mark a task `done` without a real evidence reference.

## Traceability rules

- Preserve stable Change Contract and story AC IDs.
- If a Change Contract criterion has no ID, derive `CC-AC-001`, `CC-AC-002`, and so on from its array order only for engineering traceability. Record its source position and do not edit the immutable contract.
- Use `REG-<three-digits>` for targeted regression obligations that have no stable source ID.
- Every in-scope criterion needs at least one implementation task and one verification task, unless a justified no-code disposition is recorded with evidence.

## Task ledger

| Task ID | Status | Work and expected result | Repository targets | AC / regression IDs | Dependencies | Evidence / blocker |
|---|---|---|---|---|---|---|
| ENG-TASK-001 | todo | <atomic implementation work> | <real paths/components> | CC-AC-001 | <task/input/decision or None> | <link when done or blocker + owner> |
| ENG-TASK-002 | todo | <independent test authoring and execution> | <real test paths> | CC-AC-001, REG-001 | ENG-TASK-001 for execution only | `artifact:engineering-test-evidence` |
| ENG-TASK-003 | todo | <seven-lens and adversarial review> | <affected scope> | CC-AC-001, REG-001 | ENG-TASK-001, ENG-TASK-002 | `artifact:engineering-review` |

## Acceptance coverage

| Trace ID | Source ID / position | Implementation task IDs | Verification task IDs | Coverage status |
|---|---|---|---|---|
| CC-AC-001 | <existing ID or Change Contract criterion 1> | ENG-TASK-001 | ENG-TASK-002 | <Planned / Covered / Blocked> |
| <stable story AC ID> | <same stable ID> | <task IDs> | <task IDs> | <status> |

## Regression coverage

| Regression ID | Source obligation | Task IDs | Evidence | Status |
|---|---|---|---|---|
| REG-001 | <preserved behaviour> | <task IDs> | <test/check reference> | <Planned / Covered / Blocked> |

## Blockers and escalations

| Blocker | Affected task / criterion | Human or role owner | Evidence needed | Next action |
|---|---|---|---|---|
| <item or None> | <IDs> | <owner> | <evidence> | <action> |

## Completion summary

- **Done:** <task IDs and evidence>
- **Blocked:** <task IDs, reason, and owner or None>
- **Deferred outside confirmed scope:** <item and source decision or None>
- **Next owner:** <Software Engineer / Tester / named upstream or human owner>
