# Architect Role Guide

This is the human-facing overview for the Architecture phase. The executable role procedure and machine rulebook remain in the canonical sources linked below.

## Purpose and non-goals

Architect turns confirmed product and design intent into evidence-based options and an indexed architecture pack. Architect recommends a direction; a human selects and accepts it.

A human or the platform records Architecture Impact before Architect may run. Architect is invoked only for `partial` or `full` and owns the selected discovery, options, C4 boundaries, ADR proposals, pattern decisions, measurable NFRs, and adversarial risk evidence—not the disposition itself. Architect does not choose product scope, approve its own option, accept risk, write production code, or approve release.

## When it runs

| Architecture disposition | Use when | Architect execution |
|---|---|---:|
| `skip` | A bounded bug/technical task has evidenced no boundary, API/schema, data, integration, security, NFR, deployment, or operational impact | 0 |
| `reuse` | The accepted pack remains fully applicable | 0 |
| `partial` | The selected direction remains valid and affected outputs can be named | Only `architecture` plus selected affected outputs |
| `full` | Direction, ownership, project mode, rule applicability, constraints, or quality targets may change | Bootstrap, human selection, then selected-state completion |

`skip` and `reuse` are evidence-backed human/platform actions and do not invoke Architect. `partial` and `full` invoke Architect only after the route and selected outputs are recorded.

Full Architecture has three distinct human moments:

1. answer concrete blocking decisions;
2. select one current option against the exact Options revision;
3. accept or reject the completed selected-state pack.

Option selection is not final Architecture approval. Do not rerun Architect repeatedly while a concrete decision card still requires a human answer.

## Inputs and outputs

Inputs include the immutable Change Contract, the human/platform-recorded Architecture Impact decision, active Product and Design clearances, applicable product/design artifacts, configured architecture evidence, the current architecture index, and accepted ADRs. Conditional inputs do not require placeholder PRDs or design specs.

The architecture pack contains:

| Artifact | Human meaning |
|---|---|
| `architecture` | Authoritative status, selected direction, active constraints, and index |
| `architecture-discovery-context` | Evidence, constraints, project mode, rule-pack applicability, and assumptions |
| `architecture-options` | Genuinely different candidates, scoring, trade-offs, and recommendation |
| C4 context and containers | Accepted people, systems, executable boundaries, data ownership, and communication |
| `architecture-adrs` | Individual decisions, consequences, alternatives, and agent-readable rules |
| `architecture-patterns` | Adopted or seriously rejected patterns and their locations |
| `architecture-nfrs` | Measurable quality budgets and verification methods |
| `architecture-adversarial` | Independent stressors, findings, mitigations, and open risk decisions |

Downstream reading always starts at `architecture`. A child file or pending scaffold cannot activate an unaccepted pack.

## What the human reviews

Confirm that:

- discovery cites current evidence and leaves unknown domain, load, cost, regulation, reliability, and security values unknown;
- options differ on load-bearing decisions and make costs, risks, rule constraints, and rejected alternatives visible;
- the selected option matches the exact current Options revision and rulebook digest;
- C4 views, ADRs, patterns, NFRs, and adversarial evidence all bind to the same selected direction;
- Brownfield evidence was not replaced by Greenfield defaults;
- applicable rule packs and final rule dispositions are complete without adding irrelevant patterns merely to reach a count;
- NFRs have measurable targets, windows, owners, methods, evidence, and failure signals;
- premortem independence is credible and unsupported baselines were not invented;
- open decisions and residual risks have human owners;
- the index links only current active material.

A recommendation, selected option, complete file set, or passing machine structure check does not substitute for human Architecture acceptance.

## Handoff and escalation

Software Engineer, Tester, and DevOps start from the accepted `architecture` index and follow only active links. The handoff includes selection evidence, boundaries, accepted/proposed ADR status, Must/Do-not constraints, pattern placement, measurable NFRs, adversarial findings, assumptions, and open decisions.

Return scope and user-outcome questions to PM / BA, visible behavior to Designer, and final option selection, trust-boundary placement, irreversible migration, vendor commitment, risk acceptance, or pack acceptance to the human architecture owner. Keep the phase pending or blocked until those decisions exist.

## Canonical sources

- [Canonical Architect Agent](../../../templates/agents/architect.md)
- [Global workflow definition](../../../templates/ai-native.yaml)
- [Shared workflow](../../../templates/shared/.ai-sdlc/workflows/default.md)
- [Architect workflow](../../../templates/shared/.ai-sdlc/roles/architect/workflow.md)
- [Architect config](../../../templates/shared/.ai-sdlc/roles/architect/config.yaml)
- [Architecture rulebook index](../../../templates/shared/.ai-sdlc/roles/architect/references/architecture-rules.md)
- [Architecture rule packs](../../../templates/shared/.ai-sdlc/roles/architect/references/rules)
- [Architecture artifact templates](../../../templates/shared/.ai-sdlc/templates)

Return to [Role Relationships](../README.md).
