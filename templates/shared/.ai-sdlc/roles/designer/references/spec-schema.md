# Design SPEC contract

Start a SPEC with one machine-readable JSON block, followed by concise rationale.

## JSON fields

- `spec_version`: `1.0`.
- `title`, `mode` (`new` or `change`), and `status` (`draft`, `blocked`, or `ready-for-engineering`).
- `framework`: optional project fact; do not infer it from installed packages alone.
- `source`: input artifact IDs, Markdown paths, approved references, or inline requests.
- `extends`: required when `mode` is `change`.
- `screens`: each item needs `id`, `layout`, and applicable `states`; include `default`.
- `components`: each item needs `name` and `source` (`project`, `library`, or `custom`). Only declare verified props and states. Custom components follow the component policy.
- `acceptance_criteria`: each supplied criterion needs an `id`, `requirement`, and observable `design_response`.
- `figma`: optional; include only real file and node identifiers verified during the current work.
- `assumptions` and `open_questions`: keep them short and non-duplicative. Open questions must be non-blocking; move anything that changes what must be built to `blockers`.
- `blockers`: an array of decisions or missing evidence that prevents implementation. It must be empty when status is `ready-for-engineering`, and non-empty when status is `blocked`.

`ready-for-engineering` means the design handoff is complete enough to implement. It is not product, legal, accessibility, or architecture approval.

## Markdown body

Use the template sections needed to explain intent, coverage, layout, states, responsive behavior, components and assets, accessibility and content, and validation. Reference every acceptance-criteria ID at least once.

End with `Handoff to Software Engineer`. It must identify the next owner, build scope, behavior the developer must preserve, details they must not infer, validation evidence, allowed design flexibility, and open decisions or blockers. The handoff does not contain production code, API or data-model choices, architecture, or engineering task breakdowns.

Do not record package facts, component APIs, visual tokens, or fidelity claims without evidence from the current project.
