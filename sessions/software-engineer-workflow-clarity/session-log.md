# Software Engineer workflow clarity — session log

## Task contract

Explain the seven engineering outputs, make the moment of code execution obvious, remove normal-path artifact choices, prevent internally blocked upstream documents from starting Codex, turn approval errors into actionable Chinese guidance, fix legacy acceptance-criterion lookup, and make every upstream human decision visible and actionable without weakening the evidence gate.

## Context loaded

- Repository `AGENTS.md`, Engineering skill, current Software Engineer role pack, Web run/review UI, API review service, User Story snapshot parser, validator, and existing checks.
- Real FE-cc Run `43edd578-e635-4d20-ae9b-d279fc224faa`, selected upstream artifacts, current seven engineering documents, and read-only platform database state.

## Ordered action log

1. Diagnosed the reported three-part validation failure against the actual FE-cc evidence.
2. Confirmed the Run has no structured Change Contract, but its selected approved User Stories contain 11 stable AC headings.
3. Added a fail-closed resolver: Change Contract criteria first; otherwise stable AC headings from approved `user-stories` selected for the completed implementation execution.
4. Added the four-step Web guide, explicit “开始实施并写代码” action, artifact timing/purpose/human-check guidance, and structured approval recovery actions.
5. Inspected the user's repeated real execution. It selected all seven outputs, exited successfully, changed no pinyin source/test file, wrote a Blocked evidence pack, and left one tracked config-only diff in `eslint.config.js`.
6. Confirmed the selected PRD says “Pending human decisions; not ready for downstream phase”, the Design envelope is `blocked` with B-01..B-04, and Architecture is “Ready for human acceptance / Blocked”.
7. Added a fail-closed API preflight before `createExecution`, with structured Product/Design/Architecture ownership, blocker IDs, and Design decision details.
8. Removed actionable input/output checkboxes from the normal Implementation dialog, presented the outputs as one automatic evidence pack, and retained explicit per-artifact rerun only from review.
9. Reordered Implementation review to open with implementation notes, then independent tests and seven-lens review; labeled plan/tasks/session/provenance as audit detail that normally does not need line-by-line reading.
10. Added Web navigation from readiness errors to the owning upstream phase and changed the primary action to “检查条件并开始写代码”.
11. Ran focused checks, real FE-cc read-only probes, root checks, full platform typecheck/test/build, package dry-run, and diff hygiene checks.
12. Revisited the complete upstream flow after the user correctly observed that earlier phases never showed where a human decision was required.
13. Added a structured Product/Design/Architecture decision domain that separates human decisions, role-owned work, upstream dependencies, and final acceptance; captured answers remain blocking until the formal artifact is updated.
14. Added fail-closed Product, Design, and Architecture approval checks and an API decision summary that identifies internally inconsistent legacy approvals.
15. Added bounded structured decision capture through append-only review history. Saving a response records `request_changes`, invalidates downstream phases transactionally, and hands the answer to the current role's rerun prompt.
16. Added a Run-level Decisions and follow-ups dashboard, per-phase inbox, source-phase navigation, explicit legacy warnings, approval disablement, and clean-progress accounting.
17. Probed the active FE-cc documents directly: Product has five human decisions; Design has one Designer task plus four Product dependencies; Architecture has two human decisions plus four upstream dependencies.
18. Hardened the machine-readable review block against Markdown fences and marker-like text while retaining legacy-record parsing and bounding aggregate response size.
19. Ran focused decision/store/service/Web tests, fixed stale fake-design and architecture-test fixtures to satisfy the new public handoff contract, then reran the full platform and root verification suites.
20. Exercised the post-Product state transition and fixed the second-hop UX: a Ready Design/Architecture phase with stale upstream dependencies now runs its role directly to synchronize approved inputs, while only true human decisions open an answer form.

## Change inventory

- API domain resolver, implementation-readiness preflight, and approval/execution service integration.
- Web plain-language workflow model, automatic bundles, phase navigation, phase/execute/review presentation, and error guidance.
- Focused API and Web checks.
- Software Engineer role documentation and this change evidence chain.

## Rejected alternatives

- Removing or merging registered evidence artifacts: rejected because Tester and approval gates require distinct traceable evidence.
- Treating the Run objective or engineering-authored Markdown as authoritative AC: rejected because it lets the implementation self-authorize.
- Changing `Blocked` to `Ready`: rejected because the target honestly records no source/test implementation and unresolved upstream decisions.
- Letting the Agent start and emit another Blocked evidence pack: rejected because the platform can detect these explicit upstream states before paying for or displaying a Codex execution.
- Asking the user to choose seven internal Markdown outputs: rejected for normal implementation because they form one mandatory audit pack; local evidence repair remains an advanced review action.

## Verification gates

- `npm test`: 3/3 pass.
- `npm pack --dry-run --cache /private/tmp/ai-sdlc-pack-cache-clarity`: pass, 79 packaged files.
- Focused decision, readiness, routing, store, Web clarity, and output-selection checks: pass.
- `yarn typecheck`: pass.
- `yarn test`: 389/389 pass.
- `yarn build`: pass.
- `git diff --check`: pass.
- FE-cc read-only preflight/decision probe: 9 approved selected inputs and 11 stable User Story ACs recognized; Product exposes 5 decisions, Design exposes 1 role task + 4 upstream dependencies, and Architecture exposes 2 decisions + 4 dependencies. All three legacy approvals are reported inconsistent.

## Outcome

Complete and ready for human review. A normal Implementation now has no document-selection puzzle, and an internally blocked input stops before any “writing code” state or redundant evidence rerun. The Run page now tells the human exactly what must be decided, what belongs to a role, and which upstream phase to revisit. The target remains correctly blocked until its Product answers, Designer verification, and Architecture decisions are materialized and reapproved.
