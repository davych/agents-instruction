# Core architecture rules

Read this compact pack on every Architect run. It governs architecture method and evidence; the index routes domain-specific policy packs separately.

## Build context before the solution

Capture four layers and cite the source for every material statement:

- **Business:** outcomes, cost or revenue pressure, decision owners, and success measures.
- **Product:** users, critical journeys, channels, and accepted scope.
- **Engineering:** current systems, integrations, data ownership, team and operating limits, and measured behavior.
- **Regulation and policy:** named rules and their specific architecture effect. Never infer that a regulation applies.

Expose at least five consequential hidden assumptions. Record the source clue, what breaks if the assumption is wrong, and who can confirm it.

## Diverge before selecting

- Find load-bearing decisions such as source of truth, synchronous or asynchronous interaction, ownership, build versus buy, and migration shape.
- Options must differ on at least one load-bearing decision; renaming the same topology is not divergence.
- State what each option optimizes, gives up, and may violate.
- Score with evidence-backed criteria and label assumed weights.
- Recommend, but never select for the human owner.
- Pause when the top two weighted scores differ by less than 1.0, or the choice creates irreversible migration, major lock-in, or organization-wide blast radius.

## Keep C4 at the right level

### L1: system context

- Show the focal software system, evidenced people, directly related external systems, and verb-led relationships.
- Do not show containers, stores, deployment nodes, replicas, or low-level protocols.

### L2: containers

- Show evidenced executable or deployable applications and data stores.
- Give every container a responsibility, owner where relevant, and high-level technology.
- Label cross-process relationships with purpose and protocol when known.
- Do not show deployment topology.

Render-check both views in the project’s Mermaid runtime. If C4 syntax is unsupported, use a normal Mermaid flowchart with the same scope and record the fallback.

## Write decisions, not labels

Each ADR needs project forces, one decision, serious alternatives, consequences, validation, related rule IDs, and explicit agent-readable `Must` and `Do not` rules. Keep it `Proposed` until human approval. Never silently rewrite or renumber accepted ADR history.

## Place patterns; do not list a catalog

Record a pattern only when adopted or seriously rejected. Every adopted pattern needs a rule or constraint, a C4 L2 location, a trade-off, and a way to keep it true.

## Make NFRs falsifiable

Each NFR needs a numeric threshold or binary gate, measurement window and condition, responsible C4 element, repeatable method, evidence, visible failure signal, and source rule IDs when applicable. Never invent targets to meet a review floor; block and request a human decision instead.

## Use an independent premortem

Use a fresh session or independent reviewer for confirmed peak load multiplied by ten, relevant malicious input, and a two-hour critical dependency outage. Each finding needs a failing location, trigger, visible impact, mitigation or human-owned risk, owner, and affected artifact.

## Human decisions and pause points

Return final option selection, final trust or compliance boundary placement, irreversible migration, organization-wide platform or vendor commitment, rule waivers, and final pack acceptance to a human owner. Pause when a trust boundary changes, a relevant pack cannot be classified, an NFR cannot be tested, or a rule conflict has no approved resolution.

## Reference material

- [C4 system context](https://c4model.com/diagrams/system-context) and [container diagrams](https://c4model.com/diagrams/container)
- [C4 notation](https://c4model.com/diagrams/notation)
- [Mermaid C4 syntax](https://mermaid.js.org/syntax/c4.html)
- [ADR templates and guidance](https://adr.github.io/adr-templates/)
