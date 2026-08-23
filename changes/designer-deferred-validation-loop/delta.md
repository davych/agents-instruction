# Designer deferred-validation loop

## Problem

The Design phase currently treats every `B-04` validation item as work that the
Designer must finish before approval. A real initialized project records B-04 as
responsive and accessibility verification that can only run after an executable
implementation and browser environment exist. Re-running Designer therefore
preserves the honest blocker, while the platform immediately asks to run Designer
again. No role can advance far enough to create the implementation the check needs.

## ADDED

- A formal `deferred_validations` handoff in the design contract for observable
  checks that require a runnable implementation.
- A visible, non-blocking “实现后验证” state in the Run page.
- Verification-phase access to `design-spec`, with Tester ownership of executing
  deferred runtime checks and recording the evidence in `test-report`.
- A Verification approval gate that requires each deferred ID exactly once with
  declared target/check coverage, machine-declared evidence types, real durable
  passing evidence, and no contradictory failure state.

## MODIFIED

- Design blocker classification distinguishes work that can be completed now from
  verification that explicitly depends on implementation/runtime availability.
- Designer guidance moves eligible legacy B-04 items from `blockers` to
  `deferred_validations` instead of retrying indefinitely.
- Legacy all-deferred B-04 content is explained as post-implementation work, but
  Design approval and Implementation readiness remain fail-closed until one formal
  revision records `ready-for-engineering`, `blockers: []`, and a valid
  `deferred_validations` ledger.
- Web guidance explains when code starts, who acts next, and why deferred checks do
  not require another Designer run.
- Older initialized definitions receive `design-spec` as a Verification input in
  memory; the FE-cc target receives an explicit incremental backfill.

## REMOVED

- The assumption that missing post-implementation browser evidence is necessarily
  a Design-stage blocker.
- The Designer rerun CTA for a Design gate whose only remaining item is deferred
  implementation verification.

## Preserved

- The fixed six-phase order and existing role ownership model.
- Product/design/architecture decisions that change what must be built remain
  blocking before implementation.
- B-04 work that is executable against current design evidence remains Designer
  work and blocks approval until completed.
- Tester verification and human release decisions are never skipped.

## Acceptance criteria

- **AC-DES-LOOP-001:** A B-04 item that explicitly requires a runnable
  implementation or available browser stays visible but has `blocking=false` and
  does not increase Design `workCount`. A legacy blocked handoff still requires one
  formal cleanup revision before Design approval; the runtime check itself never
  asks Designer to run again.
- **AC-DES-LOOP-002:** An immediately executable B-04 validation remains blocking
  Designer work.
- **AC-DES-LOOP-003:** The canonical design schema, template, validator, Agent, and
  workflow represent deferred validation separately from implementation blockers.
- **AC-DES-LOOP-004:** The Run page labels the item “实现后验证 / 当前不阻塞”, does
  not tell the user to run Designer for that item, and explains that code begins
  only after Design and Architecture clearances.
- **AC-DES-LOOP-005:** Software Engineer readiness accepts only an approved formal
  design envelope with `ready-for-engineering`, an empty blocker list, and a valid
  explicit deferred ledger; legacy, malformed, immediate-blocker, and draft
  handoffs reject execution.
- **AC-DES-LOOP-006:** Verification receives `design-spec`; Tester and the test
  report carry every deferred check to real browser/accessibility evidence. Missing,
  failed, blocked, untested, contradictory, or placeholder evidence prevents
  Verification approval and therefore cannot unlock Release.
- **AC-DES-LOOP-007:** Existing initialized definitions are extended without
  rewriting project YAML, while `/Users/Davy_Chen/workspace/ai-run/FE-cc` receives
  only the required explicit incremental backfill and preserves project content.
- **AC-DES-LOOP-008:** Focused API/Web/initializer checks, typecheck, build, and the
  relevant full suites pass, with any unrelated environmental failure reported.
