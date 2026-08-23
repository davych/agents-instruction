# Contract-driven engineering

This platform already has a specification authority: the immutable Run Change Contract together with the active Product clearance and its approved PM / BA evidence. Software Engineer consumes that contract. It must not create a parallel `spec.md`, revise acceptance wording, or make a scope decision inside an implementation document.

## Evidence order

1. Immutable Change Contract and its observable acceptance and regression obligations.
2. Active Product disposition and applicable approved PRD or story evidence.
3. Active Design disposition and applicable ready design evidence.
4. Active accepted Architecture index and the active child evidence it links.
5. Relevant repository behaviour, tests, and project context.

A lower item may explain implementation detail but cannot silently override a higher authoritative item. Contradictions are blockers returned to the owning impact check.

Preserve every stable criterion ID supplied by the contract or a story. If a Change Contract criterion has no ID, use its array order to derive `CC-AC-001`, `CC-AC-002`, and so on only in engineering traceability evidence. Record the source position; never write the derived alias back into the immutable contract.

## Change modes

### Greenfield scope

- Trace every confirmed criterion to the new vertical slice.
- Reuse accepted project conventions and architecture; greenfield does not mean unconstrained.
- Plan the smallest complete path that produces observable value and can be independently verified.

### Brownfield scope

- Begin with a preserved-behaviour statement.
- Record ADDED, MODIFIED, and REMOVED behaviour in the implementation plan.
- A legitimate no-removal change uses `REMOVED: None` plus an audit explanation.
- Verify every actual removal against the Change Contract, existing tests, public interfaces, error handling, data compatibility, and active architecture rules.
- Never delete tests merely to make a changed implementation pass.

### Hybrid scope

- Name the new and existing boundaries separately.
- Apply Brownfield preservation rules to existing behaviour and Greenfield rules only inside the confirmed new boundary.
- Do not migrate an existing boundary to a preferred new pattern without an accepted architecture decision.

## Planning contract

`implementation-plan` owns:

- authoritative input revisions;
- preserved behaviour and non-goals;
- one smallest complete vertical-slice strategy;
- affected repository boundaries and constraints;
- test-isolation strategy, risks, and exit criteria.

It does not own task status. `implementation-tasks` separately owns stable task IDs, dependencies, repository targets, AC and regression mappings, state, and evidence links.

## Ambiguity handling

Classify a missing or conflicting statement as one of:

- **Product ambiguity:** changes user outcome, business rule, scope, acceptance, or priority; return to Product/human owner.
- **Design ambiguity:** changes interaction, content, state, responsive, or accessibility behaviour; return to Design Impact.
- **Architecture ambiguity:** changes a boundary, API/schema, data owner, integration, security model, NFR, deployment, or operational decision; return to Architecture Impact.
- **Local implementation choice:** stays within all confirmed contracts and project conventions; Software Engineer may choose it and record the rejected alternatives.

Do not continue by converting an ambiguity into an assumption when different answers would produce materially different behaviour or evidence.
