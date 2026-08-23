# Tester Playwright E2E workflow delta

## Goal

Make the handoff after Software Engineer understandable and define a repeatable E2E verification lifecycle in which Playwright MCP is used for exploration, durable tests are authored independently from the specification, and standalone Playwright execution supplies reviewable local or CI evidence.

## Preserved behaviour

The fixed six-phase order, role owners, seven registered Software Engineer evidence artifacts, single registered Tester artifact (`test-report`), human approval boundaries, and existing deferred Design verification contract remain unchanged.

## ADDED

- A first-time-user checklist that explains which engineering Markdown to read, what to inspect, when to reject, and how approval unlocks Tester.
- A Tester role workflow and Playwright E2E reference pack installed as ordinary Markdown, not as a second Agent or client-specific Skill.
- A three-stage E2E lifecycle: MCP exploration, isolated crystallization, and standalone local/CI execution.
- An explicit feedback loop that returns missing or changed repository E2E tests to Software Engineer for integration and evidence refresh before Verification resumes.
- A detailed end-to-end Mermaid workflow and a node-by-node operating table.
- Web guidance that presents the Tester lifecycle before Verification execution.
- Run-scoped platform paths for `test-report` so one Run cannot overwrite another Run's verification report.
- Runtime enforcement that restores and rejects synchronous Verification mutations to protected source, tests, control files, and in-project Git state; the selected `test-report`, declared runtime-evidence directories, and exact documented dependency/cache/build exclusions remain outside that protection for their stated purposes.
- A semantic and provenance-bound Verification approval gate that ties the current report to a real successful execution, its exact command, project-root working directory, workspace/Git revision, and hashed local evidence.
- A bounded, marked Tester-to-Engineer crystallization feedback channel.

## MODIFIED

- The canonical Tester Agent, global workflow, Tester guide, Getting Started guide, root README, and test-report template now distinguish diagnostic exploration from repeatable gate evidence.
- Software Engineer independent-verification guidance now explains how to handle a Tester-returned E2E crystallization request without exposing the implementation or exploration transcript to the independent test author.
- Tester and Verification descriptions in `ai-native.yaml` now describe reproducible execution evidence and the Playwright MCP boundary.

## REMOVED

None.

## REMOVED audit

The six phase IDs, role owners, registered artifact IDs, and phase output lists are compared by automated checks. No phase, owner, artifact, or existing gate is removed.

## Risk note

Allowing Tester to write `tests/e2e/*.spec.ts` directly after Implementation approval would stale the engineering evidence pack and change repository-test ownership. The workflow therefore treats Tester exploration as diagnostic, sends a required crystallization back to Software Engineer, uses a fresh Tier A/B authoring context, refreshes the seven engineering artifacts, and then resumes Tester for standalone execution.

## Acceptance criteria

- **AC-TESTER-001:** Root guidance says the seven engineering Markdown files are one generated evidence pack, gives the review order `implementation-notes` -> `engineering-test-evidence` -> `engineering-review`, and explains approve-versus-return actions.
- **AC-TESTER-002:** Root guidance distinguishes Run delivery artifacts from this repository's `changes/`, `sessions/`, and `reviews/` development evidence.
- **AC-TESTER-003:** New initialized projects contain `.ai-sdlc/roles/tester/workflow.md` and `.ai-sdlc/roles/tester/references/e2e-playwright.md`, with no duplicate Tester Skill or Agent.
- **AC-TESTER-004:** Tester guidance defines Playwright MCP exploration as optional diagnostic work whose successful path is not, by itself, repeatable acceptance or CI evidence.
- **AC-TESTER-005:** Crystallization freezes AC-mapped test intent in a fresh Tier A/B session using authoritative specification inputs without the implementation diff, implementation transcript, exploration code, or exploration transcript.
- **AC-TESTER-006:** A new or changed repository E2E script is integrated by Software Engineer, stored in the project's normal test location such as `tests/e2e/checkout-coupon.spec.ts`, and causes the engineering evidence pack to be refreshed and reapproved before Tester resumes. Verification cannot retain an unauthorized source/test mutation; a current marked crystallization request reaches the later Engineer rerun as bounded read-only feedback without becoming an upstream selected artifact.
- **AC-TESTER-007:** Execution uses the repository's real standalone Playwright command locally or in CI, never MCP, and records the revision, command, exit result, report, and available trace/screenshot/video evidence.
- **AC-TESTER-008:** Tester defines the E2E command/report contract while DevOps or the authorized repository owner configures the required CI check; no remote CI pass is claimed without a durable run reference.
- **AC-TESTER-009:** The test-report template separates exploration, crystallization, execution, AC/regression results, deferred Design verification, failure classification, gaps, defects, and release recommendation. Approval rejects placeholders, failed/blocked/untested or MCP-only proof, missing/current-revision mismatches, absent standalone command/result/evidence, incomplete AC/regression mapping, unsupported remote CI-pass claims, invented execution IDs, stale or human-edited report heads, ambiguous shell commands, false `E2E required: no`, unsafe working directories, changed Git/workspace state, and missing or hash-mismatched local evidence.
- **AC-TESTER-010:** A detailed Mermaid graph and node table show the full Change Contract-to-release path, the three E2E stages, owner-specific failure loops, and the human release decision without adding a seventh phase.
- **AC-TESTER-011:** Platform Web guidance shows the Tester lifecycle before Verification execution and tells the reviewer that MCP success alone is insufficient.
- **AC-TESTER-012:** `test-report` receives a stable Run-scoped path while existing persisted Run paths remain pinnable.
- **AC-TESTER-013:** Root initializer tests, platform focused/adversarial tests (including workspace restoration), typecheck, full tests, build, package dry-run, and diff hygiene pass.

## Explicit runtime boundary

The Verification workspace guard is a fail-closed synchronous detection and restoration layer, not an operating-system process sandbox. Background or detached descendants are prohibited, and Verification must run on disposable or otherwise recoverable project state. Exact dependency/cache/build exclusions may retain ephemeral mutations and are not approval evidence; authoritative source, tests, or controls must not live there, and oversize snapshots block before execution. Remote CI references are revision-traced and structurally validated, but cannot be authenticated against a provider without a CI connector. These boundaries are documented rather than represented as stronger guarantees.
