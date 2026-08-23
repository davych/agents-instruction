# Tester Playwright E2E workflow — session log

## Task contract

Explain what a human does with the Software Engineer Markdown output, define the Tester role around Playwright MCP exploration, independent E2E crystallization, and standalone CI execution, update README guidance, and provide one detailed end-to-end workflow without changing the fixed six phases or repository-test ownership.

## Context loaded

- Repository `AGENTS.md`, Engineering skill, visualization guidance, canonical Agents, `ai-native.yaml`, shared workflow, artifact templates, initializer behavior, platform task-path resolver, and Run Web page.
- Existing Software Engineer role pack and UI guidance, Tester Agent/guide, test-report template, CI workflow, initialization tests, and platform checks.
- Existing maintainer evidence under `changes/`, `sessions/`, and `reviews/`, which is distinct from initialized Run delivery evidence.

## Ordered action log

1. Inventoried the generated engineering evidence contract and found that complete “what next” guidance existed only in deeper Software Engineer docs and UI code, not in the root README.
2. Identified two easily confused Markdown namespaces: initialized Run artifacts and this workflow repository's maintainer evidence.
3. Confirmed Tester had no ordinary role procedure pack and only one registered output, `test-report`.
4. Rejected direct post-approval Tester edits to `tests/e2e/*.spec.ts`, because they would make the seven engineering records stale and silently change source/test ownership.
5. Defined the feedback loop: Tester maps risk and may explore; a fresh Tier A/B session freezes spec-only test intent; Software Engineer integrates the test and refreshes evidence; Tester resumes after Implementation reapproval.
6. Added the canonical Tester workflow/reference and expanded the Agent, global workflow, `ai-native.yaml`, test-report template, Software Engineer handback reference, and human-facing role guides.
7. Added root README review guidance, namespace explanation, a W01-W21 Mermaid workflow, and a matching node-by-node owner/input/action/output/failure table.
8. Added Web Verification guidance before execution and review, while retaining Tester ownership of only `test-report`.
9. Made `test-report` Run-scoped through the existing path resolver and added pinning coverage for already persisted paths.
10. Commissioned an independent acceptance-contract test before implementation. It first failed 7 of 13 cases, then passed all 13 after the workflow was implemented.
11. Ran focused checks, root initialization/package checks, full platform typecheck/test/build, and diff hygiene.
12. Commissioned separate read-only reviews for seven-lens risks, documentation/diagram consistency, and task-path backward compatibility.
13. Corrected the reviewed workflow graph so local runner repair re-enters mapped Verification, required-check configuration alone returns to DevOps, and non-E2E evidence still executes instead of skipping directly to the report.
14. Added a Verification workspace guard: protected source, tests, tracked/untracked files, Agents, role/workflow controls, environment paths, and in-project Git state are restored and the run rejected if Tester mutates them. The selected report and declared runtime-evidence directories are intentional write holes; exact documented dependency/cache/build exclusions may retain ephemeral changes, cannot serve as approval evidence, and must not contain authoritative source/tests/controls.
15. Added semantic `test-report` approval validation for current revision, autonomous command/exit/result, durable evidence, AC/regression coverage, open gaps, MCP-only claims, and remote CI traceability.
16. Added the explicit `E2E crystallization request:` review marker. Only the current marked `changes_requested` review injects bounded read-only report/AC/frozen-intent feedback into an Implementation rerun; ordinary or later approved reviews do not.
17. Ran an independent adversarial review that reproduced unauthorized writes outside conventional source roots, unreadable-mode restoration failure, invented prose evidence, ambiguous command classification, false `E2E required: no`, Git deletion/corruption, linked-worktree escape, and selected-output overlap with Git metadata.
18. Replaced the path-name guard with a fail-closed full-tree manifest and blind baseline restoration for tracked/untracked files, directories, modes, symlinks, topology, control paths, and in-project Git metadata. Added selected-output policy and stable workspace revision tokens.
19. Bound Verification approval to the current real completed execution, runner events, exact canonical project-root command, workspace token, explicit Git state/HEAD, and re-hashed local evidence. Human-edited, stale, invented, MCP-only, ambiguous-shell, and false-E2E-no reports now fail closed.
20. Hardened crystallization routing so the literal marker must be the first line with a nonempty scenario, current Change Contract ACs, and exactly one bounded Frozen intent. Only parsed fields and report-head metadata cross back to Engineer.
21. Added pre-run Git containment checks that support SHA-1/SHA-256, unborn and explicit non-Git workspaces, while blocking parent repositories, external linked worktrees, external git directories, corrupt repositories, and report paths overlapping protected metadata.
22. Corrected the root and detailed workflow graphs so optional E2E discovery, non-E2E mapped verification, local reruns, CI-policy repair, and owner-specific failure loops all re-enter the proper gate.
23. Re-ran final independent security/document review. It reported no remaining P0/P1/P2 in the stated synchronous Verification scope and confirmed the fixed phases, artifact registry, W01-W21 mapping, and ownership boundaries.
24. Ran the final independent, focused, root, full-platform, typecheck, build, package dry-run, and diff-hygiene gates and refreshed this evidence chain with the final counts.

## Change inventory

- Root, Getting Started, end-to-end workflow, configuration, role-index, Software Engineer, Tester, and platform documentation.
- Canonical Tester Agent, ordinary Tester role workflow/reference, shared workflow, verification registry wording, and test-report template.
- Software Engineer independent-verification handback guidance.
- Run-scoped `test-report` path resolution and focused API checks.
- Web Tester guidance and focused UI contract checks.
- Independent root acceptance-contract suite and this evidence chain.
- Full-tree Verification workspace/Git guard, canonical command parsing, execution provenance validation, and adversarial regression checks.

## Rejected alternatives

- Treating “MCP 跑通” as acceptance or CI proof: rejected because it is a transient AI-controlled session rather than a replayable repository asset.
- Copying exploration actions into a test: rejected because it transfers confirmation bias and violates the independent spec-driven test boundary.
- Letting Tester commit repository tests after Implementation approval: rejected because the engineering evidence would be stale and ownership would drift.
- Adding Exploration, Crystallization, and Execution as new global phases or artifact IDs: rejected because they are a Verification subflow and the six-phase registry is fixed.
- Adding Playwright to this initializer's dependencies or CI: rejected because target projects must use their real harness and this repository has no product E2E surface.
- Registering exploration notes as a Web artifact: rejected because transient diagnostic notes are not a durable gate deliverable.
- Claiming the synchronous guard is a process sandbox: rejected because a detached descendant could write after the observed runner window. Background/detached commands are prohibited and disposable/recoverable state is required; full process isolation remains a separately approved architecture/security decision.
- Authenticating remote CI by URL shape alone: rejected. The report keeps a durable revision-traced reference, but provider authentication requires a connector.

## Verification gates

- Independent acceptance-contract suite: 13/13 pass.
- Root suite: 16/16 pass.
- Focused workspace guard: 40/40 pass.
- Focused provenance binding: 27/27 pass.
- Combined provenance/semantic/feedback suite: 75/75 pass.
- Platform suite: 574/574 pass.
- Typecheck, production build, package dry-run, and diff hygiene: pass.

## Outcome

Complete and ready for human review. The user now has a concrete action after engineering output, Tester has an installable three-stage operating procedure with an explicit ownership-preserving feedback loop, and the full workflow is visible in one numbered diagram plus a node detail table.
