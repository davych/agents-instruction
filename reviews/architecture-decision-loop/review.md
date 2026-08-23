# Architecture decision loop review

## Verdict

Pass for the requested P0/P1 scope. No unresolved finding blocks handoff.

## Seven lenses

### Behaviour preservation

Finding: none found. The six phases, owners, append-only reviews, current-head locking,
rulebook gate, and separate final Architecture approval are unchanged.

### Hidden assumptions

Finding: none found. The live target—not a guessed fixture—proved the unresolved item is
OBS-002, that current options recommend B, and that the old selection belongs to older heads.
The code never treats that old preference as current authorization.

### Spec/architecture drift

Finding: none found. Architect still recommends; a human answers the operational policy,
selects the option, and accepts the completed pack. No security exception or vendor choice is
made by the Agent or UI.

### Confirmation without evidence

Finding: none found. Regression tests cover the red cases, the full platform suite and builds
pass, and the live page displays the expected active card and staged checkpoint.

### Test independence

Finding: the verification tier is Limited because one primary session authored both code and
tests. Disposition: accepted as an explicitly disclosed evidence limitation for this local
change; no claim of Tier A/B independence is made.

### Security surface

Finding: none found. The UI never auto-selects. The recommended local preset forbids remote
upload, credentials, secrets, child input, answers, and free text. A central-monitoring choice
cannot be submitted while its platform name and human owner remain placeholders.

### Over-engineering

Finding: none found. The implementation reuses the existing human-decision review endpoint,
strict selection marker, current-head evidence, and Review dialog. It adds no phase, artifact,
database schema, role, plugin, or duplicate Agent.

## Adversarial pass

### Pre-mortem

- Old generic reviews could appear to remain active. Result: active gate is derived from current
  artifacts; the live UI showed generic text only in immutable history.
- A user could select B before OBS-002 is resolved. Result: option actions are withheld and both
  UI and semantic rulebook gates remain closed.
- Architect-authored H3/em-dash headings could make every click fail. Result: safe read
  compatibility is tested; canonical output remains strict H2/colon.

### Edge-case-hunter

- `Selected option: B` from an older Options revision is ignored.
- Multiple or undocumented selection markers remain invalid.
- A central-monitoring preset with unfilled name/owner is rejected locally.
- An unparseable current Options document shows a repair message rather than inventing cards.
- Saving an actual selection opens one Architect continuation; selecting still does not approve.

