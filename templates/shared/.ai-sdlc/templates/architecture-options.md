# Architecture Options: {topic}

**Status:** Awaiting human selection
**Problem:** {architecture question}
**Context:** {relative link to discovery context}

## Load-bearing Decisions

- {decision that materially changes system shape or ownership}

## Rule Constraints

| Rule ID | Why Triggered | Constraint on Options | Evidence or Assumption |
|---------|---------------|-----------------------|------------------------|
| {API-001, DATA-003, or other loaded rule} | {trigger evidence} | {required behavior, rejecting condition, or trade-off} | {source or assumption} |

## Scoring Criteria

> Score each option from 1 (poor fit) to 5 (strong fit). Weights must come from confirmed priorities. If equal weights are assumed, say so.

| Criterion | Weight | Evidence or Assumption |
|-----------|--------|------------------------|
| {criterion} | {%} | {source or assumption} |

Use the exact machine-readable heading `## Option <ID>: <name>` below. Keep the heading at H2 and use a colon after the stable ID; do not replace it with `###`, an em dash, or a translated free-form label.

## Option A: {name}

**Core idea**

- {idea}

**Optimizes:** {confirmed quality or constraint}
**Gives up:** {specific cost or risk}
**Hardest constraint:** {constraint and why}
**Rule fit or exceptions:** {satisfied rule IDs; exception/blocker and required ADR}

## Option B: {name}

**Core idea**

- {idea}

**Optimizes:** {confirmed quality or constraint}
**Gives up:** {specific cost or risk}
**Hardest constraint:** {constraint and why}
**Rule fit or exceptions:** {satisfied rule IDs; exception/blocker and required ADR}

## Option C: {name}

**Core idea**

- {idea}

**Optimizes:** {confirmed quality or constraint}
**Gives up:** {specific cost or risk}
**Hardest constraint:** {constraint and why}
**Rule fit or exceptions:** {satisfied rule IDs; exception/blocker and required ADR}

{Add more option sections when `quality.minimum_options` is greater than 3.}

## Comparison

| Option | {Criterion 1} | {Criterion 2} | {Criterion 3} | Weighted Score | Rule Conflict or Rejecting Constraint |
|--------|---------------|---------------|---------------|----------------|---------------------------------------|
| A | {score — reason} | {score — reason} | {score — reason} | {score} | {rule ID, constraint, or None} |
| B | {score — reason} | {score — reason} | {score — reason} | {score} | {rule ID, constraint, or None} |
| C | {score — reason} | {score — reason} | {score — reason} | {score} | {rule ID, constraint, or None} |

## Provisional Recommendation

{Recommend one option in two short sentences tied to the scoring. This is not approval.}

## Human Selection Checkpoint

**Checkpoint status:** Awaiting human selection
**Decision owner:** {human owner}
**Reviewed options revision:** {artifact revision, date, or Not reviewed}
**Conditions to carry into selection:** {conditions or None}

In a platform-managed workflow, keep the reviewed Options checkpoint unchanged. The authoritative selection is a platform-validated `request_changes` review line `Selected option: <ID>` tied to this revision and then recorded in `architecture.md`; do not write the selection back into this document unless the active execution contract explicitly selects `architecture-options` for rerun.

Outside a platform-managed workflow, record equivalent linked human selection evidence and carry it into `architecture.md`. Do not create or activate selected-state C4 diagrams without either platform-validated selection evidence or that equivalent linked human evidence.

## Machine-readable Rulebook Contract

> Keep exactly one block with this sentinel. Include every rule from every `applicable` pack exactly once. Use `constrains` with documented option IDs, `not_triggered` with an empty option list and contrary evidence, or `blocked`. Remove the example row when no rule is applicable.

<!-- ai-sdlc:architecture-rulebook:v1 -->
```json
{
  "schemaVersion": 1,
  "document": "options",
  "catalogDigest": "{64-character digest from architect/scripts/rulebook-digest.mjs}",
  "rules": [
    {
      "ruleId": "{RULE-ID}",
      "state": "{constrains|not_triggered|blocked}",
      "affectedOptionIds": ["{A|B|C|other-documented-option-id}"],
      "evidenceRefs": ["{Rule Constraints row, source, or assumption reference}"]
    }
  ]
}
```
