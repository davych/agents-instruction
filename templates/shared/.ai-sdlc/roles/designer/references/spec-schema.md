# Design SPEC contract

Start a SPEC with one machine-readable JSON block, followed by concise rationale.

## JSON fields

- `spec_version`: `1.0`.
- `title`, `mode` (`new` or `change`), and `status`.
- `framework`: optional project fact; do not infer it from installed packages alone.
- `source`: input artifact IDs, Markdown paths, approved references, or inline requests.
- `extends`: required when `mode` is `change`.
- `screens`: each item needs `id`, `layout`, and applicable `states`; include `default`.
- `components`: each item needs `name` and `source` (`project`, `library`, or `custom`). Only declare verified props and states. Custom components follow the component policy.
- `acceptance_criteria`: each supplied criterion needs an `id`, `requirement`, and observable `design_response`.
- `figma`: optional; include only real file and node identifiers verified during the current work.
- `assumptions` and `open_questions`: keep them short and non-duplicative.

## Markdown body

Use only useful sections. A practical default is `Intent`, `Experience and layout`, `States and behavior`, and `Validation`. Reference every acceptance-criteria ID at least once.

Do not record package facts, component APIs, visual tokens, or fidelity claims without evidence from the current project.
