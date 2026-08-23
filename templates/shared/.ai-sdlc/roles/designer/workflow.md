# Designer workflow

Choose the smallest sufficient design path from the recorded Design Impact disposition, then create only the selected, reviewable outputs when design work is required.

## Steps

1. Read `ai-native.yaml`, `.ai-sdlc/workflows/default.md`, the current Run's immutable Change Contract, the Designer config, configured resources and inputs, and the execution contract's Design disposition, source evidence, and selected output list.
2. Follow the disposition before doing design generation:
   - `skip`: do not run Designer or create placeholder outputs. The platform records why no interface, interaction, copy, responsive, or accessibility behavior changes.
   - `reuse`: do not run Designer. The platform imports approved design revisions that cover the exact behavior and acceptance criteria.
   - `partial`: resolve imported baselines and update only the declared task behavior or project-wide evidence.
   - `full`: create a new task-scoped design spec for a new journey or material experience model while reusing the project baseline where valid.
3. For `partial` or `full`, resolve and read existing versions of selected outputs. Do not create, update, or refresh an output that is not selected.
4. Inspect the smallest representative source slice for the affected surface: shell or routes, shared layouts and components, styles or tokens, one nearby page, and useful tests or stories.
5. Define the user outcome, information hierarchy, primary action, relevant viewports, data conditions, and only states that can occur.
6. Query the project component catalog with `node .ai-sdlc/roles/designer/scripts/component-query.mjs ...` before declaring component APIs. If it is unconfigured, record the gap and rely only on verified local source evidence.
7. Follow [component-policy.md](references/component-policy.md) when no exact component is verified.
8. When `design-baseline` is selected, update it only when new project-wide rules or evidence were verified. Keep feature details out of the baseline; do not select it just because a new Run exists.
9. When `design-spec` is selected, read [spec-schema.md](references/spec-schema.md), start from `.ai-sdlc/templates/design-spec.md` only when no applicable spec exists, and trace the spec to Change Contract or story acceptance criteria.
10. When `design-prototype` is selected, create the registered `prototype.html` as a self-contained, non-production HTML/CSS prototype. Clearly label mock data; use only verified states and patterns; use native HTML/CSS states such as `details` or checkboxes instead of scripts; do not call production APIs, include credentials, send analytics, or load required runtime code from the network.
11. When `figma-handoff` is selected, read [figma-workflow.md](references/figma-workflow.md) before accessing Figma. Confirm the current session has the required read or edit access before making claims. Create the registered handoff only from real, verified Figma evidence.
12. When `design-spec` is selected, complete `Handoff to Software Engineer`. Use `blocked` when a missing decision, behavior, component, asset, copy item, or validation result changes what must be built. A check that explicitly requires the final runnable implementation is different: define its observable behavior and pass criteria now, move it to `deferred_validations` with owner `tester` and phase `verification`, and keep it out of `blockers`. Use `ready-for-engineering` only when active `blockers` is empty, then run `node .ai-sdlc/roles/designer/scripts/validate-spec.mjs <SPEC.md>`.
13. Submit only selected outputs for human review. Downstream implementation consumes the active product, design, and architecture clearances rather than demanding fake files for a skipped phase.

Resolve Designer output paths in this order:

1. `ai-native.yaml` → `paths.outputs`
2. Designer config → `output.subdirectory`
3. `ai-native.yaml` → the Designer artifact `path`

The platform may then resolve `design-spec` to a task-scoped filename containing the current task namespace. When present, the execution contract's resolved path overrides only the physical filename; the logical artifact ID stays `design-spec`. Re-runs of the same task reuse that path, and outputs not selected for the re-run must remain unchanged.

## Completion checks

- `skip` has evidence that no user-facing behavior changes; `reuse` names approved evidence that covers the current Change Contract.
- An implementation bug that diverges from an approved design uses `reuse`; it does not create a new design merely to describe the defect.
- Every in-scope story and acceptance criterion has an observable design response.
- Required states, responsive behavior, accessibility behavior, content, and assets are explicit.
- Every named project or library component has current evidence; custom work has a reason and scope.
- Validation evidence names the checks, viewports, references, and unresolved risks.
- Every deferred validation has a stable ID, runnable prerequisite, targets, checks, pass criteria, supported `evidence_types`, release impact, exact `on_fail: block_verification` / `on_missing: block_verification` gates, and explicit Tester / Verification ownership. It is never duplicated in `blockers`.
- A selected `design-spec` uses `ready-for-engineering` only when `blockers` is empty; otherwise it uses `draft` or `blocked`.
- A selected `design-prototype` is one self-contained, script-free HTML file, visibly marked non-production, and has no production or external side effects.
- A selected `figma-handoff` points only to Figma work accessed or changed in the current session and records real verification evidence.
- The selected handoff artifacts contain design behavior and constraints, not production code, APIs, data models, architecture, or engineering tasks.
- A changed or newly discovered UI, interaction, content, responsive, or accessibility requirement invalidates `skip` and returns to Design Impact.

Keep assumptions reversible and visible. Prefer the smallest complete artifact and do not ask the Software Engineer to infer a missing design decision.

## Retry-loop guard

When feedback says a B-04 or similar browser/accessibility check must happen only
after the implementation is runnable, do not keep attempting the unavailable check
inside Design. Preserve the obligation ID, remove it from `blockers`, add it to
`deferred_validations`, make the handoff `ready-for-engineering` if no other blocker
remains, and state that Tester will execute it in Verification. If the check can run
against the current design prototype or existing product now, it remains Designer
work and must not be deferred.
