# Engineering Review: <Run title>

> Keep every heading and finding-table column. Each lens must contain a complete finding row or put the exact text `none found` in the Finding ID cell. Blank lenses do not satisfy the gate. For a real finding, the final cell must include both a terminal status and durable resolution evidence.

## Verdict

**State:** <Pass / Blocked / Human waiver required>
**Run:** <Run ID>
**Implementation revision:** <commit, diff, or execution reference>
**Reviewer/session:** <independent reviewer or session evidence>
**Relationship to implementation author:** <independent / same author; explain>
**Blocking finding IDs:** <IDs or None>

## Behaviour preservation

| Finding ID | Severity | Evidence | Impact | Required action / owner | Status / resolution evidence |
|---|---|---|---|---|---|
| <ENG-REV-001 or `none found`> | <critical / high / medium / low / N/A> | <durable path, test, command, or artifact evidence> | <impact or N/A> | <action; `Owner: <accountable owner>` or N/A> | <terminal status + resolution reference> |

## Hidden assumptions

| Finding ID | Severity | Evidence | Impact | Required action / owner | Status / resolution evidence |
|---|---|---|---|---|---|
| <finding ID or `none found`> | <severity> | <durable evidence> | <impact> | <action; `Owner: <accountable owner>`> | <terminal status + resolution reference> |

## Spec/architecture drift

| Finding ID | Severity | Evidence | Impact | Required action / owner | Status / resolution evidence |
|---|---|---|---|---|---|
| <finding ID or `none found`> | <severity> | <durable evidence> | <impact> | <action; `Owner: <accountable owner>`> | <terminal status + resolution reference> |

## Confirmation without evidence

| Finding ID | Severity | Evidence | Impact | Required action / owner | Status / resolution evidence |
|---|---|---|---|---|---|
| <finding ID or `none found`> | <severity> | <durable evidence> | <impact> | <action; `Owner: <accountable owner>`> | <terminal status + resolution reference> |

## Test independence

| Finding ID | Severity | Evidence | Impact | Required action / owner | Status / resolution evidence |
|---|---|---|---|---|---|
| <finding ID or `none found`> | <severity> | <durable isolation and test evidence> | <impact> | <action; `Owner: <accountable owner>`> | <terminal status + resolution reference> |

## Security surface

| Finding ID | Severity | Evidence | Impact | Required action / owner | Status / resolution evidence |
|---|---|---|---|---|---|
| <finding ID or `none found`> | <severity> | <durable evidence> | <impact> | <action; `Human owner: <name>`> | <terminal status + resolution reference + `human decision: <durable reference>`> |

Any security-class finding is blocking until remediation evidence and the human-owned decision are recorded. The Agent does not accept security risk.

## Over-engineering

| Finding ID | Severity | Evidence | Impact | Required action / owner | Status / resolution evidence |
|---|---|---|---|---|---|
| <finding ID or `none found`> | <severity> | <durable evidence> | <impact> | <action; `Owner: <accountable owner>`> | <terminal status + resolution reference> |

## Adversarial pass

### Pre-mortem

| Finding ID | Severity | Plausible failure and trigger | Evidence / detection | Impact | Required action / owner | Status / resolution evidence |
|---|---|---|---|---|---|---|
| <ENG-ADV-001 or `none found`> | <severity> | <failure and trigger> | <durable evidence> | <impact> | <action; `Owner: <accountable owner>`> | <terminal status + resolution reference> |

### Edge-case-hunter

| Finding ID | Severity | Edge condition and expected behaviour | Evidence / result | Impact | Required action / owner | Status / resolution evidence |
|---|---|---|---|---|---|---|
| <ENG-ADV-002 or `none found`> | <severity> | <relevant boundary, failure condition, and expectation> | <durable test/review evidence> | <impact> | <action; `Owner: <accountable owner>`> | <terminal status + resolution reference> |

## Finding summary

| Finding ID | Lens / method | Severity | Final status | Resolution or human decision reference |
|---|---|---|---|---|
| <ID or None> | <name> | <severity> | <status> | <reference> |

The review may recommend readiness but does not publish or approve a PR, merge, deploy, accept material risk, change scope, or approve an architecture/security exception.
