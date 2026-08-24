# Tester Playwright E2E workflow — seven-lens and adversarial review

## Verdict

Ready for human review in the supported POSIX local-execution scope. Final independent Tier B verification found no remaining P1/P2. The implementation retains the fixed six phases and human Verification gate, never connects the identified legacy E2E project, and requires a trusted real-Chromium execution rather than jsdom, MCP, Markdown, or exit-code-only claims.

## 1. Behaviour Preservation

No open finding. Existing Runs without a configured linked workspace retain the ordinary Tester path. The six phase IDs/order, role owners, seven Software Engineer outputs, single registered Tester `test-report`, human approvals, and release boundary remain unchanged. Existing persisted report paths remain pin-compatible.

## 2. Hidden Assumptions

No open finding. The earlier design implicitly assumed all durable tests lived under the product root and that a sibling E2E repository could be treated as context. The new contract makes the second root explicit, canonical, separate, non-nested, and human-configured. No name, sibling path, repository history, or legacy documentation can auto-bind it.

## 3. Spec/architecture Drift

No open finding. The user's explicit decision authorizes Tester-owned scripts in an independent E2E workspace. Product source, in-repository tests, and product testability interfaces remain Software Engineer-owned; CI, secrets, required checks, merge, and release remain DevOps/human-owned. Linked E2E is a Verification subflow, not a second platform Project or seventh phase. No DDL was added.

## 4. Confirmation Without Evidence

No open finding. A passing `npm run test:e2e` exit alone is insufficient. Approval requires a trusted completed event with raw test exit 0, approved complete-suite hashes, current product/E2E revisions, exact command/cwd/base URL, real locked-Chromium navigation, HTTP 200–499, matching browser version, new hashed evidence, and successful cleanup. The final temporary smoke launched Chromium 151.0.7922.34 and received HTTP 200; its sanitized manifests are durable platform-runner evidence, not product acceptance evidence.

## 5. Test Independence

No open finding. A fresh ephemeral Tier B Test Author receives frozen approved AC/regression intent and the E2E staging workspace only. Product implementation, source diff, MCP transcript, DOM dump, and previous Tester transcript are excluded. Generated code cannot execute until a human reviews the complete executable `tests/**` and `fixtures/**` baseline and approves its exact platform-bound hash. Script approval does not approve Verification.

## 6. Security Surface

No open P1/P2. The resolved register below covers raw traversal, symlinks/nested roots, unmanaged imports, package lifecycle hooks, local approval forgery, cross-Run records, stale revisions, browserless passes, old evidence reuse, target substitution, report mutation, child-process survival, and ordinary-Tester bypass. Product and E2E roots are both guarded; unsafe changes are restored and the execution fails closed.

## 7. Over-engineering

No open finding. The implementation reuses the current Project/Run, execution events, review model, artifact registry, report head, workspace guards, Node test runner, TypeScript, Zod, React, and Fastify. A sidecar descriptor avoids DDL and a second Project lifecycle. The Web panel adds one state-aware subflow while keeping the ordinary path for verified non-linked Runs.

## Resolved finding register

| ID | Severity | Finding and evidence | Resolution | Status |
|---|---|---|---|---|
| E2E-REV-001 | High | Raw paths containing `..` were normalized before rejection; adversarial service probe accepted traversal. | Reject raw `.`/`..` components before resolution; cover POSIX and Windows separators. | Resolved |
| E2E-REV-002 | High | Authoring could begin after package/browser checks without proving the configured target could start and accept a real browser. | Add supervised target preflight before authoring and execution, including vacancy, HTTP, real Chromium navigation, and cleanup. | Resolved |
| E2E-REV-003 | High | `npm` pre/post lifecycle hooks could mutate approved tests around the main command. | Reject `pretest:e2e`/`posttest:e2e` and set `npm_config_ignore_scripts=true` on supervised npm processes. | Resolved |
| E2E-REV-004 | High | A local sidecar approval or a copied Run record could authorize execution. | Make DB execution events latest-wins authority and bind Run, phase, author execution, complete-suite patch hash, product/E2E tokens, and review decision. | Resolved |
| E2E-REV-005 | High | Reviewing only newly changed files allowed pre-existing executable tests to run unseen. | Materialize, display, size-bound, hash, and approve the complete `tests/**` and `fixtures/**` suite. | Resolved |
| E2E-REV-006 | High | Exit 0 plus a new report could pass without a verified browser target. | Require locked Playwright Chromium launch, exact browser version, exact base URL, real navigation, acceptable HTTP status, new evidence, and cleanup. | Resolved |
| E2E-REV-007 | High | A later ordinary Tester report could replace a failed Linked E2E head. | Persist a Run-scoped linked obligation; Verification approval requires the current report to bind the same Run's successful linked event. | Resolved |
| E2E-REV-008 | High | Product/E2E mutation, stale tokens, script/evidence tampering, or foreign cwd could evade prose-only checks. | Guard both roots and re-hash current revisions, full scripts, copied evidence, exact command/cwd, and report binding. | Resolved |
| E2E-REV-009 | Medium | HTTP readiness could hang when a socket accepted but never returned headers. | Bound every request by the remaining deadline with `AbortController`; preserve failure evidence and clean the server. | Resolved |
| E2E-REV-010 | High | An npm leader could exit while a descendant retained the target port. | Wait for leader close, POSIX process-group disappearance, and port release; escalate to SIGKILL and keep the result non-passing. | Resolved |
| E2E-REV-011 | Medium | UI query failure initially exposed the standard Tester path before linked state was known. | Fail closed unless an independent workspace query explicitly proves unconfigured; hide standard execute/rerun/review while linked state is uncertain. | Resolved |
| E2E-REV-012 | Medium | Provenance compared only target origin, allowing a same-origin different-path substitution. | Require canonical full `href` equality plus origin and no credentials; add an independent adversarial negative. | Resolved |
| E2E-REV-013 | Medium | Runtime exceptions could surface only as a generic failure without durable detail. | Write bounded machine failure manifests and bind copied path/hash/bytes plus stage/code/message into `e2e.execution.failed`. | Resolved |

## Adversarial pass

### Pre-mortem

| ID | Plausible failure | Detection/evidence | Required action | Status |
|---|---|---|---|---|
| E2E-ADV-PM-001 | A jsdom/MCP/unit success is presented as real-browser acceptance. | Report/command semantic checks, trusted linked event, real Chromium target probe, `real-chromium-smoke.json`. | Preserve the browser/version/target/evidence gate and UI distinction. | Resolved |
| E2E-ADV-PM-002 | Newly generated executable tests run before a human sees malicious or out-of-scope code. | Complete-suite content/hash review, 200 kB fail-closed bound, DB review event, unmanaged-helper rejection. | Keep script review separate from Verification approval and never auto-execute after authoring. | Resolved |
| E2E-ADV-PM-003 | A failed linked run is hidden by a later ordinary passing report. | Sticky linked obligation and current-report/execution binding tests. | Require a current successful linked completion until the supported workflow defines an explicit human cancellation contract. | Resolved |
| E2E-ADV-PM-004 | A stale product server remains alive and the next suite tests the wrong revision. | Initial port vacancy, supervised process group, cleanup result, final port release. | Forced cleanup must remain non-passing; preserve orphan-descendant regression coverage. | Resolved |

### Edge-case-hunter

| ID | Edge condition | Expected and verified behavior | Evidence | Status |
|---|---|---|---|---|
| E2E-ADV-EC-001 | Raw POSIX/Windows traversal, symlink root, nested/identical roots, nonempty unmanaged directory. | Reject before initialization; never inspect or reuse a legacy sibling. | `e2e-workspace-service.check.ts` | Resolved |
| E2E-ADV-EC-002 | Target accepts TCP but never returns HTTP headers; target returns 5xx; target redirects to a different path/origin. | Time out, reject, retain failure evidence, and clean all supervised processes. | runner and provenance focused checks | Resolved |
| E2E-ADV-EC-003 | Playwright exits 0 but reuses old evidence or cleanup needs SIGKILL. | Reject stale evidence; effective result remains nonzero/non-passing. | `e2e-automation-runner.check.ts` | Resolved |
| E2E-ADV-EC-004 | Local JSON says approved, later DB review requests changes, file/token drifts, or record belongs to another Run. | Latest trusted matching review only; otherwise return to author/review state. | `verification-e2e-workflow-service.check.ts` | Resolved |
| E2E-ADV-EC-005 | Report prose changes command, cwd, browser version, base URL, script hash, evidence hash, or revision. | Markdown cannot authorize machine facts; provenance re-reads current trusted data and rejects mismatch. | `verification-evidence-provenance.check.ts` 45/45 | Resolved |

## Residual boundaries

- Workspace protection is synchronous rollback, not an OS sandbox. The author is Tier B isolation, not container-level non-readability.
- POSIX process-group cleanup is covered. Windows lacks an equivalent descendant-tree implementation in this change; occupied ports fail closed rather than being reported as a pass.
- Dependency/browser preparation is explicit and may require operator-approved network access.
- Script display is bounded to 200 kB and fails closed above the bound.
- Remote CI references remain unauthenticated without a provider connector.
- The production build retains an existing large-chunk warning unrelated to this change.

## Human decision boundary

This review recommends readiness only. It does not approve the generated scripts for a future product Run, approve Verification, create or publish a PR, merge, deploy, or authorize release.
