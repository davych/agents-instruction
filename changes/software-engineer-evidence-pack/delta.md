# Software Engineer evidence pack delta

## Goal

Replace the Software Engineer placeholder with a project-native, Web-reviewable implementation workflow that carries an auditable evidence chain and can be backfilled into an already initialized project.

## Preserved behaviour

The fixed six-phase workflow, canonical single-Agent source, Product/Design/Architecture clearance model, real repository implementation, Tester handoff, artifact revision model, and human approval boundary remain unchanged.

## ADDED

- A Software Engineer role config, detailed workflow, focused reference workflows, and evidence templates.
- Seven registered, Run-scoped engineering evidence outputs: implementation notes, implementation plan, implementation tasks, session history, independent test evidence, seven-lens review, and PR provenance.
- Platform validation and Web labels/descriptions for the evidence pack.
- Backward-compatible definition loading for older initialized projects.

## MODIFIED

- The canonical Software Engineer Agent becomes the concise policy layer and delegates procedural detail to the role workflow.
- Tester consumes the implementation index plus independent-test and engineering-review evidence.
- The Codex task envelope protects role resources and explicitly distinguishes allowed code/test writes from registered evidence outputs.

## REMOVED

None. No existing phase, role, registered artifact, or approval is deleted.

## REMOVED audit

Verified against the current `ai-native.yaml`, definition loader, task path resolver, Web fallback definitions, and target project. Existing `implementation-notes` remains the stable pack index and downstream handoff.

## Risk note

Adding required outputs can make older projects impossible to approve unless the loader supplies compatible paths and their role Markdown is backfilled. The change therefore includes both compatibility loading and an explicit FE-cc backfill.

## Acceptance criteria

- **AC-ENG-001:** The canonical Software Engineer Agent loads its config and workflow, enforces upstream clearances, and preserves human-owned decisions.
- **AC-ENG-002:** A fresh initialization contains the complete Software Engineer config, workflow, references, templates, and one client-native Agent without a duplicate Skill.
- **AC-ENG-003:** The implementation phase registers exactly seven Web-reviewable outputs: `implementation-notes`, `implementation-plan`, `implementation-tasks`, `engineering-session-log`, `engineering-test-evidence`, `engineering-review`, and `engineering-provenance`; the replay packet remains conditional and unregistered.
- **AC-ENG-004:** Every engineering evidence output resolves to a deterministic Run-scoped safe path and reruns retain their original registered paths.
- **AC-ENG-005:** An older initialized definition that only declares `implementation-notes` is extended in memory with the full evidence pack without rewriting its YAML.
- **AC-ENG-006:** The Web execution and review UI presents human-readable labels and purpose-specific descriptions for every engineering output.
- **AC-ENG-007:** Approval rejects missing acceptance coverage, Tier C/Limited verification without an approved exception, incomplete seven-lens/adversarial review, placeholders, or incomplete provenance.
- **AC-ENG-008:** The runner protects Software Engineer role resources while allowing confirmed-scope source and test changes plus only the selected registered evidence outputs.
- **AC-ENG-009:** The legacy FE-cc target receives the current Software Engineer Agent and all required role Markdown/templates for an immediate platform test.
- **AC-ENG-010:** Root and platform tests, typechecks, and builds pass without a new dependency.
- **AC-ENG-011:** Brownfield planning records preserved behavior, ADDED/MODIFIED/REMOVED, a REMOVED audit, and risk; `REMOVED: None` is valid only with an audit.
- **AC-ENG-012:** Engineering produces PR provenance but never makes architecture, scope, security-sensitive, DDL, merge, risk-acceptance, or release decisions.
