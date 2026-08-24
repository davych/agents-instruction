# Tester Playwright E2E workflow — session log

## Task contract

Ignore the known legacy E2E repository and enhance Verification so a user can explicitly initialize and maintain a separate E2E workspace, have a fresh spec-only process generate Playwright scripts there, review those scripts before execution, run a real browser automatically, and receive actionable evidence without changing the fixed six phases or allowing Tester to mutate product source.

## Human-owned decision

The user explicitly selected a separately maintained E2E project owned by the testing flow. This authorizes the Linked E2E Workspace model. It does not authorize a seventh phase, DDL, product-source mutation, CI/secrets changes, commit, push, PR creation, merge, deploy, or release.

## Context loaded

- Repository `AGENTS.md`, Engineering skill, canonical Agents, six-phase workflow, `ai-native.yaml`, artifact templates, initializer, API/store/execution model, Verification guards/provenance, and Run Web page.
- User-supplied test report showing Vitest/jsdom passes alongside `No browser is available` and an overall Blocked Verification result.
- Existing Tester and Software Engineer role procedures, legacy crystallization feedback, test-report validation, and current Web actions.
- Existing unrelated user/team changes in the shared dirty worktree were preserved.

## Ordered action log

1. Read the supplied report and separated V-01/V-03 Vitest/jsdom results from true browser E2E. Confirmed that 6/6 and 11/11 did not launch Chromium and that the overall Blocked result was correct.
2. Audited the current data model and runner. Confirmed that one product root, Tester read-only policy, product-root-only provenance, and manual feedback markers could not safely support an independent E2E project.
3. Recorded the user's explicit architecture/scope decision and kept the global phase/owner/artifact registry unchanged.
4. Defined Linked E2E Workspace as a sidecar binding, not a second platform Project. It is configured by an explicit absolute path, must be separate and non-nested, and is never discovered from a sibling or legacy folder.
5. Added a no-DDL sidecar descriptor, canonical path/symlink/traversal/allowed-root checks, a loopback-only base URL contract, fixed npm script identifiers, pinned Playwright defaults, explicit dependency/browser preparation, and structured readiness.
6. Added a fresh ephemeral Tier B Test Author. It receives frozen approved AC/regression intent and an E2E staging copy, not product implementation, source diff, MCP transcript, DOM dump, or prior Tester transcript.
7. Restricted authoring persistence to `tests/**` and `fixtures/**`, rejected control-file changes and unmanaged importable helpers, and recorded the complete executable suite contents, sizes, hashes, revision token, and patch hash.
8. Added a separate human script-review gate backed by trusted execution events. Local JSON cannot self-authorize; latest review wins; cross-Run, foreign-execution, stale revision, changed bytes, and request-changes cases fail closed.
9. Added a platform-supervised runner using fixed argv and `shell:false`. It verifies a vacant loopback target, starts the product, waits with bounded HTTP attempts, launches the configured Playwright Chromium, navigates to the exact target, runs the suite, hashes new evidence, and cleans the process group and port.
10. Added bounded machine failure manifests for target, browser, timeout, test, and cleanup failures and copied their hashes into `e2e.execution.failed` events. Success events bind exact command, base URL, browser/version, target status, raw exit code, and cleanup result.
11. Extended workspace guards and provenance across product and E2E roots. Product bytes remain unchanged; E2E execution can write only declared runtime evidence; approval re-hashes scripts and evidence and binds both revisions.
12. Made Linked E2E sticky for the Run. Once selected, a later standard Tester report cannot replace or bypass the required current successful linked execution.
13. Added legacy AC fallback only from approved, selected user-story IDs. No scope is invented from objectives, reports, or legacy directories.
14. Added the Web flow: configure workspace, prepare/preflight, generate scripts, inspect the complete suite, approve scripts, run real Chromium, then review Verification. The prior non-E2E path remains only when the server explicitly proves no linked workspace.
15. Made Web loading/error/unknown states fail closed and exposed actionable environment/execution errors rather than requiring a hand-written `E2E crystallization request:` marker.
16. Ran an independent Tier B adversarial review. It initially reproduced raw traversal acceptance, missing target preflight, UI query-error fail-open, npm lifecycle bypass risk, and incomplete provenance URL binding.
17. Rejected raw `.`/`..` components before normalization, added supervised target preflight before authoring, made the UI standard path fail closed, disabled npm lifecycle hooks, and required exact target URL rather than origin-only provenance.
18. Extended HTTP readiness with a remaining-deadline AbortController, added POSIX leader/process-group/port cleanup, and ensured forced cleanup remains non-passing.
19. Ran a final temporary real-browser smoke using Playwright 1.62.1 and Chromium 151.0.7922.34. The target returned HTTP 200, the suite exited 0, the server exited 0 with `sigterm`, and sanitized manifests were retained.
20. Permanently deleted the temporary smoke fixture and confirmed that no legacy E2E or product repository was touched.
21. Re-ran independent adversarial verification. The final result was Pass with no remaining P1/P2 in the supported POSIX scope.
22. Ran the final focused, root, platform, typecheck, build, package, and diff gates and refreshed the evidence chain.

## Change inventory

- Linked workspace configuration, readiness, preparation, fresh test authoring, supervised Playwright execution, and coordinator services.
- Structured API/contracts and Run Web panel for the full Verification subflow.
- Dual-workspace guard, revision binding, script-review authority, success/failure events, semantic gate, and provenance validation.
- Tester/Software Engineer Agents, role references, shared workflow, test-report template, initializer configuration, and user guidance.
- Root, API, Web, adversarial, provenance, workflow-service, and true-browser smoke evidence.

## Rejected alternatives

- Reusing or scanning the legacy sibling E2E project: rejected because the user explicitly identified it as interference and implicit path adoption is unsafe.
- Treating jsdom or MCP success as browser acceptance: rejected because neither supplies a standalone current-revision Chromium execution.
- Letting the same Tester conversation inspect implementation, write tests, and immediately execute them: rejected because it weakens independence and creates execute-after-write risk.
- Writing external E2E scripts through the product Software Engineer evidence pack: rejected for the authorized linked-workspace path; only product source, in-repo tests, and testability-interface changes return to Software Engineer.
- Registering the E2E workspace as a second six-phase Project or adding a seventh phase: rejected because the harness is a Verification asset, not a second delivery lifecycle.
- Accepting raw paths or shell commands from Web: rejected; only validated configuration and fixed argv are executed.
- Trusting a local `approved` field, report prose, exit code 0 alone, or an old report: rejected; trusted events, real browser probe, revisions, full-suite hashes, new evidence, and cleanup must all match.
- Claiming OS-level sandboxing or authenticated remote CI: rejected; those require separate architecture/security and connector decisions.

## Verification gates

- Independent acceptance-contract suite: 20/20 pass.
- Linked E2E focused suite: 93/93 pass.
- Root suite: 23/23 pass.
- Platform suite: 683/683 pass.
- Real Chromium smoke: Playwright 1.62.1, Chromium 151.0.7922.34, HTTP 200, test exit 0, server exit 0, cleanup `sigterm`.
- Typecheck, production build, package dry-run, and diff hygiene: Pass.

## Outcome

Complete and ready for human review. A user can now create a new independent E2E workspace from Verification, let a fresh spec-only author generate the full Playwright suite, inspect and approve that executable suite, run a real headless Chromium under platform supervision, and review revision-bound evidence. No commit, push, PR, merge, deploy, or release was performed.
