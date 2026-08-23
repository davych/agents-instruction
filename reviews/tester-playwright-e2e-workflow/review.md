# Tester Playwright E2E workflow — seven-lens and adversarial review

## Verdict

Ready for human review. The final independent adversarial pass found no remaining P0, P1, or P2 issue inside the documented synchronous Verification boundary. Three explicit limits—no process sandbox, exact dependency/cache/build and runtime-evidence exclusions plus snapshot caps, and no provider-authenticated remote CI without a connector—remain human-visible and are not represented as stronger guarantees.

## 1. Correctness

Finding: none open. The fixed six phases, owners, seven Software Engineer outputs, single Tester `test-report` output, and artifact registry are unchanged. Both E2E and non-E2E paths execute applicable mapped verification before the report and human gate.

## 2. Security

- ID: TESTER-REV-SEC-001
- Severity: high
- Finding: early workspace protection could miss arbitrary nested untracked paths, unreadable permission changes, Git metadata, linked-worktree metadata, and a selected report overlapping `.git`.
- Evidence: independent adversarial probes and `platform/apps/api/checks/verification-workspace-runner.check.ts`.
- Impact: a Verification runner could retain an unauthorized source, control, or repository-state mutation.
- Required action: protect the whole in-scope tree, restore from baseline without trusting the damaged current tree, fail closed on unsafe Git topology, and reject selected-output overlap; Owner: Platform maintainers.
- Status: resolved. The final guard suite passes 40/40, including tracked/untracked topology, permissions, symlinks, Git deletion/corruption/commit, linked worktree, nonstandard git-dir, selected-output, and fail-closed cases.

## 3. Error handling

Finding: none open. Snapshot, traversal, Git-state, restoration, report-provenance, missing evidence, stale revision, and unsupported command failures reject before approval with no silent fallback. Existing deferred Design validation still runs before the general Verification gate.

## 4. Edge cases

- ID: TESTER-REV-EDGE-001
- Severity: high
- Finding: prose-only validation initially accepted invented revisions/evidence, Playwright text outside the executed command, shell-comment decoys, false `E2E required: no`, an arbitrary existing cwd, stale/human report heads, and incomplete crystallization markers.
- Evidence: `platform/apps/api/checks/verification-evidence-provenance.check.ts`, `verification-evidence-workflow-service.check.ts`, and `tester-e2e-crystallization-workflow-service.check.ts`.
- Impact: a reviewer could approve a report that was not produced by the claimed standalone execution or route ambiguous test intent back to Engineer.
- Required action: parse one canonical command, bind the report head to a real current execution and root cwd, bind workspace/Git/evidence hashes, and strictly parse bounded feedback; Owner: Platform maintainers.
- Status: resolved. Provenance passes 27/27 and the combined provenance/semantic/feedback suite passes 75/75.

## 5. Performance

Finding: no open regression. Verification snapshotting is intentionally bounded at 512 MiB and 200,000 entries and fails closed above either limit. Exact dependency/cache/build and runtime-evidence exclusions are documented; the full platform suite and production build pass.

## 6. Maintainability

Finding: none open. Tester remains one canonical Agent plus an ordinary installed role pack. The implementation reuses the existing artifact owner/path resolver, review model, execution events, Node test runner, TypeScript, and Web guidance patterns without adding Playwright or a new framework to this repository.

## 7. Spec drift

Finding: none open. Exploration, crystallization, and execution are E2E stages inside Verification, not new global phases. Repository test integration stays with Software Engineer, the engineering evidence is refreshed and reapproved after a new test, CI configuration stays with DevOps/repository owners, and merge/release remain human decisions.

## Adversarial pass

### Pre-mortem

- ID: TESTER-ADV-001
- Severity: high
- Plausible failure: a transient MCP success or fabricated Markdown is treated as approval evidence without executing the current repository revision.
- Trigger: the gate trusts prose instead of platform execution provenance, or classifies unexecuted Playwright text as an E2E command.
- Evidence/detection: canonical-command, current-execution, report-head, workspace/Git revision, cwd, and evidence-hash adversarial tests.
- Impact: a broken user journey could be approved and later fail in required CI.
- Required action: keep semantic and provenance validators coupled to the same canonical command classifier and retain the adversarial tests; Owner: Platform maintainers.
- Status: resolved. Fake, stale, human-authored, MCP-only, ambiguous-shell, false-no, missing-path, and hash-mismatch cases reject.

### Edge-case-hunter

- ID: TESTER-ADV-002
- Severity: high
- Edge condition: Verification changes a protected path to mode `000`, replaces a file with a symlink, commits to Git, deletes `.git`, selects `.git/HEAD` as the report, runs below a parent repository, or uses an external linked worktree.
- Expected behavior: restoration uses the trusted baseline, unsafe Git topology or output placement blocks before the runner, and protected source/test/control/Git mutations reject the run and are restored. Allowed report/runtime-evidence writes persist; exact documented dependency/cache/build exclusions may also retain ephemeral mutations but are outside approval evidence.
- Evidence/result: focused guard 40/40 and final independent security review.
- Impact: without these checks, the Tester boundary could corrupt project or version-control state.
- Required action: preserve full-tree, Git-state, selected-output, and blind-restoration regression coverage; Owner: Platform maintainers.
- Status: resolved inside the synchronous runner window.

## Residual boundaries

- The guard observes and restores the synchronous runner window; it is not an OS process sandbox. Detached/background commands are prohibited, and disposable or recoverable project state is required. Stronger process isolation is a separate architecture/security decision.
- A remote CI URL/run ID is structurally and revision-traced but cannot be authenticated against the provider without a connector.
- Exact dependency/cache/build and runtime-evidence trees are excluded, and oversize snapshots block rather than run without protection.

## Human decision boundary

This review recommends readiness only. It does not approve an architecture/security exception, publish a PR, merge, deploy, or authorize release.
