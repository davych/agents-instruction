# Engineering Review: <Run title>

> Keep every heading and finding-table column. Each lens must contain a complete finding row or put the exact text `none found` in the Finding ID cell. Blank lenses do not satisfy the gate. A `none found` row still records its real review basis in the Evidence cell; set Severity, Impact, and Required action / owner to `N/A`, set adversarial failure/edge-condition cells to `N/A`, and set Status / resolution evidence to `not-applicable`. Do not mix `none found` with a real finding in one section. For a real finding, the final cell must include both a terminal status and durable resolution evidence.

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
| <ENG-REV-001 or exact `none found`> | <critical / high / medium / low; `N/A` when none found> | <real path, test, command, result log, or artifact used as the review basis> | <impact; `N/A` when none found> | <action; `Owner: <accountable owner>`; `N/A` when none found> | <terminal status + resolution reference; exact `not-applicable` when none found> |

## Hidden assumptions

| Finding ID | Severity | Evidence | Impact | Required action / owner | Status / resolution evidence |
|---|---|---|---|---|---|
| <finding ID or exact `none found`> | <severity; `N/A` when none found> | <real path, test, command, result log, or artifact used as the review basis> | <impact; `N/A` when none found> | <action and owner; `N/A` when none found> | <terminal status + resolution reference; exact `not-applicable` when none found> |

## Spec/architecture drift

| Finding ID | Severity | Evidence | Impact | Required action / owner | Status / resolution evidence |
|---|---|---|---|---|---|
| <finding ID or exact `none found`> | <severity; `N/A` when none found> | <real path, test, command, result log, or artifact used as the review basis> | <impact; `N/A` when none found> | <action and owner; `N/A` when none found> | <terminal status + resolution reference; exact `not-applicable` when none found> |

## Confirmation without evidence

| Finding ID | Severity | Evidence | Impact | Required action / owner | Status / resolution evidence |
|---|---|---|---|---|---|
| <finding ID or exact `none found`> | <severity; `N/A` when none found> | <real path, test, command, result log, or artifact used as the review basis> | <impact; `N/A` when none found> | <action and owner; `N/A` when none found> | <terminal status + resolution reference; exact `not-applicable` when none found> |

## Test independence

| Finding ID | Severity | Evidence | Impact | Required action / owner | Status / resolution evidence |
|---|---|---|---|---|---|
| <finding ID or exact `none found`> | <severity; `N/A` when none found> | <real isolation artifact, test path/name, command, or result log used as the review basis> | <impact; `N/A` when none found> | <action and owner; `N/A` when none found> | <terminal status + resolution reference; exact `not-applicable` when none found> |

## Security surface

| Finding ID | Severity | Evidence | Impact | Required action / owner | Status / resolution evidence |
|---|---|---|---|---|---|
| <finding ID or exact `none found`> | <severity; `N/A` when none found> | <real path, test, command, result log, or artifact used as the review basis> | <impact; `N/A` when none found> | <action; `Human owner: <name>`; `N/A` when none found> | <terminal status + resolution reference + human decision reference; exact `not-applicable` when none found> |

Any security-class finding is blocking until remediation evidence and the human-owned decision are recorded. The Agent does not accept security risk.

## Over-engineering

| Finding ID | Severity | Evidence | Impact | Required action / owner | Status / resolution evidence |
|---|---|---|---|---|---|
| <finding ID or exact `none found`> | <severity; `N/A` when none found> | <real path, test, command, result log, or artifact used as the review basis> | <impact; `N/A` when none found> | <action and owner; `N/A` when none found> | <terminal status + resolution reference; exact `not-applicable` when none found> |

## Adversarial pass

### Pre-mortem

| Finding ID | Severity | Plausible failure and trigger | Evidence / detection | Impact | Required action / owner | Status / resolution evidence |
|---|---|---|---|---|---|---|
| <ENG-ADV-001 or exact `none found`> | <severity; `N/A` when none found> | <failure and trigger; `N/A` when none found> | <real path, test, command, result log, or artifact used as the review basis> | <impact; `N/A` when none found> | <action and owner; `N/A` when none found> | <terminal status + resolution reference; exact `not-applicable` when none found> |

### Edge-case-hunter

| Finding ID | Severity | Edge condition and expected behaviour | Evidence / result | Impact | Required action / owner | Status / resolution evidence |
|---|---|---|---|---|---|---|
| <ENG-ADV-002 or exact `none found`> | <severity; `N/A` when none found> | <relevant boundary, failure condition, and expectation; `N/A` when none found> | <real test path/name, command, result log, or artifact used as the review basis> | <impact; `N/A` when none found> | <action and owner; `N/A` when none found> | <terminal status + resolution reference; exact `not-applicable` when none found> |

## Finding summary

| Finding ID | Lens / method | Severity | Final status | Resolution or human decision reference |
|---|---|---|---|---|
| <ID or None> | <name> | <severity> | <status> | <reference> |

The review may recommend readiness but does not publish or approve a PR, merge, deploy, accept material risk, change scope, or approve an architecture/security exception.
