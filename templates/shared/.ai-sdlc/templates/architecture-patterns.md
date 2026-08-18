# Architecture Pattern Decisions: {topic}

**Selected option:** {option link}
**C4 container view:** {relative link}

## Adopted Patterns

| Pattern | Rule IDs | C4 L2 Location | Constraint Addressed | Trade-off | How It Stays True |
|---------|----------|-----------------|----------------------|-----------|-------------------|
| {pattern} | {rule IDs or None} | {container or relationship alias} | {constraint ID} | {specific cost} | {ADR, test, or review} |

## Rejected Patterns

| Pattern | Why It Was Considered | Project-specific Reason for Rejection |
|---------|-----------------------|---------------------------------------|
| {pattern} | {reason} | {constraint or trade-off} |

## Rule Disposition Register

> After human option selection, list every rule × affected scope from every Applicable pack exactly once. `Not triggered` needs contrary trigger evidence. A `DEFAULT` whose catalog policy is `Reason allowed` may use `Justified deviation`; `ADR required` and any `MUST`/`FORBIDDEN` waiver use `Exception` and a human-approved ADR. `Blocked` prevents readiness.

| Rule ID | Scope | Level | Trigger Evidence | Disposition | Architecture Evidence | Decision or Blocker |
|---------|-------|-------|------------------|-------------|-----------------------|---------------------|
| {rule ID} | {scope ID} | {MUST / DEFAULT / WHEN / FORBIDDEN} | {source} | {Adopted / Not triggered / Justified deviation / Exception / Blocked} | {C4 alias, ADR, Pattern, NFR, test, or None} | {reason, ADR, owner/evidence needed, or None} |

Do not add a pattern only because it is common. Every adopted pattern needs a location and a cost. A rule name without trigger evidence and an implementation location does not count as conformance.

## Machine-readable Rulebook Contract

> Keep exactly one block with this sentinel. Include every applicable rule once per affected Discovery scope. `justified_deviation` is allowed only when that `DEFAULT` rule's catalog policy is `Reason allowed` and uses `decisionRef: null`. `exception` requires an `accepted-adr:ADR-NNN` reference to a human revision whose accepted ADR names that rule and scope. `blocked` prevents approval. A Greenfield frontend default may be `satisfied` on a Brownfield/existing scope only when `decisionRef` names a human-approved migration ADR for that scope.

<!-- ai-sdlc:architecture-rulebook:v1 -->
```json
{
  "schemaVersion": 1,
  "document": "patterns",
  "catalogDigest": "{64-character digest from architect/scripts/rulebook-digest.mjs}",
  "selection": { "optionId": "{platform-selected option ID}", "reviewId": "{selection review UUID}", "optionsArtifactId": "{reviewed options artifact UUID}", "selectedAt": "{selection timestamp}" },
  "dispositions": [
    {
      "ruleId": "{RULE-ID}",
      "scopeId": "{scope-id-from-discovery}",
      "state": "{satisfied|not_triggered|justified_deviation|exception|blocked}",
      "evidenceRefs": ["{C4 alias, ADR, Pattern row, NFR, test, or contrary trigger evidence}"],
      "decisionRef": null
    }
  ]
}
```
