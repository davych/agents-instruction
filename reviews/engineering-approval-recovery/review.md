# Engineering approval recovery review

## Verdict

Pass for handoff. No unresolved finding blocks this change.

## Behaviour preservation

Finding: none found. The fixed six phases, role ownership, seven registered engineering artifacts, evidence approval gate, human approval boundary, and Tester handoff remain intact.

## Hidden assumptions

Finding: none found. The implementation distinguishes committed source from an empty uncommitted diff and bases the repair recommendation on validator issue semantics rather than assuming that every approval failure means missing code.

## Spec and architecture drift

Finding: none found. Recovery stays inside the existing Implementation output selection and execution APIs; no new phase, artifact, role, or bypass was introduced.

## Confirmation without evidence

Finding: none found. The active FE-cc failure was reproduced against six authoritative User Story ACs and the current seven artifacts, then inspected in the live page. The target code, tests, lint, and build were rerun separately.

## Test independence

Finding: ENG-REV-001. Severity: low. Evidence: implementation and tests were authored in the same root session. Impact: independent test authorship is not demonstrated for this UX change. Required action / owner: retain the Tier Limited declaration and require normal human review; owner is the human reviewer. Status: Accepted limitation. Resolution evidence: focused checks, full 547-test platform suite, live browser inspection, and target smoke checks are recorded in `changes/engineering-approval-recovery/test-evidence.md`.

## Security surface

Finding: none found. The change exposes sanitized validator diagnostics already returned to the same project UI and preserves output allowlists, role-pack protection, human approval, and publication boundaries.

## Over-engineering

Finding: none found. The change reuses the current execute dialog, output keys, error details, and runner revision feedback instead of adding a repair phase or a second artifact model.

## Adversarial pass

### Pre-mortem

Finding: none found. The likely recurrence—users interpreting a partial evidence repair as another code-writing run—is addressed by distinct dialog title, description, selected-output list, and primary action while retaining the original full-implementation CTA.

### Edge-case-hunter

Finding: none found. Tests cover a global upstream-AC failure, explicit code/test/task failures, evidence-only failures, duplicate diagnostics, five-output batching, per-artifact repair, and selected-output filtering.

## Residual risks

- Existing FE-cc v3 evidence remains invalid until the user runs the new repair action; this change intentionally does not rewrite or approve those artifacts behind the user’s back.
- If the repair discovers that a claimed command, test, or code fact is false, the Agent must stop and report it; the UI then recommends a full Software Engineer rerun.
