# Engineering Test Evidence: <Run title>

> Keep every heading and table column. Tests and command results must refer to real repository files and executions. This artifact does not substitute for them.

## Status

**State:** <Pass / Blocked>
**Run:** <Run ID>
**Implementation revision:** <commit, diff, or execution reference>
**Updated:** <YYYY-MM-DD or platform timestamp>

## Isolation

| Field | Evidence |
|---|---|
| Tier | <A / B / C / Limited> |
| Test-authoring model/session | <identity or durable reference> |
| Requirements visible while authoring | <Change Contract and public constraint revisions> |
| Implementation visible while authoring | <No for A/B; exact exposure for C/Limited> |
| Test intent frozen at | <revision, timestamp, or durable reference> |
| Later implementation access | <when/why it occurred after authoring, or None> |
| Human waiver | <None, or owner + decision reference + scope + compensating evidence> |

Tier A and B are pass-capable. Tier C and Limited make `State: Blocked` unless the complete human verification-gate waiver is linked. The Agent cannot approve its own waiver.

## Acceptance coverage

Preserve stable story AC IDs. If a Change Contract criterion has no ID, derive `CC-AC-001`, `CC-AC-002`, and so on from its array order only for traceability, record the source position, and leave the immutable contract unchanged.

| Trace ID | Source ID / position | Observable criterion or regression | Test path and test ID/name | Evidence | Result |
|---|---|---|---|---|---|
| CC-AC-001 | <existing ID or Change Contract criterion 1> | <criterion> | <real test path :: test name> | <result/log reference> | <Pass / Fail / Blocked / Untested> |
| <stable story AC ID> | <same stable ID> | <criterion> | <real test path :: test name> | <reference> | <result> |
| REG-001 | <Change Contract regression item> | <preserved behaviour> | <real test path :: test name> | <reference> | <result> |

Every in-scope acceptance criterion must have at least the configured minimum number of automated tests. A justified untestable item remains visible with owner and release impact; it is not silently counted as covered.

## Test changes

| Test path | Added / Modified / Removed | Trace IDs | Independent intent | Reason |
|---|---|---|---|---|
| <real path> | <change> | <IDs> | <what the test challenges> | <reason> |

## Commands and results

| Sequence | Working directory | Exact command | Check type | Exit/result | Evidence / notes |
|---|---|---|---|---|---|
| 1 | <path> | `<exact command>` | <focused / regression / lint / type / build / CI-equivalent> | <exit code and result> | <log/reference> |

Record required checks that did not run:

| Check | Reason not run | Owner | Release / verification impact | Status |
|---|---|---|---|---|
| <check or None> | <reason> | <owner> | <impact> | <Blocked / Waived by human> |

## Failure classification

| Failure ID | Failing test/check | Classification | Contract evidence | Action and owner | Retest evidence |
|---|---|---|---|---|---|
| TEST-FAIL-001 | <reference> | <implementation bug / test bug / spec ambiguity> | <source> | <action + owner> | <reference or Pending> |

Do not change a failing expectation until it is classified. A `spec ambiguity` is returned to the owning human/upstream role and remains blocked; the Engineer does not choose an interpretation.

## Coverage gaps

- <Untested criterion, unavailable environment, residual risk, owner, and impact, or None>

## Conclusion

- **Isolation gate:** <Pass / Blocked; reason>
- **Acceptance gate:** <Pass / Blocked; uncovered IDs>
- **Regression gate:** <Pass / Blocked; reason>
- **Project-check gate:** <Pass / Blocked; reason>
- **Ready for review:** <Yes / No>
