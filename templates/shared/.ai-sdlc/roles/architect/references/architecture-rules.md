# Architecture rules

## 1. Build the context before the solution

Capture four layers and cite the source for every material statement:

- **Business:** desired outcomes, cost or revenue pressure, decision owners, and success measures.
- **Product:** users, critical journeys, channels, and accepted scope from the PRD and stories.
- **Engineering:** current systems, integrations, data ownership, team and operating limits, and measured behavior.
- **Regulation and policy:** named rules and their specific architecture effect. Never infer that a regulation applies.

Expose at least five hidden assumptions. For each one, record the source clue, the assumption, what breaks if it is wrong, and who can confirm it.

## 2. Diverge before selecting

- Find the load-bearing decisions: source of truth, sync or async interaction, ownership boundaries, build or buy, migration shape, and similar choices.
- Options must differ on at least one load-bearing decision. Renaming the same topology is not divergence.
- For each option, state the core idea, what it optimizes, what it gives up, and the constraint most likely to reject it.
- Use a 1–5 score and evidence-backed weights. If weights are not confirmed, label equal weights as an assumption.
- Recommend, but do not select. Record a human selection and its evidence before moving to active diagrams.
- Pause when the top two weighted scores differ by less than 1.0, or when the choice creates irreversible migration, major lock-in, or organization-wide blast radius.

## 3. Keep C4 views at the right level

### L1: system context

- Show the focal software system, the people who use it, and directly related external systems.
- Add people and external systems only when the evidence shows they exist. A machine-to-machine system may have no human actor.
- Label each relationship with a clear verb phrase.
- Do not show containers, data stores, deployment nodes, replicas, or low-level protocols.

### L2: containers

- Show the applications and data stores needed to run the selected system.
- Add clients, data stores, queues, and external relationships only when supported by the selected option and evidence.
- Give every container a responsibility and high-level technology choice.
- Label cross-process relationships with purpose and protocol when known.
- Use `ContainerDb` or `ContainerQueue` only when the selected option actually contains one.
- Do not show deployment topology; use a deployment view later if the project needs it.

Mermaid C4 syntax is experimental. Check both `.mmd` files in the project's real Mermaid runtime. If that runtime does not support C4 syntax, use a normal Mermaid flowchart that preserves the same C4 scope and labels, and record the fallback in the index.

## 4. Write decisions, not technology labels

Each ADR must include:

- a verb-led title and status;
- the project context that forces the decision;
- one clear decision;
- serious alternatives and project-specific reasons for rejecting them;
- positive and negative consequences;
- evidence and a way to validate the result;
- an agent-readable summary with explicit `Must` and `Do not` rules.

Keep status `Proposed` until human approval evidence exists. Accepted ADRs are constraints, not suggestions. New work may supersede an ADR, but it must not silently rewrite its history.

## 5. Place patterns; do not list a catalog

Record a pattern only when it was adopted or seriously rejected. For an adopted pattern, name its C4 L2 location, the constraint it addresses, the trade-off it creates, and how the team will keep it true. For a rejected pattern, state the project-specific reason.

## 6. Make NFRs falsifiable

A complete NFR needs:

- a numeric threshold or binary gate;
- a measurement window and operating condition;
- the responsible C4 L2 container or relationship;
- a repeatable test or measurement method;
- the evidence behind the target;
- the visible failure signal and the design behavior that would violate it.

Reach both `quality.minimum_nfrs` and `quality.minimum_nfr_families` using relevant families such as performance, reliability, security and privacy, compliance, cost and capacity, operability, and correctness. If the configured floor does not fit the project, block and ask a human to change the config. Do not force an irrelevant family or invent project targets from an industry average. A proposed range may be cited as a discussion aid, but the NFR stays blocked until a human confirms the target.

## 7. Use an independent premortem

Run the review in a fresh session or with a reviewer who did not create the pack. Give that reviewer the selected pack and evidence, not the author's hidden reasoning.

Test three stressors:

1. **Load:** ten times the confirmed peak baseline. If no baseline exists, record that gap and do not invent one.
2. **Malicious input:** relevant abuse such as injection, replay, authorization bypass, or policy manipulation.
3. **External outage:** a critical external dependency is unavailable for at least two hours.

For each finding, name the failing location, trigger or attack path, visible symptom, mitigation or risk proposed for human acceptance, owner, and affected artifact. The Architect must not accept the risk. A same-session review or a finding without ownership is incomplete.

## Human decisions and pause points

Return these decisions to a human:

- final option selection;
- final trust or compliance boundary placement;
- irreversible migration and cutover order;
- trade-off arbitration when concerns conflict;
- organization-wide platform or vendor commitments;
- final acceptance that the architecture is ready to build.

Pause when a trust boundary changes, an NFR cannot be tested, option scores are too close, a choice is hard to reverse, or the brief names a solution without explaining the problem.

## Reference material

- [C4 system context](https://c4model.com/diagrams/system-context) and [container diagrams](https://c4model.com/diagrams/container)
- [C4 notation](https://c4model.com/diagrams/notation)
- [Mermaid C4 syntax](https://mermaid.js.org/syntax/c4.html)
- [ADR templates and guidance](https://adr.github.io/adr-templates/)
