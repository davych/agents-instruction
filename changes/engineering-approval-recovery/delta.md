# Engineering approval recovery delta

## Goal

Turn an Implementation approval failure into one obvious recovery path. The page must say which evidence documents failed, what each concrete issue means, whether code must be rerun, and preselect only the outputs that Codex needs to repair.

## Preserved behaviour

The fixed six phases, role ownership, seven registered engineering artifacts, semantic evidence validator, independent-test gate, human approval boundary, and Tester handoff remain unchanged.

## ADDED

- Issue counts and plain-Chinese reasons grouped by the affected engineering artifact.
- A machine recommendation that distinguishes upstream AC repair, a real implementation rerun, and evidence-only repair.
- One action that opens Software Engineer with all and only the affected evidence outputs selected, plus a per-artifact repair action.
- Automatic injection of current evidence-gate diagnostics into a subsequent Software Engineer execution so the Agent receives the exact contract it must repair.

## MODIFIED

- Raw validator diagnostics remain available as developer detail but are no longer the only concrete explanation.
- Evidence-only failures no longer tell the human to edit Markdown or guess between seven outputs.
- The current FE-cc failure is presented as five evidence documents requiring repair, not as missing code implementation.

## REMOVED

None.

## REMOVED audit

The approval validator, artifact registry, execute/review APIs, phase order, and role owners were inspected before this change. No gate or artifact is removed, bypassed, or silently approved.

## Acceptance criteria

- **AC-CLARITY-020:** An engineering gate failure groups every diagnostic by its affected artifact and shows the total diagnostic count and affected-document count.
- **AC-CLARITY-021:** Known validator messages are translated into concrete Chinese facts; raw diagnostics remain available separately.
- **AC-CLARITY-022:** Evidence-format/traceability failures recommend an evidence-only repair with exactly the affected output keys; authoritative-AC failures route to Product; explicit implementation/test/task failures recommend a full Implementation rerun.
- **AC-CLARITY-023:** The review UI offers one batch repair action and one per-artifact repair action without asking the user to hand-edit Markdown.
- **AC-CLARITY-024:** A subsequent Implementation execution receives the current machine-gate diagnostics in its revision feedback, filtered to the selected outputs plus global issues.
- **AC-CLARITY-025:** The reproduced FE-cc pack maps to five affected artifacts and an evidence-only repair; it does not claim the source implementation must be rewritten.
- **AC-CLARITY-026:** Focused Web/API tests, platform typecheck/test/build, root initializer tests, and target smoke checks pass.
