# Default workflow

Use `ai-native.yaml` as the source of truth and work in this order:

1. The platform or human creates one immutable, task-scoped `change-contract` for the Run.
2. Product Impact records `direct`, `reuse`, `partial`, or `full`; PM / BA runs only for `partial` or `full` and does not rewrite the Change Contract.
3. Design Impact records `skip`, `reuse`, `partial`, or `full`; Designer runs only for `partial` or `full` and keeps the design baseline project-wide and design specs task-scoped.
4. Architecture Impact records `skip`, `reuse`, `partial`, or `full`; Architect runs only for `partial` or `full`.
5. After all three clearances pass, Software Engineer implements the confirmed work and records implementation notes.
6. Tester checks the Change Contract, applicable acceptance criteria, risks, and regression obligations, then creates the test report.
7. DevOps prepares release, monitoring, and rollback guidance.

Start artifacts from `.ai-sdlc/templates/`. Resolve every input and output artifact in this order:

1. Find the artifact in `ai-native.yaml` and read its `owner` and `path`.
2. Start with `paths.outputs` from `ai-native.yaml`.
3. If `.ai-sdlc/roles/<owner>/config.yaml` exists, append that role's `output.subdirectory`.
4. Append the artifact `path`.

For a platform-managed task, use the resolved paths in the active execution contract after applying the steps above. In particular, `change-contract` and `design-spec` receive task-scoped filenames derived from the task title and run ID; never replace them with their configured default basenames. The Change Contract is an immutable human artifact. A local re-run may select only part of a phase's outputs, so every unselected output must remain unchanged.

The phase inputs in `ai-native.yaml` declare the complete evidence vocabulary. The platform's recorded disposition and active execution contract resolve the concrete input alternative for a Run. A valid `direct`, `skip`, or `reuse` clearance can therefore satisfy a phase without manufacturing empty PRDs, stories, design specs, or Agent executions. Older initialized projects that do not list `change-contract` are extended by the platform without rewriting their project-owned YAML.

## Impact routing

- Product `direct`: the Change Contract and an authoritative expected-behavior reference are sufficient; run no PM / BA Agent.
- Product `reuse`: import approved PRD/story revisions with provenance; run no PM / BA Agent.
- Product `partial`: import the baseline and let PM / BA update only selected PRD/story outputs.
- Product `full`: create or comprehensively revise PRD and stories for a new or materially changed product model.
- Design `skip`: record evidence that no interface, interaction, copy, responsive, or accessibility behavior changes; run no Designer.
- Design `reuse`: import approved design evidence that exactly covers the Run; run no Designer.
- Design `partial`: update only affected design outputs; keep inherited outputs unchanged.
- Design `full`: create the task-scoped design contract for a new journey or material experience model, reusing the project baseline where valid.
- Architecture `skip`: for a bounded bug or technical task with no architecture impact, record an explicit waiver and run no Architect.
- Architecture `reuse`: import the accepted pack with provenance and run no Architect.
- Architecture `partial`: update only declared pack outputs while preserving the selected direction.
- Architecture `full`: use the normal options, human selection, and selected-state pack flow.

`skip`, `direct`, and `reuse` skip role execution, not review evidence. Unknown impact is never grounds for skipping. If implementation reveals a product, design, or architecture impact that the current disposition excluded, invalidate downstream clearance and reassess that phase before continuing.

The platform-managed Architect phase has an explicit selection checkpoint. Its first execution requires only `architecture`, `architecture-discovery-context`, and `architecture-options`. A human records exactly one documented choice in a `request_changes` review using an independent line `Selected option: <ID>` against the current options revision. Only then does the next execution unlock `architecture` plus the six selected-state outputs. The phase cannot be approved until every registered Architect output exists and every selected-state output was refreshed after that review. The platform rejects attempts to select C4, ADR, pattern, NFR, or adversarial outputs before valid selection evidence exists.

Always use the artifact owner's config, not the active role's config. The global output root always comes from `ai-native.yaml` and defaults to `docs/`.

An artifact path may name one file or a directory. When it names a directory, read only the files required by that artifact's role contract. Start architecture work and every downstream architecture handoff at the `architecture` index, then follow its active links instead of scanning the whole output tree. Child architecture artifacts listed as phase inputs declare the exact evidence that role needs; they never override the index status or make a pending item active.

Meet the phase gate in `ai-native.yaml` before moving forward. Record handoff evidence in the active task file.

## Bug fast path

A bounded bug can proceed as `Product: direct → Design: skip or reuse → Architecture: skip or reuse → Software Engineer → Tester`. Architecture `skip` is an explicit waiver for a bug or technical task with no boundary, API/schema, data, integration, security, NFR, deployment, or operational impact; use `reuse` when an accepted pack exists and applies. This path still requires an immutable Change Contract, an authoritative expected-behavior source, observable fix criteria, reproduction evidence when available, and targeted regression evidence. Verification is never skipped for a production-code change.
