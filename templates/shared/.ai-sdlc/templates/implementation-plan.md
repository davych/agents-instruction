# Engineering Implementation Plan: <Run title>

> Keep every heading and table column. This artifact records strategy and vertical-slice boundaries, not task status. Executable work belongs in `implementation-tasks`.

## Status

**State:** <Draft / Blocked / Ready for implementation / Implemented>
**Run:** <Run ID>
**Updated:** <YYYY-MM-DD or platform timestamp>
**Blockers:** <None, or blocker + owner + evidence needed>

## Authoritative inputs

| Input | Artifact ID or path | Revision / clearance | Role in this plan |
|---|---|---|---|
| Immutable specification | `artifact:change-contract` | <revision> | Scope, observable criteria, regression obligations |
| Product clearance | <direct / reuse / partial / full evidence> | <revision> | <applicable business evidence> |
| Design clearance | <skip / reuse / partial / full evidence> | <revision> | <applicable observable behaviour> |
| Architecture clearance | <skip / reuse / partial / full evidence> | <revision> | <active index, decisions, boundaries, NFRs> |

The Change Contract and active PM / BA evidence are authoritative. This plan does not create or replace a `spec.md`. When a Change Contract criterion has no ID, assign `CC-AC-001`, `CC-AC-002`, and so on by its source array order only for traceability, and record that source position below without modifying the contract. Preserve stable story AC IDs alongside the derived Change Contract aliases.

## Change classification

**Mode:** <Greenfield / Brownfield / Hybrid>

**Evidence:** <repository and accepted architecture evidence supporting the classification>

**Boundary:** <for Hybrid, name the Greenfield and Brownfield portions separately; otherwise state the affected boundary>

## Scope

**Included:**

- <Confirmed scope with criterion IDs>

**Not included:**

- <Confirmed non-goal>

## Preserved behaviour

<Existing behaviour that must remain unchanged, or `Not applicable — confirmed new capability`.>

## ADDED

- <New behaviour, source criterion, affected boundary, and planned evidence, or None>

## MODIFIED

- <Existing -> expected behaviour, source criterion, affected boundary, and planned evidence, or None>

## REMOVED

- <Removed behaviour and explicit contract authority, or None>

## REMOVED audit

- <Existing tests, interfaces, error handling, data compatibility, and active rules checked. If REMOVED is None, explain how that was verified.>

## Context loaded

| Layer | Path or artifact | Why relevant | Confirmed fact, constraint, or gap |
|---|---|---|---|
| Hot | <AGENTS.md / CLAUDE.md / None> | <reason> | <evidence> |
| Warm | <path / None> | <reason> | <evidence> |
| Cold | <path / None> | <reason> | <evidence> |

## Vertical slice strategy

**User/system-observable outcome:** <one complete result>

**Slice boundary:** <entry point through necessary layers to observable output>

**Why this is the smallest complete slice:** <reason>

**Sequence:**

1. <bounded implementation step>
2. <bounded implementation step>
3. <verification and evidence step>

## Repository change map

| Area or boundary | Existing evidence | Intended change | Must preserve | Active design / ADR / NFR constraint |
|---|---|---|---|---|
| <path, component, service, schema, or config> | <source/test/reference> | <change> | <behaviour> | <constraint or None> |

## Acceptance coverage plan

| Trace ID | Source ID / position | Observable obligation | Planned implementation area | Planned independent evidence |
|---|---|---|---|---|
| CC-AC-001 | <existing ID or Change Contract criterion 1> | <criterion> | <path/component> | <test level and intent> |
| <stable story AC ID> | <same stable ID> | <criterion> | <path/component> | <test level and intent> |
| REG-001 | <Change Contract regression item> | <preserved behaviour> | <path/component or no-code> | <targeted regression test> |

## Technical constraints

- **Repository conventions:** <confirmed conventions>
- **Design behaviour:** <active constraints or Not applicable>
- **Architecture rules / ADRs:** <IDs and requirements>
- **NFR budgets:** <IDs, targets, and measurement method>
- **Security/data constraints:** <confirmed constraints>
- **Dependency policy:** <existing dependency / human approval needed>

## Verification strategy

- **Target isolation tier:** <A / B; use C or Limited only as an anticipated blocker>
- **Independent author input:** <contract and public constraints only>
- **Focused checks:** <repository-supported commands to discover/run>
- **Regression checks:** <scope>
- **CI-equivalent checks:** <scope>
- **Review independence:** <fresh reviewer/session plan>

## Risk note

| Risk or decision | Evidence | Owner | Required action | Status |
|---|---|---|---|---|
| <item or None> | <reference> | <human/role> | <action> | <Open / Resolved / Blocked> |

## Exit criteria

- [ ] Every in-scope criterion and regression obligation maps to implementation and verification.
- [ ] The separately registered `implementation-tasks` artifact is executable and current.
- [ ] Real source and test changes implement the confirmed vertical slice.
- [ ] Independent verification is Tier A/B, or an explicit human waiver is linked.
- [ ] Required project checks pass with exact command evidence.
- [ ] Seven-lens and adversarial review has no unresolved blocker.
- [ ] Implementation notes and provenance link the complete registered engineering pack.
