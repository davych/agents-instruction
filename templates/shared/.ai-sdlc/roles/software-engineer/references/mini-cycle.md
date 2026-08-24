# Engineering mini-cycle

Use this loop for each smallest complete vertical slice. A slice crosses the necessary repository layers and produces observable contract value; it is not a collection of unrelated horizontal scaffolds.

## Cycle

`requirement -> plan/context -> code -> independent tests -> review -> evidence`

### 1. Requirement

- Anchor work to the immutable Change Contract and the active PM / BA evidence.
- List exact acceptance-criterion and regression-obligation IDs. Preserve stable story IDs; for an unnumbered Change Contract criterion, derive `CC-AC-<three-digits>` from source array order only for traceability and do not edit the contract.
- Record preserved behaviour, non-goals, and unresolved ambiguity before implementation.
- Stop if there is no observable criterion or if an upstream source conflicts with another active source.

### 2. Plan and context

- Load only relevant hot, warm, and cold project context and record the paths actually read.
- Follow active Design and Architecture clearances; do not turn assumptions into decisions.
- Define one vertical slice and its exit criteria in `implementation-plan`.
- Record atomic, mapped work separately in `implementation-tasks`.

### 3. Code

- Change the real repository source and configuration needed by the slice.
- Preserve project conventions and unaffected behaviour.
- Keep changes inside the confirmed Product, Design, and Architecture boundaries.
- If a new impact is discovered, stop and invalidate the affected clearance instead of silently expanding scope.

### 4. Independent tests

- Design tests from the authoritative criteria without implementation visibility.
- Record Tier A, B, C, or Limited before using the result.
- Treat A and B as passing tiers. C and Limited require a recorded human gate exception.
- Freeze the independent test intent, then execute the tests against the real implementation.

### 5. Review

- Run all seven lenses and record a finding or a canonical `none found` row for each. A none-found row cites real Evidence, keeps Severity/Impact/Action as `N/A`, and uses `not-applicable` status.
- Run both adversarial passes: pre-mortem and edge-case-hunter.
- Link each actionable finding to a task, owner, and evidence or blocker.

### 6. Evidence

- Update the session log as work occurs rather than reconstructing a fictional history.
- Record exact Implementation-owned commands and outcomes, including genuine failures and skipped required checks. Keep future Tester-owned validation in the handoff/limitations rather than presenting it as a non-passing Implementation command.
- Link the complete evidence chain in engineering provenance.
- Generate future-use PR traceability only; Software Engineer does not create, open, publish, or merge a PR.

## Loop outcome

The cycle is complete only when the slice works, its necessary automated tests and project checks pass, review is closed without an unapproved blocker, and another role can cold-audit the evidence without asking the implementation author. Otherwise update task status to `blocked` or `in-progress`, record the reason, and begin another bounded cycle after the owning decision is resolved.
