# Architecture Discovery Context: {topic}

**Status:** Draft for human review
**Sources:** {links or Not provided}

## Architecture Question

{State the underlying problem without assuming a solution.}

## Four-layer Context

| Layer | Confirmed Context | Architecture Effect | Evidence | Open Question |
|-------|-------------------|---------------------|----------|---------------|
| Business | {outcome, pressure, owner, or measure} | {effect} | {source} | {question or None} |
| Product | {user, journey, channel, or accepted scope} | {effect} | {source} | {question or None} |
| Engineering | {current system, integration, team, or operating limit} | {effect} | {source} | {question or None} |
| Regulation and policy | {named rule or None confirmed} | {specific effect or Not known} | {source} | {question or None} |

## Project Mode

| Affected Scope | Mode | Evidence | Compatibility Effect | Status |
|----------------|------|----------|----------------------|--------|
| {frontend, service, integration, or whole system} | {Greenfield / Brownfield / Hybrid / Blocked} | {manifest, lockfile, source, runtime, ADR, or human decision} | {defaults allowed, existing convention retained, or boundary split} | {Confirmed / Assumed / Blocked} |

## Rule Pack Applicability

> Evaluate all six packs from the rulebook index. `Not applicable` requires evidence; uncertainty that could change an option is `Blocked`, not silently skipped.

| Pack | Trigger Evidence | Status | Loaded Path | Affected Scope or Option | Evidence Needed / Owner |
|------|------------------|--------|-------------|--------------------------|-------------------------|
| API | {evidence or none found} | {Applicable / Not applicable / Blocked} | {rules/api.md or Not loaded} | {scope or None} | {evidence and owner or None} |
| Data | {evidence or none found} | {Applicable / Not applicable / Blocked} | {rules/data.md or Not loaded} | {scope or None} | {evidence and owner or None} |
| Integration | {evidence or none found} | {Applicable / Not applicable / Blocked} | {rules/integration.md or Not loaded} | {scope or None} | {evidence and owner or None} |
| Security | {evidence or none found} | {Applicable / Not applicable / Blocked} | {rules/security.md or Not loaded} | {scope or None} | {evidence and owner or None} |
| Observability | {evidence or none found} | {Applicable / Not applicable / Blocked} | {rules/observability.md or Not loaded} | {scope or None} | {evidence and owner or None} |
| Frontend | {evidence or none found} | {Applicable / Not applicable / Blocked} | {rules/frontend.md or Not loaded} | {scope or None} | {evidence and owner or None} |

## Hidden Assumptions

| ID | Source Clue | Assumption | What Breaks if Wrong | Confirmation Owner | Status |
|----|-------------|------------|----------------------|--------------------|--------|
| AS-01 | {clue} | {assumption} | {impact} | {owner} | Unconfirmed |
| AS-02 | {clue} | {assumption} | {impact} | {owner} | Unconfirmed |
| AS-03 | {clue} | {assumption} | {impact} | {owner} | Unconfirmed |
| AS-04 | {clue} | {assumption} | {impact} | {owner} | Unconfirmed |
| AS-05 | {clue} | {assumption} | {impact} | {owner} | Unconfirmed |

## Confirmed Constraints

| ID | Constraint | Evidence | Options It May Reject |
|----|------------|----------|-----------------------|
| CON-01 | {constraint} | {source} | {option or Unknown} |

## Missing Evidence

- [ ] {missing evidence, owner, and why it matters}

## Machine-readable Rulebook Contract

> Keep exactly one block with this sentinel. Replace every placeholder. Use one scope entry per affected boundary and exactly six pack entries. `not_applicable` uses `loadedPath: null`, `blockerOwner: null`, and evidence explaining why. `applicable` uses the exact `rules/<pack>.md` path. A `blocked` value prevents option selection.

<!-- ai-sdlc:architecture-rulebook:v1 -->
```json
{
  "schemaVersion": 1,
  "document": "discovery",
  "catalogDigest": "{64-character digest from architect/scripts/rulebook-digest.mjs}",
  "scopes": [
    {
      "id": "{stable-scope-id}",
      "mode": "{greenfield|brownfield|hybrid|blocked}",
      "boundary": "{new|existing}",
      "evidenceRefs": ["{path, artifact section, runtime evidence, ADR, or human decision}"]
    }
  ],
  "packs": [
    { "id": "api", "status": "{applicable|not_applicable|blocked}", "triggerEvidenceRefs": ["{evidence}"], "affectedScopeIds": ["{scope-id or remove when not applicable}"], "loadedPath": "rules/api.md", "blockerOwner": null },
    { "id": "data", "status": "{applicable|not_applicable|blocked}", "triggerEvidenceRefs": ["{evidence}"], "affectedScopeIds": ["{scope-id or remove when not applicable}"], "loadedPath": "rules/data.md", "blockerOwner": null },
    { "id": "integration", "status": "{applicable|not_applicable|blocked}", "triggerEvidenceRefs": ["{evidence}"], "affectedScopeIds": ["{scope-id or remove when not applicable}"], "loadedPath": "rules/integration.md", "blockerOwner": null },
    { "id": "security", "status": "{applicable|not_applicable|blocked}", "triggerEvidenceRefs": ["{evidence}"], "affectedScopeIds": ["{scope-id or remove when not applicable}"], "loadedPath": "rules/security.md", "blockerOwner": null },
    { "id": "observability", "status": "{applicable|not_applicable|blocked}", "triggerEvidenceRefs": ["{evidence}"], "affectedScopeIds": ["{scope-id or remove when not applicable}"], "loadedPath": "rules/observability.md", "blockerOwner": null },
    { "id": "frontend", "status": "{applicable|not_applicable|blocked}", "triggerEvidenceRefs": ["{evidence}"], "affectedScopeIds": ["{scope-id or remove when not applicable}"], "loadedPath": "rules/frontend.md", "blockerOwner": null }
  ]
}
```
