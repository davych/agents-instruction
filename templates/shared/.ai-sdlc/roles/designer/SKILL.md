---
name: designer
description: Design or revise product interfaces from project evidence, including design baselines, specifications, component selection, Figma work, prototypes, and visual validation. Use for UI/UX decisions, design-system component work, interaction states, responsive behavior, accessibility, Figma tasks, or implementation-ready design handoffs.
---

# Project-aware design

1. Read `ai-native.yaml`, the Designer config, role, personal profile, configured inputs, and the existing design baseline when present.
2. Inspect the smallest representative source slice for the affected surface: shell or routes, shared layouts and components, styles or tokens, one nearby page, and useful tests or stories.
3. Define the user outcome, information hierarchy, primary action, relevant viewports, data conditions, and only states that can occur.
4. Query the project component catalog with `node .ai-sdlc/roles/designer/scripts/component-query.mjs ...` before declaring component APIs. If it is unconfigured, record the gap and rely only on verified local source evidence.
5. Follow [component-policy.md](references/component-policy.md) when no exact component is verified.
6. For a design specification, read [spec-schema.md](references/spec-schema.md), start from `.ai-sdlc/templates/design-spec.md`, and run `node .ai-sdlc/roles/designer/scripts/validate-spec.mjs <SPEC.md>` before handoff.
7. For a prototype or preview, use the project's current stack, components, and data patterns. Mark mock data clearly. Render and check the requested screen sizes. Do not build a separate fake UI when the task should change the real product.
8. For Figma work, read [figma-workflow.md](references/figma-workflow.md) before accessing or changing a Figma file.
9. Write artifacts under the global output root from `ai-native.yaml`, the Designer subdirectory from `config.yaml`, and the artifact filename from the global YAML.

Keep assumptions reversible and visible. Prefer the smallest complete artifact and report decisions, evidence, risks, validation, and the next handoff.
