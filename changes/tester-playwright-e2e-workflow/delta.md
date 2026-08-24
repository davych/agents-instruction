# Tester Playwright E2E workflow delta

## Goal

Make the handoff after Software Engineer understandable and define a repeatable E2E verification lifecycle in which Playwright MCP is optional exploration, durable tests are authored independently from the specification into an explicitly linked standalone E2E workspace, and platform-supervised standalone Playwright execution supplies reviewable real-browser evidence.

## Preserved behaviour

The fixed six-phase order, phase owners, seven registered Software Engineer evidence artifacts, single registered Tester artifact (`test-report`), human Verification approval, and existing deferred Design verification contract remain unchanged. Software Engineer continues to own product source, in-repository tests, and product testability interfaces. DevOps or the authorized repository owner continues to own CI, credentials, required checks, merge, and release.

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
- A human-configured `Linked E2E Workspace` that is a separate, non-nested local project and is never inferred from a sibling or legacy repository.
- A Verification-internal, fresh Test Author subprocess that receives only approved acceptance/design/NFR intent and the E2E harness, never the product implementation, implementation transcript, MCP transcript, or DOM dump.
- A generated-script review checkpoint that exposes and binds the complete executable `tests/**` and `fixtures/**` baseline, not merely the files changed by the latest authoring run, before any test code can run.
- A platform-supervised standalone Playwright runner that performs package/browser/app readiness checks, launches the configured real headless browser without MCP, manages the product server lifecycle, and records exact command, working directory, exit code, report, trace, screenshot, and file hashes.
- Dual-workspace provenance that binds both the product revision and linked E2E suite revision while keeping `test-report` as the only registered Verification artifact.

## MODIFIED

- The canonical Tester Agent, global workflow, Tester guide, Getting Started guide, root README, and test-report template now distinguish diagnostic exploration from repeatable gate evidence.
- Software Engineer independent-verification guidance now distinguishes product-repository tests from Tester-owned assets in a linked E2E workspace and explains when a failed E2E must return for a product or testability-interface change.
- Tester and Verification descriptions in `ai-native.yaml` now describe reproducible execution evidence and the Playwright MCP boundary.

## REMOVED

- The ordinary successful linked-workspace path no longer requires a human to hand-write an `E2E crystallization request:` review marker or route generated E2E scripts through the product repository.

## REMOVED audit

The six phase IDs, role owners, registered artifact IDs, and phase output lists are compared by automated checks. No phase, owner, artifact, or existing gate is removed.

## Risk note

Allowing the same Tester process to inspect the product implementation, generate executable tests, and immediately run them would weaken independence and create an unsafe execute-after-write path. The workflow therefore keeps the product workspace read-only, freezes intent from approved specification evidence, runs a fresh Test Author only inside the linked E2E workspace, requires a human to approve the exact generated script hashes, and then lets the platform—not the Agent or MCP—launch standalone Playwright. Only failures that require product source, in-repository tests, or testability-interface changes return to Software Engineer and refresh the engineering evidence pack.

## Human-owned decision recorded for this delta

The product owner explicitly selected a separately maintained E2E project and asked the Tester execution flow to produce scripts there. This authorizes the linked-workspace model and Tester ownership of that external verification harness. It does not authorize a seventh phase, product-source mutation, CI/secret changes, commits, pushes, merges, or releases.

## Acceptance criteria

- **AC-TESTER-001:** Root guidance says the seven engineering Markdown files are one generated evidence pack, gives the review order `implementation-notes` -> `engineering-test-evidence` -> `engineering-review`, and explains approve-versus-return actions.
- **AC-TESTER-002:** Root guidance distinguishes Run delivery artifacts from this repository's `changes/`, `sessions/`, and `reviews/` development evidence.
- **AC-TESTER-003:** New initialized projects contain `.ai-sdlc/roles/tester/workflow.md` and `.ai-sdlc/roles/tester/references/e2e-playwright.md`, with no duplicate Tester Skill or Agent.
- **AC-TESTER-004:** Tester guidance defines Playwright MCP exploration as optional diagnostic work whose successful path is not, by itself, repeatable acceptance or CI evidence.
- **AC-TESTER-005:** Crystallization freezes AC-mapped test intent in a fresh Tier A/B session using authoritative specification inputs without the implementation diff, implementation transcript, exploration code, or exploration transcript.
- **AC-TESTER-006:** A new or changed product-repository test remains owned by Software Engineer and refreshes the engineering evidence pack, while a linked-workspace E2E script is authored by a fresh spec-only Test Author under Verification, stored only in the separately configured E2E root, and cannot mutate product source, in-repository tests, controls, Git metadata, or environment files.
- **AC-TESTER-007:** Execution uses the repository's real standalone Playwright command locally or in CI, never MCP, and records the revision, command, exit result, report, and available trace/screenshot/video evidence.
- **AC-TESTER-008:** Tester defines the E2E command/report contract while DevOps or the authorized repository owner configures the required CI check; no remote CI pass is claimed without a durable run reference.
- **AC-TESTER-009:** The test-report template separates exploration, crystallization, execution, AC/regression results, deferred Design verification, failure classification, gaps, defects, and release recommendation. Approval rejects placeholders, failed/blocked/untested or MCP-only proof, missing/current-revision mismatches, absent standalone command/result/evidence, incomplete AC/regression mapping, unsupported remote CI-pass claims, invented execution IDs, stale or human-edited report heads, ambiguous shell commands, false `E2E required: no`, unsafe working directories, changed Git/workspace state, and missing or hash-mismatched local evidence.
- **AC-TESTER-010:** A detailed Mermaid graph and node table show the full Change Contract-to-release path, the three E2E stages, owner-specific failure loops, and the human release decision without adding a seventh phase.
- **AC-TESTER-011:** Platform Web guidance shows the Tester lifecycle before Verification execution and tells the reviewer that MCP success alone is insufficient.
- **AC-TESTER-012:** `test-report` receives a stable Run-scoped path while existing persisted Run paths remain pinnable.
- **AC-TESTER-013:** Root initializer tests, platform focused/adversarial tests (including workspace restoration), typecheck, full tests, build, package dry-run, and diff hygiene pass.
- **AC-TESTER-014:** A human can configure or initialize one linked E2E workspace with an explicit allowed absolute path, loopback base URL, package-manager script names, and browser; the platform rejects symlinks, nested/identical roots, path traversal, unsafe script identifiers, non-empty unmanaged directories, and any attempt to infer or reuse a legacy sibling repository.
- **AC-TESTER-015:** Before authoring or execution, a structured preflight separately reports linked-workspace configuration, Playwright package availability, the configured browser executable and a real headless launch probe, product start-script availability, and target readiness. Missing dependencies or browser produce actionable environment states and never a passing Verification claim.
- **AC-TESTER-016:** The Verification author action deterministically freezes selected approved AC/regression intent, supports legacy Runs only through approved `user-stories` AC IDs, launches a fresh ephemeral Test Author in the linked E2E root, persists only allowlisted test/fixture changes, and records the resulting file manifest and hashes without exposing implementation or exploration context.
- **AC-TESTER-017:** E2E files cannot run until a human reviews the complete executable `tests/**` and `fixtures/**` baseline and approves its exact manifest hash through a platform-owned event. A local sidecar cannot self-authorize execution; a changed file, workspace token, approval hash, product revision, E2E revision, foreign Run record, or later request-changes decision invalidates approval. Script approval does not approve Verification or unlock Release.
- **AC-TESTER-018:** After script approval, the platform uses fixed argv with `shell: false` to verify that the loopback target is initially vacant, supervise the current product server, launch the configured real headless Chromium, navigate to that server, and run the linked project's standalone Playwright command. A passing row is possible only when the browser/version/target probe succeeds, the persisted command exits 0, new durable evidence exists, and supervised cleanup succeeds; timeout, launch failure, target mismatch, test failure, stale evidence, or forced cleanup remains non-passing.
- **AC-TESTER-019:** Verification provenance accepts an execution working directory only from the execution's trusted linked-workspace event, binds product and E2E Git/workspace revisions, and re-hashes declared scripts plus reports/traces/screenshots from their configured roots. Markdown cannot self-authorize an arbitrary external path or invented command.
- **AC-TESTER-020:** Web presents one state-aware path—configure, preflight, generate scripts, review the complete suite, run real-browser tests, review Verification—and no longer asks users to hand-write a crystallization marker. Existing projects/Runs without linked configuration retain the prior non-E2E path and are never auto-connected to legacy folders. Once a Run selects Linked E2E, a later standard Tester report cannot replace or bypass the required successful linked execution.

## Explicit runtime boundary

The Verification workspace guard is a fail-closed synchronous detection and restoration layer, not an operating-system process sandbox. Background or detached descendants are prohibited, and Verification must run on disposable or otherwise recoverable project state. Exact dependency/cache/build exclusions may retain ephemeral mutations and are not approval evidence; authoritative source, tests, or controls must not live there, and oversize snapshots block before execution. Remote CI references are revision-traced and structurally validated, but cannot be authenticated against a provider without a CI connector. These boundaries are documented rather than represented as stronger guarantees.
