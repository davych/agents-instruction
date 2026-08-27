# Software Engineer workflow

Turn the immutable Change Contract and active Product, Design, and Architecture clearances into a working repository change with an auditable evidence chain.

The Change Contract plus its active PM / BA evidence is the authoritative specification. Do not create a second `spec.md`, rewrite product acceptance criteria, or resolve a product ambiguity inside engineering evidence. The implementation changes real source and test files in the repository; the registered Markdown artifacts explain and verify those changes but never substitute for them.

## Registered evidence contract

Resolve every artifact through `ai-native.yaml`, the artifact owner's config, and any supplied execution contract or direct-IDE execution brief. Keep these artifacts separate. Each registered template is the sole source for that artifact's exact headings, fields, and table columns; start from it and preserve its machine contract instead of reconstructing the schema from this workflow.

| Artifact | Purpose | Template |
|---|---|---|
| `implementation-plan` | Strategy, affected boundaries, and one smallest complete vertical slice | `.ai-sdlc/templates/implementation-plan.md` |
| `implementation-tasks` | Executable task state, dependencies, repository targets, and AC mapping | `.ai-sdlc/templates/implementation-tasks.md` |
| `implementation-notes` | What actually changed, checks run, deviations, and Tester handoff | `.ai-sdlc/templates/implementation-notes.md` |
| `engineering-session-log` | Ordered execution evidence and rejected alternatives | `.ai-sdlc/templates/engineering-session-log.md` |
| `engineering-test-evidence` | Independent-test provenance, commands, results, and criterion coverage | `.ai-sdlc/templates/engineering-test-evidence.md` |
| `engineering-review` | Seven-lens review plus adversarial findings | `.ai-sdlc/templates/engineering-review.md` |
| `engineering-provenance` | Independent-audit links and PR provenance for future-use traceability; it does not create a PR | `.ai-sdlc/templates/engineering-provenance.md` |

`implementation-plan` and `implementation-tasks` are never aliases. The plan explains why and how the vertical slice will be built. The task file records atomic work, owner-neutral execution status, AC or regression mappings, and evidence links. Do not hide task progress in prose inside the plan. The Web machine gate reads the exact template contracts, so do not rename, demote, or locally redefine their headings and fields.

## Steps

1. **Resolve the execution boundary.** Read `ai-native.yaml`, `.ai-sdlc/workflows/default.md`, this config, this workflow, any supplied execution contract or direct-IDE execution brief, and the current Run's immutable Change Contract. Confirm current Product, Design, and Architecture evidence. A valid `direct`, `skip`, or `reuse` route is evidence; do not demand placeholder PRDs, design specs, or architecture files.
2. **Resolve authoritative inputs.** Use registered artifact IDs and owner-aware path resolution. Start architecture reading at its index and follow only active links. Read applicable project instructions, configured Markdown, approved artifacts, and the smallest relevant repository evidence set. Record every file actually loaded; do not claim a missing source was read.
3. **Check implementability.** Extract the confirmed acceptance criteria, targeted regression obligations, preserved behaviour, non-goals, design behaviour, every `design-spec.deferred_validations` obligation, active ADR rules, patterns, container boundaries, NFR budgets, and open human decisions. Preserve every stable story AC and deferred-validation ID. When a Change Contract criterion has no ID, derive `CC-AC-001`, `CC-AC-002`, and so on from its array order only as a traceability alias; record the source position and never rewrite the immutable contract. Stop before code when no observable criterion exists, a required upstream gate is stale or blocked, or two active sources contradict each other.
4. **Create the implementation plan.** Read [spec-driven-development.md](references/spec-driven-development.md) and start the registered `implementation-plan` from its template. Define the smallest complete vertical slice, repository change map, preservation obligations, constraints, intended test-isolation tier, risk, and exit criteria. Do not add architecture, scope, or unconfirmed behaviour.
5. **Create executable tasks.** Start the separately registered `implementation-tasks` from its template. Give each task a stable `ENG-TASK-<three-digits>` ID, one allowed status, concrete repository targets, dependencies, and Change Contract/story AC or regression IDs. Every in-scope criterion must map to implementation and verification work before coding starts.
6. **Implement the slice.** Modify the real source, configuration, migration, and automated-test files required by the confirmed slice, following repository conventions. Keep the session log current. Do not use the Markdown evidence files as a simulation of code changes. Stop and return to the owning impact check if implementation discovers excluded Product, Design, or Architecture impact.
7. **Generate independent tests.** Read [independent-verification.md](references/independent-verification.md). Test design must begin from the authoritative contract in a context that has not seen the implementation. Tier A and Tier B may satisfy the gate. Tier C and Limited are blocked unless the human review comment uses the exact seven-line exception contract from that reference, including owner, durable reference, affected CC-AC scope, why A/B was unavailable, compensating evidence, residual risk, and revisit condition. Artifact text cannot approve the exception. After test design is frozen, run the tests against the implementation and classify failures as `implementation bug`, `test bug`, or `spec ambiguity`. In every passing coverage row, keep the exact AC ID, real executable test path and test name, durable result evidence, and `Pass` together.
8. **Run real checks.** Read [ci-enforcement.md](references/ci-enforcement.md). Discover and execute the repository's actual focused tests, regression tests, formatter/linter, type checks, build, and required CI-equivalent commands. Record exact commands, exit results, and intentionally unrun Implementation-owned checks. Never copy example commands or report a check that did not run. A downstream Tester-owned browser, accessibility, E2E, or deferred runtime validation belongs in limitations and handoff, not in an Implementation gate result.
9. **Review independently.** Read [seven-lens-review.md](references/seven-lens-review.md). Use a fresh reviewer where available. Record a finding or `none found` for all seven named lenses, then run both the pre-mortem and edge-case-hunter passes. A `none found` row uses `N/A` for Severity, Impact, Action, and any adversarial contract cell; cites a real path, test, command, result log, or artifact in Evidence; and uses `not-applicable` status. A security-class finding is escalated and remains blocking until the human-owned decision and required remediation evidence are recorded.
10. **Package evidence.** Update implementation notes, session log, test evidence, review, and provenance from their templates. Read [provenance.md](references/provenance.md). Generate future-use PR traceability only; do not create, open, publish, merge, deploy, or claim those actions occurred.
11. **Complete the handoff.** Verify every selected registered output exists and is non-empty, every AC has the configured minimum test mapping, every deferred design validation is preserved for Tester and the implementation is runnable in its declared environment, all required Implementation-owned checks and review gates have evidence, and all file links resolve. Hand the working change and evidence to Tester. Record downstream Tester-owned validation in the handoff/limitations without turning it into a blocked Implementation gate, and do not claim its final browser/accessibility result on Tester's behalf. Human acceptance, merge, release, and risk acceptance remain outside this role.

## Selection boundary

Use the owner-aware artifact resolution and direct IDE fallback defined in `.ai-sdlc/workflows/default.md`; the Software Engineer config contributes only its output namespace, and a platform execution contract supplies any Run-scoped physical path. Never hardcode `docs`, duplicate the namespace in a filename, or write evidence outside a selected resolved output. Leave unselected registered artifacts byte-for-byte unchanged. Product source and test changes remain governed by the confirmed implementation scope, not by the Markdown evidence-output list.

## Human-owned gates

Escalate rather than decide:

- product scope, acceptance-criterion wording, priority, or release policy;
- architecture selection, ADR acceptance, boundary changes, or architecture exceptions;
- security-sensitive behaviour, credential or sensitive-data handling, and material risk acceptance;
- database schema changes or DDL outside an approved test-only implementation contract;
- Tier C or Limited verification exceptions and any other gate waiver;
- PR publication, merge, deployment, rollback execution, or release approval.

## Completion checks

- The Change Contract remains byte-for-byte unchanged and is named as the specification authority.
- Product, Design, and Architecture clearance evidence is current for this Run; no placeholder upstream artifact was manufactured.
- `implementation-plan` describes strategy and a complete vertical slice; `implementation-tasks` separately records executable status and AC mappings.
- The working tree contains the real, in-scope source and test changes described by the evidence.
- Every in-scope AC and targeted regression obligation maps to changed code or a justified no-code disposition and to at least `quality.minimum_tests_per_acceptance_criterion` automated test; each passing coverage row contains its exact ID, real test path/name, durable evidence, and `Pass`.
- Test evidence records authoring isolation. Tier A or B passes; Tier C or Limited is blocked unless the human waiver and compensating evidence are linked.
- Exact commands and results are recorded; failures and unrun checks are visible.
- All seven review lenses contain a complete finding or a non-contradictory `none found` row with real Evidence, `N/A` non-evidence fields, and `not-applicable` status; both adversarial passes are complete.
- No unresolved security finding, spec ambiguity, failed required check, missing necessary test, stale upstream gate, or unapproved scope expansion is marked complete.
- Provenance links the Change Contract, active clearances, plan, tasks, session log, code/test evidence, review, and implementation notes; it states that the text is for possible future PR use and that no PR was created, opened, or published by this role.
Keep the phase blocked whenever required evidence is missing. Do not fill gaps with invented facts, approve your own exception, or use a polished document as evidence that code or tests exist.
