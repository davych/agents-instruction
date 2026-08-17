# Designer workflow

Turn confirmed product needs and project evidence into the selected, reviewable design outputs.

## Steps

1. Read `ai-native.yaml`, `.ai-sdlc/workflows/default.md`, the Designer config, configured resources and inputs, and the execution contract's selected output list.
2. Resolve and read existing versions of the selected outputs. Do not create, update, or refresh an output that is not selected.
3. Inspect the smallest representative source slice for the affected surface: shell or routes, shared layouts and components, styles or tokens, one nearby page, and useful tests or stories.
4. Define the user outcome, information hierarchy, primary action, relevant viewports, data conditions, and only states that can occur.
5. Query the project component catalog with `node .ai-sdlc/roles/designer/scripts/component-query.mjs ...` before declaring component APIs. If it is unconfigured, record the gap and rely only on verified local source evidence.
6. Follow [component-policy.md](references/component-policy.md) when no exact component is verified.
7. When `design-baseline` is selected, update it only when new project-wide rules or evidence were verified. Keep feature details out of the baseline.
8. When `design-spec` is selected, read [spec-schema.md](references/spec-schema.md), start from `.ai-sdlc/templates/design-spec.md`, and trace the spec to the relevant stories and acceptance criteria.
9. When `design-prototype` is selected, create the registered `prototype.html` as a self-contained, non-production HTML/CSS prototype. Clearly label mock data; use only verified states and patterns; use native HTML/CSS states such as `details` or checkboxes instead of scripts; do not call production APIs, include credentials, send analytics, or load required runtime code from the network.
10. When `figma-handoff` is selected, read [figma-workflow.md](references/figma-workflow.md) before accessing Figma. Confirm the current session has the required read or edit access before making claims. Create the registered handoff only from real, verified Figma evidence.
11. When `design-spec` is selected, complete `Handoff to Software Engineer`. Use `blocked` when a missing decision, behavior, component, asset, copy item, or validation result changes what must be built. Use `ready-for-engineering` only when `blockers` is empty, then run `node .ai-sdlc/roles/designer/scripts/validate-spec.mjs <SPEC.md>`.
12. Submit only the selected outputs for human review. Downstream implementation still requires every input declared in `ai-native.yaml` and the architecture phase gate.

Resolve Designer output paths in this order:

1. `ai-native.yaml` → `paths.outputs`
2. Designer config → `output.subdirectory`
3. `ai-native.yaml` → the Designer artifact `path`

The platform may then resolve `design-spec` to a task-scoped filename containing the current task namespace. When present, the execution contract's resolved path overrides only the physical filename; the logical artifact ID stays `design-spec`. Re-runs of the same task reuse that path, and outputs not selected for the re-run must remain unchanged.

## Completion checks

- Every in-scope story and acceptance criterion has an observable design response.
- Required states, responsive behavior, accessibility behavior, content, and assets are explicit.
- Every named project or library component has current evidence; custom work has a reason and scope.
- Validation evidence names the checks, viewports, references, and unresolved risks.
- A selected `design-spec` uses `ready-for-engineering` only when `blockers` is empty; otherwise it uses `draft` or `blocked`.
- A selected `design-prototype` is one self-contained, script-free HTML file, visibly marked non-production, and has no production or external side effects.
- A selected `figma-handoff` points only to Figma work accessed or changed in the current session and records real verification evidence.
- The selected handoff artifacts contain design behavior and constraints, not production code, APIs, data models, architecture, or engineering tasks.

Keep assumptions reversible and visible. Prefer the smallest complete artifact and do not ask the Software Engineer to infer a missing design decision.
