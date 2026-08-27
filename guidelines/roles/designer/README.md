# Designer Role Guide

This is the human-facing overview for the Design phase. The executable role procedure remains in the canonical role workflow linked below.

## Purpose and non-goals

Designer turns confirmed product needs into the selected design evidence and, only when needed, an implementation-facing handoff under the recorded Design route.

A human or the platform records Design Impact before Designer may run. Designer is invoked only for `partial` or `full` and owns the selected user journeys, information hierarchy, screens and states, responsive/accessibility behavior, verified component/asset/content choices, and design constraints—not the disposition itself. Designer does not set product scope, invent backend behavior, choose APIs or architecture, create engineering tasks, write production code, or claim legal, brand, accessibility, or product approval.

## When it runs

| Design disposition | Use when | Designer execution |
|---|---|---:|
| `skip` | Evidence shows no interface, interaction, copy, responsive, or accessibility change | 0 |
| `reuse` | Exact approved design revisions already cover the affected behavior | 0 |
| `partial` | Existing surface and patterns remain valid, but named behavior or states change | Only selected outputs |
| `full` | A new journey, page family, or material experience model is required | Selected design outputs |

`skip` and `reuse` are evidence-backed human/platform actions and do not invoke Designer. `partial` and `full` invoke Designer only after the route and selected outputs are recorded. A code defect that diverges from approved design normally uses `reuse`; a backend-only change may use `skip`. Unknown user-visible impact cannot be classified as `skip`.

## Inputs and outputs

| Direction | Artifact or evidence | Contract |
|---|---|---|
| Input | Immutable `change-contract` and Product clearance | Outcome, criteria, regression scope, and applicable product evidence |
| Input | Design Impact decision | Human/platform-recorded disposition, rationale, provenance, and selected outputs |
| Input | Existing design evidence, configured Markdown, representative source, component catalog, approved references | Verified project context; missing catalog evidence remains unknown |
| Output | `design-baseline` | Project-wide verified design conventions; not a per-task diary |
| Output | `design-spec` | Run-specific implementation handoff and deferred Verification obligations |
| Optional output | `design-prototype`, `figma-handoff` | Selected supporting evidence only; never automatic requirements |

In a platform-managed Run, the active execution contract supplies selected outputs and Run-specific paths. In a direct IDE session, the human's bounded execution brief names selected artifact IDs and the registered basename paths apply. Unselected or inherited artifacts remain unchanged. The platform derives Design clearance from the recorded route and applicable reviewed evidence; Designer does not author it as another artifact.

## What the human reviews

Confirm that:

- the disposition is supported by real UI/UX impact evidence;
- every applicable acceptance-criteria ID has an observable design response;
- required flows, states, error/empty/loading behavior, responsive rules, keyboard/focus behavior, accessibility, content, and assets are explicit;
- named components, props, tokens, and local patterns were verified rather than guessed;
- the project baseline contains only project-wide evidence and the task spec contains task-specific decisions;
- blockers identify an owner and next action;
- checks that require the runnable implementation appear as stable `deferred_validations` owned by Tester rather than impossible Design blockers;
- `ready-for-engineering` is used only when the selected spec is complete and blockers are empty;
- prototype or Figma claims point to real work and do not imply production readiness or approval.

A deferred validation may postpone execution evidence, but it must not postpone defining the expected observable behavior or pass criteria.

## Handoff and escalation

Architect and Software Engineer receive the Design clearance and applicable selected artifacts. The handoff names covered criteria, build scope, behavior to preserve, responsive/accessibility constraints, verified components/assets/content, allowed flexibility, validation evidence, deferred validations, assumptions, and remaining risks.

Return product scope or policy to PM / BA or the human owner. Return API, data, security, NFR, or system-boundary questions to Architect. Keep the phase blocked when a missing design decision changes what must be built; do not ask Software Engineer to invent it.

## Canonical sources

- [Canonical Designer Agent](../../../templates/agents/designer.md)
- [Global workflow definition](../../../templates/ai-native.yaml)
- [Shared workflow](../../../templates/shared/.ai-sdlc/workflows/default.md)
- [Designer workflow](../../../templates/shared/.ai-sdlc/roles/designer/workflow.md)
- [Designer config](../../../templates/shared/.ai-sdlc/roles/designer/config.yaml)
- [Component policy](../../../templates/shared/.ai-sdlc/roles/designer/references/component-policy.md)
- [Design spec schema](../../../templates/shared/.ai-sdlc/roles/designer/references/spec-schema.md)
- [Figma workflow](../../../templates/shared/.ai-sdlc/roles/designer/references/figma-workflow.md)
- [Design baseline template](../../../templates/shared/.ai-sdlc/templates/design-baseline.md)
- [Design spec template](../../../templates/shared/.ai-sdlc/templates/design-spec.md)

Return to [Role Relationships](../README.md).
