# Seven-lens engineering review

Review the confirmed slice after implementation and independent verification. Prefer a fresh reviewer or session and record the review relationship. Every lens must contain an actionable finding or an exact, non-contradictory `none found` row; a blank section is not a completed review.

## Required lenses

### 1. Behaviour preservation

Look for deleted or weakened tests, removed error handling, changed public interfaces, data compatibility loss, regression obligations without evidence, and behaviour outside the Change Contract.

### 2. Hidden assumptions

Look for hard-coded values, implicit defaults, unchecked response shapes, time/locale/order assumptions, environment coupling, and “temporary” behaviour without an owner or expiry.

### 3. Spec/architecture drift

Look for scope expansion, acceptance reinterpretation, unapproved API/schema or boundary choices, ADR conflicts, misplaced patterns, and missed NFR budgets.

### 4. Confirmation without evidence

Challenge claims such as “all criteria met”, “safe”, “backward compatible”, or “tests pass” when they do not link to a real diff, test, command result, measurement, or approved decision.

### 5. Test independence

Verify the recorded isolation tier, implementation visibility, criterion mapping, frozen test intent, waiver completeness, and whether tests merely mirror implementation branches.

### 6. Security surface

Inspect authentication, authorization, secrets, sensitive data, validation, injection, dependency and supply-chain exposure, logging, abuse paths, and privilege changes. A security-class finding is blocking and must be escalated; the Agent does not accept the risk.

### 7. Over-engineering

Look for abstractions, dependencies, configuration, layers, generic frameworks, migrations, or broad refactors not needed by the smallest confirmed vertical slice.

## Adversarial pass

Run both methods after the seven lenses:

1. **Pre-mortem:** assume the change failed in production. Identify plausible failure, trigger, user or system impact, existing detection, missing guard, and required follow-up evidence.
2. **Edge-case-hunter:** actively test relevant empty, minimum, maximum, malformed, repeated, concurrent, partial-failure, unauthorized, stale, locale/time, compatibility, and recovery conditions. Mark irrelevant categories as such with a reason rather than inventing a finding.

## Finding contract

A `none found` disposition is not an actionable finding. In its canonical table row:

- set Finding ID to the exact text `none found`;
- set Severity, Impact, and Required action / owner to `N/A`;
- for Pre-mortem or Edge-case-hunter, also set the failure/trigger or edge-condition contract to `N/A`;
- put the real review basis in Evidence, using a repository path, test path/name, exact command, result log, or artifact revision;
- set Status / resolution evidence to the exact text `not-applicable`;
- do not add an actionable finding row to the same section.

Narrative such as “reviewed the code” is not durable Evidence. Do not attach a severity, impact, action, owner, `resolved` status, or resolution claim to `none found`.

For a real finding, record:

- stable ID `ENG-REV-<three-digits>` for a lens or `ENG-ADV-<three-digits>` for an adversarial method;
- lens or adversarial method;
- severity `critical`, `high`, `medium`, or `low`;
- evidence with repository path, test, command, or artifact reference;
- impact and required action;
- an explicit accountable owner; in the canonical table write `Owner: <name>` in the action cell, or `Human owner: <name>` for a security finding;
- status `open`, `resolved`, `accepted-by-human`, or `not-applicable`;
- resolution evidence when closed.

The reviewer may recommend; it does not merge, approve release, accept material risk, alter product scope, or approve an architecture/security exception. An unresolved critical/high finding, any security-class finding awaiting decision, or any finding that invalidates a contract or required check keeps the verdict blocked.
