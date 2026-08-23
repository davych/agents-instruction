# Architecture decision loop

## Problem

The Architecture review can collapse concrete unresolved decisions into the generic
`ARCHITECTURE-HANDOFF-INCOMPLETE` work item. Capturing that item only asks Architect to
rerun, while neither recording the missing rule decision nor the current options-revision
selection. The same blocked pack is therefore generated again.

The Web checkpoint also asks people to type the internal marker
`Selected option: <ID>` without presenting the documented options in decision-ready form.
Existing initialized projects may contain valid option headings such as
`### Option B — ...`, while the API currently recognizes only `## Option B: ...`.

## Acceptance criteria

- AC-ARCH-LOOP-001: unchecked Architecture evidence gaps are surfaced as their concrete
  decision, and OBS-002 is explained as a plain-language browser-diagnostics choice.
- AC-ARCH-LOOP-002: an Architecture pack whose only remaining state is awaiting the
  current options-revision selection does not generate the generic handoff blocker.
- AC-ARCH-LOOP-003: option IDs are safely recognized from canonical H2-colon headings and
  compatible H2/H3 dash variants without weakening selection-marker validation.
- AC-ARCH-LOOP-004: the Web review presents option cards with recommendation and trade-offs;
  one click writes the exact selection marker, but never silently chooses for the human.
- AC-ARCH-LOOP-005: unresolved Architecture decisions disable premature option selection;
  after a valid selection is recorded, the UI opens exactly one Architect continuation.
- AC-ARCH-LOOP-006: the canonical Architect contract emits the strict canonical option
  heading and turns captured decisions into formal rulebook evidence before asking again.
- AC-ARCH-LOOP-007: the initialized FE-cc role files receive an incremental backfill while
  project-owned source and formal Architecture artifacts remain untouched.
- AC-ARCH-LOOP-008: initializer, platform typecheck/tests/build, and FE-cc checks pass, with
  isolation and any environment limitations recorded honestly.

## Preserved boundaries

- The fixed six phases and their owners do not change.
- Architect may recommend but does not select or approve an architecture option.
- The platform records human evidence against the current Discovery and Options heads.
- No production implementation, release, security exception, or monitoring vendor is
  selected by this change.

