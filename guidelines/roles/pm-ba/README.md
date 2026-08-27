# PM / BA Role Guide

This is the human-facing overview for the Product owner of the Discovery phase. The executable role procedure remains in the canonical role workflow linked below.

## Purpose and non-goals

PM / BA turns the current Run's immutable Change Contract into the smallest sufficient product evidence. A new Run does not automatically create or rewrite a full PRD.

A human or the platform records Product Impact before PM / BA may run. PM / BA is invoked only for `partial` or `full` and owns the selected PRD/story clarification or update, not the disposition itself. It does not edit the Change Contract, design an interface, choose architecture or implementation, set unconfirmed priority or policy, or approve release.

## When it runs

| Product disposition | Use when | PM / BA execution |
|---|---|---:|
| `direct` | The Change Contract and an authoritative expected-behavior source already provide observable acceptance and regression scope | 0 |
| `reuse` | Approved PRD/story revisions cover every relevant criterion | 0 |
| `partial` | Product direction remains valid, but named sections, stories, rules, or criteria change | Only selected outputs |
| `full` | Users, outcome, scope, policy, domain, or product model changes materially | Selected complete product outputs |

`direct` and `reuse` are evidence-backed human/platform actions, not empty Agent runs. `partial` and `full` invoke PM / BA only after the route and selected outputs are recorded. If evidence no longer supports the route, return to Product Impact instead of changing it inside the role or generating extra artifacts.

## Inputs and outputs

| Direction | Artifact or evidence | Contract |
|---|---|---|
| Input | `change-contract` | Immutable specification anchor for the current Run; read-only to every Agent |
| Input | Product Impact decision | Human/platform-recorded disposition, rationale, provenance, and selected outputs |
| Input | Configured business Markdown, approved rules, research, existing PRD/stories | Evidence, not automatic human decisions |
| Output | `prd` | Durable project/product baseline, updated only when selected |
| Output | `user-stories` | Categorized story set with stable IDs, updated only when selected |

Artifact paths are resolved through `ai-native.yaml` and the PM / BA owner config. Do not guess a filename or create placeholder PRD/stories for `direct`. The platform derives Product clearance from the recorded route and applicable reviewed evidence; PM / BA does not author the clearance as another artifact.

## What the human reviews

Confirm that:

- the Change Contract was not changed;
- the chosen disposition is the smallest route supported by evidence;
- the user problem, desired outcome, included scope, and non-goals are clear;
- business rules cite evidence or are visibly marked as assumptions;
- every included outcome maps to direct evidence or an applicable stable story criterion;
- acceptance criteria are observable and testable;
- targeted regression obligations remain explicit;
- partial work preserved unrelated PRD sections and story IDs;
- priority, pricing, policy, compliance, and commitments have real human decisions where required;
- every material open decision has an owner and impact.

A polished PRD does not compensate for an ambiguous Change Contract or missing acceptance evidence.

## Handoff and escalation

The Design phase receives the immutable Change Contract, Product disposition, rationale, provenance, applicable PRD/story heads, confirmed rules, assumptions, regression obligations, and open decisions.

Return a gap to the human product owner when it changes scope, priority, pricing, policy, compliance, or acceptance. Return interface questions to Designer and technical-boundary questions to Architect. PM / BA must not silently answer another owner's decision or claim approval that did not occur.

## Canonical sources

- [Canonical PM / BA Agent](../../../templates/agents/pm-ba.md)
- [Global workflow definition](../../../templates/ai-native.yaml)
- [Shared workflow](../../../templates/shared/.ai-sdlc/workflows/default.md)
- [PM / BA workflow](../../../templates/shared/.ai-sdlc/roles/pm-ba/workflow.md)
- [PM / BA config](../../../templates/shared/.ai-sdlc/roles/pm-ba/config.yaml)
- [Specification rules](../../../templates/shared/.ai-sdlc/roles/pm-ba/references/spec-rules.md)
- [PRD template](../../../templates/shared/.ai-sdlc/templates/prd.md)
- [Story template](../../../templates/shared/.ai-sdlc/templates/story.md)
- [Change Contract template](../../../templates/shared/.ai-sdlc/templates/change-contract.md)

Return to [Role Relationships](../README.md).
