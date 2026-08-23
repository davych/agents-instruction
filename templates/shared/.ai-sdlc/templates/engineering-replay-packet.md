# Engineering Replay Packet: <Run title>

> Conditional support only. This is not a registered Web output and does not participate in the normal phase gate. Create it manually only for a failed or disputed run that needs reproducible triage. Successful runs produce no replay packet.

## Sensitivity header

- **Classification:** <Public / Internal / Confidential / Restricted>
- **Allowed audience:** <audience>
- **Redactions:** <what was removed and why, or None>
- **Handling limits:** <storage/sharing limits>

## Trigger

- **Failure/dispute:** <summary>
- **Run/execution:** <IDs>
- **Observed at:** <timestamp or Unknown>
- **Requested by:** <human or workflow owner>

## Task and prompt

- **Immutable Change Contract:** `artifact:change-contract` at <revision>
- **Sanitized request:** <bounded text or durable reference>
- **Expected outcome:** <observable expectation>

Do not copy secrets, credentials, personal data, production payloads, or unrelated proprietary context.

## Context snapshot

| Input/context | Revision/hash/path | Included or redacted | Why relevant |
|---|---|---|---|
| <artifact/path> | <reference> | <status> | <reason> |

## Model metadata

| Activity | Model/tool | Version/config known to affect replay | Session reference |
|---|---|---|---|
| <implementation/test/review> | <value or Unknown> | <value or Unknown> | <reference> |

## Ordered action log

| Sequence | Action/command | Expected | Actual | Evidence |
|---|---|---|---|---|
| 1 | <action> | <expected> | <actual> | <reference> |

## Output snapshot

- **Expected:** <bounded description/reference>
- **Actual:** <bounded description/reference>
- **First known divergence:** <sequence/evidence or Unknown>

## Failure classification

**Class:** <implementation bug / test bug / spec ambiguity / stale or invalid clearance / environment or tooling failure / security or policy blocker / unknown>

**Evidence:** <reference>

**Hypotheses:** <clearly labelled hypotheses or None>

## Reproduction steps

1. <sanitized prerequisite>
2. <exact bounded command/action>
3. <observable failure>

## Triage note

- **Responsible owner:** <role/human>
- **Next safe action:** <action>
- **Evidence needed:** <item>
- **Decisions explicitly not made:** <security/risk/scope/merge/release decision or None>
