# Architecture rulebook index

Read this file and [the core rules](rules/core.md) on every Architect run. This file is the small router for the rulebook; the other files under `rules/` are conditional packs. Do not load a conditional pack merely because it exists. Load every pack whose trigger is supported by evidence, and load a pack whose applicability is still unknown when that uncertainty could change an option or trust boundary.

These rules constrain architecture work; they do not replace project evidence or select an option for the human owner.

## Enforcement levels

| Level | Meaning |
|-------|---------|
| `MUST` | Required whenever the stated scope exists. A conflict blocks readiness until a human changes the rule or approves a superseding ADR. |
| `DEFAULT` | Preferred when its trigger applies. Brownfield compatibility may preserve an evidenced existing convention. The rule's `Deviation` policy says whether an evidence-backed reason is sufficient or an accepted ADR is always required. |
| `WHEN` | Evaluate the trigger explicitly. If true, the requirement becomes mandatory; if false, record `Not triggered` rather than adopting the pattern. |
| `FORBIDDEN` | Do not introduce it. Only an explicit human rule change or superseding accepted ADR can remove the prohibition. |

Rules never turn an assumption into a fact. If evidence is missing, mark the rule or pack `Blocked` and name the evidence owner.

## Project mode

Classify the affected scope before applying technology defaults:

| Mode | Evidence | Effect |
|------|----------|--------|
| `Greenfield` | No implemented system exists in the affected scope. | Apply relevant `DEFAULT` rules unless the selected option documents a justified deviation. |
| `Brownfield` | Manifests, lockfiles, source, tests, deployed behavior, or accepted ADRs show an existing implementation. | Derive current patterns from the implementation. Do not replace its framework or cross-cutting conventions merely to match a default. |
| `Hybrid` | Existing components are extended while an isolated new scope is created. | Apply brownfield rules at existing boundaries and greenfield defaults only inside a clearly defined new boundary. |

Use `rulebook.project_mode` from the Architect config when a human sets it. When it is `auto`, cite repository or operational evidence for the classification. A product described as “new” is not enough to call a repository greenfield when implementation evidence exists.

## Conditional pack router

Evaluate every row and record the result in the Discovery Context Rule Pack Applicability Matrix.

| Pack | Load when | It may be `Not applicable` only when | Path | Primary evidence targets |
|------|-----------|--------------------------------------|------|--------------------------|
| API | The scope exposes or consumes a first-party HTTP/JSON API, webhook, or frontend/backend contract. | No HTTP application contract is in scope. | [API rules](rules/api.md) | Options, C4 relationships, ADRs, Patterns |
| Data | The scope persists business data, owns a data store, publishes state-change events, or proposes a cache. | It is stateless and neither reads nor writes owned persistent data. | [Data rules](rules/data.md) | C4 containers, ADRs, Patterns, NFRs |
| Integration | A process calls another process or external system, uses messaging, or crosses a semantic boundary. | The selected scope has no remote or asynchronous dependency. | [Integration rules](rules/integration.md) | C4 relationships, ADRs, Patterns, NFRs |
| Security | Users, service identities, protected actions, trust boundaries, or sensitive fields exist. | The evidence shows none of those concerns in scope. | [Security rules](rules/security.md) | C4 trust boundaries, ADRs, Patterns, NFRs, premortem |
| Observability | The selected system has a deployable runtime, inbound request, job, event consumer, or remote call. | No runtime behavior is being designed. | [Observability rules](rules/observability.md) | C4 containers, Patterns, NFRs, premortem |
| Frontend | A browser or other interactive client is in scope, or an existing frontend is affected. | No interactive client is created or changed. | [Frontend rules](rules/frontend.md) | Discovery evidence, ADRs, Patterns, C4 |

For an `Applicable` pack, read the whole pack. For a `Blocked` pack, read enough to identify the decision and evidence needed. Do not read a `Not applicable` pack after recording the evidence unless later evidence changes the result.

## Required traceability

1. In `architecture-discovery-context`, record all six packs as `Applicable`, `Not applicable`, or `Blocked`, with trigger evidence and project mode.
2. In `architecture-options`, show which applicable rules constrain or reject each option. A rule must not silently preselect an option.
3. After human option selection, enumerate every rule × affected scope from every applicable pack exactly once in the `architecture-patterns` Rule Disposition Register as `Adopted`, `Not triggered`, `Justified deviation`, `Exception`, or `Blocked`.
4. Put topology and ownership effects in C4, material cross-project decisions and exceptions in ADRs, reusable implementation rules in Patterns, and measurable quality gates in NFRs. Link those artifacts from the rule register.
5. Summarize pack status in `architecture.md`. A pack or rule marked `Blocked` prevents `Ready for human acceptance` when it affects selected scope.

`Justified deviation` is only for a triggered `DEFAULT` whose catalog `Deviation` policy is `Reason allowed`; it needs a concrete reason and evidence but no ADR. A rule marked `ADR required`, or any `MUST`/`FORBIDDEN` waiver, uses `Exception` and needs a human-approved superseding ADR. The first Architect run may stop after context, options, and the index. It must still complete pack applicability and option constraints. The selected-state run completes the rule × scope disposition register and evidence links. No loaded rule may disappear between those runs without an evidence-backed applicability change.

## Machine gate

When `rulebook.validation` is `required`, human-readable tables are paired with the unique rulebook v1 JSON blocks in the Discovery, Options, Architecture, and Patterns templates. Run `node .ai-sdlc/roles/architect/scripts/rulebook-digest.mjs` and copy its exact digest into all four blocks. The digest binds `rulebook.project_mode`, the index, core, and every domain pack. The platform rejects option selection or final approval for a missing/duplicate block, stale digest, configured-mode mismatch, missing rule × scope disposition, mismatched selection evidence, blocked rule, inconsistent pack status, unapproved exception, or Greenfield frontend default forced onto a Brownfield boundary.

The machine block is traceability metadata, not a substitute for the evidence and trade-offs in the Markdown document.
