# Architecture Pack: {topic}

**Status:** {Awaiting human selection / Drafting / Blocked / Ready for human acceptance / Accepted for implementation}
**Updated:** {YYYY-MM-DD}
**Selected option:** {option ID or Not selected}
**Selection evidence:** {human decision link or Not provided}
**Accepted by:** {human owner or Not accepted}
**Acceptance evidence:** {decision link or Not provided}

## Problem and Inputs

{State the architecture problem in one short paragraph.}

| Input | Resolved Path | Revision or Date | Status |
|-------|---------------|------------------|--------|
| {artifact or source} | {path} | {revision} | {Confirmed / Assumed / Stale} |

## Selected Direction

{Summarize the human-selected direction and why it fits the confirmed constraints. If no option is selected, link the options document, state that selected-state artifacts are pending, and continue to the Pack Index.}

## Hard Constraints

> Include applicable rulebook requirements and rules from accepted ADRs that still apply. Link the source ID; do not promote a recommendation or Pending rule to a hard constraint.

| Source | Level | Constraint | Evidence |
|--------|-------|------------|----------|
| {rule ID or ADR link} | {MUST / triggered WHEN / FORBIDDEN / Accepted ADR} | {active constraint or prohibited choice} | {artifact or decision link} |

## Rulebook Conformance

**Project mode:** {Greenfield / Brownfield / Hybrid and discovery link}

| Pack | Status | Rule IDs | Evidence | Exceptions or Blocks |
|------|--------|----------|----------|----------------------|
| API | {Applicable / Not applicable / Blocked} | {IDs or None} | {C4, ADR, Pattern, NFR, test, or discovery link} | {ADR, human decision, blocker, or None} |
| Data | {Applicable / Not applicable / Blocked} | {IDs or None} | {C4, ADR, Pattern, NFR, test, or discovery link} | {ADR, human decision, blocker, or None} |
| Integration | {Applicable / Not applicable / Blocked} | {IDs or None} | {C4, ADR, Pattern, NFR, test, or discovery link} | {ADR, human decision, blocker, or None} |
| Security | {Applicable / Not applicable / Blocked} | {IDs or None} | {C4, ADR, Pattern, NFR, test, or discovery link} | {ADR, human decision, blocker, or None} |
| Observability | {Applicable / Not applicable / Blocked} | {IDs or None} | {C4, ADR, Pattern, NFR, test, or discovery link} | {ADR, human decision, blocker, or None} |
| Frontend | {Applicable / Not applicable / Blocked} | {IDs or None} | {C4, ADR, Pattern, NFR, test, or discovery link} | {ADR, human decision, blocker, or None} |

The detailed per-rule disposition register lives in the Pattern Decisions artifact. A Blocked applicable pack or unresolved mandatory rule prevents readiness.

## Pack Index

> Resolve these links from the artifact paths in `ai-native.yaml`. Do not assume the default directory names.
> If the active execution contract selected an artifact that is blocked on human option selection, link its materialized non-empty Pending scaffold here. A Pending link records the blocker; it does not make the child artifact active or satisfy the completion gate.

| Artifact | Relative Link | Status | Last Checked |
|----------|---------------|--------|--------------|
| Discovery context | {relative link} | {status} | {date} |
| Options | {relative link} | {status} | {date} |
| C4 system context | {relative link} | {status} | {date} |
| C4 containers | {relative link} | {status} | {date} |
| ADR directory | {relative link} | {status} | {date} |
| Pattern decisions | {relative link} | {status} | {date} |
| NFR budgets | {relative link} | {status} | {date} |
| Independent adversarial review | {relative link} | {status} | {date} |

## ADR Register

| ADR | Status | Applies Now | Agent-readable Rule |
|-----|--------|-------------|---------------------|
| {link} | {Proposed / Accepted / Rejected / Superseded} | {Yes / No} | Must: {rule}. Do not: {rule}. |

## Open Human Decisions

- [ ] {decision, owner, evidence needed, and impact}

## Handoff

**Complete:** {items}
**Provisional:** {items}
**Blocked:** {items and reason}
**Next owner:** {human or workflow role}

## Machine-readable Rulebook Contract

> Keep exactly one block with this sentinel and exactly six pack entries. At the checkpoint use `awaiting_selection` with `selection: null`; after selected-state evidence is complete use `ready_for_human_acceptance` and replace `null` with the exact platform values `{ "optionId": "...", "reviewId": "...", "optionsArtifactId": "...", "selectedAt": "..." }`. For each applicable pack, `ruleIds` is its exact catalog rule set. Deviation, exception, and blocked lists must match the detailed Pattern Decisions register.

<!-- ai-sdlc:architecture-rulebook:v1 -->
```json
{
  "schemaVersion": 1,
  "document": "architecture",
  "catalogDigest": "{64-character digest from architect/scripts/rulebook-digest.mjs}",
  "state": "{awaiting_selection|ready_for_human_acceptance|blocked}",
  "selection": null,
  "packs": [
    { "id": "api", "status": "{applicable|not_applicable|blocked}", "ruleIds": ["{applicable API rule IDs or empty}"], "justifiedDeviationRuleIds": [], "exceptionRuleIds": [], "blockedRuleIds": [] },
    { "id": "data", "status": "{applicable|not_applicable|blocked}", "ruleIds": ["{applicable Data rule IDs or empty}"], "justifiedDeviationRuleIds": [], "exceptionRuleIds": [], "blockedRuleIds": [] },
    { "id": "integration", "status": "{applicable|not_applicable|blocked}", "ruleIds": ["{applicable Integration rule IDs or empty}"], "justifiedDeviationRuleIds": [], "exceptionRuleIds": [], "blockedRuleIds": [] },
    { "id": "security", "status": "{applicable|not_applicable|blocked}", "ruleIds": ["{applicable Security rule IDs or empty}"], "justifiedDeviationRuleIds": [], "exceptionRuleIds": [], "blockedRuleIds": [] },
    { "id": "observability", "status": "{applicable|not_applicable|blocked}", "ruleIds": ["{applicable Observability rule IDs or empty}"], "justifiedDeviationRuleIds": [], "exceptionRuleIds": [], "blockedRuleIds": [] },
    { "id": "frontend", "status": "{applicable|not_applicable|blocked}", "ruleIds": ["{applicable Frontend rule IDs or empty}"], "justifiedDeviationRuleIds": [], "exceptionRuleIds": [], "blockedRuleIds": [] }
  ]
}
```
