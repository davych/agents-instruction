---
name: designer
description: Design or revise product interfaces from project evidence, including design baselines, specifications, component selection, Figma work, prototypes, and visual validation. Use for UI/UX decisions, design-system component work, interaction states, responsive behavior, accessibility, Figma tasks, or implementation-ready design handoffs. Do not use for product scope, technical architecture, API or data-model decisions, engineering task breakdowns, or production implementation.
---

# Project-aware design

1. Read `ai-native.yaml`, `.ai-sdlc/workflows/default.md`, the Designer config, configured resources and inputs, and the existing Designer outputs.
2. Inspect the smallest representative source slice for the affected surface: shell or routes, shared layouts and components, styles or tokens, one nearby page, and useful tests or stories.
3. Define the user outcome, information hierarchy, primary action, relevant viewports, data conditions, and only states that can occur.
4. Query the project component catalog with `node .ai-sdlc/roles/designer/scripts/component-query.mjs ...` before declaring component APIs. If it is unconfigured, record the gap and rely only on verified local source evidence.
5. Follow [component-policy.md](references/component-policy.md) when no exact component is verified.
6. Update the design baseline only when new project-wide rules or evidence were verified. Keep feature details in the design spec.
7. Read [spec-schema.md](references/spec-schema.md) and start the design spec from `.ai-sdlc/templates/design-spec.md`. Trace it to the relevant stories and acceptance criteria.
8. For Figma work, read [figma-workflow.md](references/figma-workflow.md) before accessing or changing a Figma file.
9. Create a non-production prototype or preview only when explicitly requested to validate an interaction. Mark mock data clearly and never treat it as the production implementation.
10. Complete the `Handoff to Software Engineer` section. Use `blocked` when a missing decision, behavior, component, asset, copy item, or validation result changes what must be built. Use `ready-for-engineering` only when `blockers` is empty.
11. Run `node .ai-sdlc/roles/designer/scripts/validate-spec.mjs <SPEC.md>` after setting the final status and blockers.
12. Hand the resolved design baseline and design spec to the Software Engineer. Implementation still waits for the architecture phase gate.

Resolve Designer output paths in this order:

1. `ai-native.yaml` → `paths.outputs`
2. Designer config → `output.subdirectory`
3. `ai-native.yaml` → the Designer artifact `path`

## Completion checks

- Every in-scope story and acceptance criterion has an observable design response.
- Required states, responsive behavior, accessibility behavior, content, and assets are explicit.
- Every named project or library component has current evidence; custom work has a reason and scope.
- Validation evidence names the checks, viewports, references, and unresolved risks.
- `ready-for-engineering` means `blockers` is empty; otherwise use `draft` or `blocked`.
- The handoff contains design behavior and constraints, not production code, APIs, data models, architecture, or engineering tasks.

Keep assumptions reversible and visible. Prefer the smallest complete artifact and do not ask the Software Engineer to infer a missing design decision.
