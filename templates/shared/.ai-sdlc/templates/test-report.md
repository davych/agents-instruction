# Test Report

## Status and recommendation

- **Verification state:** <Ready for release review / Failed / Blocked>
- **Release recommendation:** <evidence-backed recommendation; a human retains the decision>
- **Current revision:** <commit SHA, build ID, or exact working revision; in a platform-managed Run preserve the supplied git HEAD <full SHA> / git unborn <ref> / git state:not-repository binding, then append workspace sha256:<platform token>; platform execution <UUID>>
- **Platform execution ID:** <the current Verification execution UUID supplied by the platform, or Not applicable outside a platform-managed Run>

## Contract, scope, and environment

- **Change Contract:** <artifact ID, revision, and path>
- **Design Spec:** <artifact ID, revision, path, or Not applicable for a valid Design skip>
- **Implementation Notes:** <artifact ID and refreshed revision>
- **Engineering Test Evidence:** <artifact ID and refreshed revision>
- **Engineering Review:** <artifact ID and refreshed revision>
- **Environment:** <real environment and build/version>
- **Test data:** <synthetic/seeded data and cleanup, with no secrets or personal data>
- **Applicable acceptance sources:** <Change Contract and/or story revisions>

## Verification strategy

| Criterion, regression, deferred check, NFR, or risk ID | Evidence level | E2E disposition and reason |
|---|---|---|
| <CC-AC-001> | <unit / integration / E2E / manual observation / other> | <required / existing / not applicable, with reason> |

E2E is risk-based; do not create a browser test for every criterion when a lower, faster level gives stronger evidence.

## E2E Stage 1: Exploration

- **Playwright MCP status:** <not needed / completed / blocked>
- **Session/run reference:** <real session ID or None>
- **Environment and path explored:** <URL/build plus user-visible steps or None>
- **Observations and selector candidates:** <diagnostic findings or None>
- **Diagnostic evidence:** <screenshot/log/tool reference or None>
- **Gate statement:** Exploration is a one-off diagnostic draft. MCP “ran through” is not repeatable acceptance or CI evidence and cannot pass Verification by itself.

A real browser-run or screenshot may supplement a specifically declared manual/deferred observation when its contract allows that evidence type. It still does not prove a reusable E2E script or CI check exists.

## E2E Stage 2: Crystallization

- **E2E script required:** <yes / no, with AC/risk IDs and reason>
- **Frozen test-intent reference:** <durable scenario/intent reference or Not applicable>
- **Authoring isolation:** <Tier A / Tier B / Tier C / Limited / Not applicable>
- **Fresh authoring session:** <model/session/reviewer identity or Not applicable>
- **Inputs visible during intent authoring:** <authoritative spec/design/NFR and public harness only>
- **Excluded context confirmed:** <implementation diff/transcript and exploration code/transcript were not visible, or disclose the real limitation>
- **Repository test path:** <for example tests/e2e/checkout-coupon.spec.ts, existing path, or Not applicable>
- **Mapped test/scenario IDs:** <test names and CC/US/regression IDs>
- **Selector rationale:** <role/label/text/test contract; explain any CSS fallback>
- **Software Engineer integration evidence:** <refreshed implementation-notes/test-evidence/review/provenance revisions or Not applicable>
- **Implementation reapproval:** <review ID/date or Not applicable>

A candidate script is not passing evidence. A new or changed repository test returns to Software Engineer for integration, real checks, refreshed engineering evidence, and Implementation reapproval before Tester resumes.

## E2E Stage 3: Execution

| Execution | Exact command and working directory | Revision and environment | Result | Durable evidence |
|---|---|---|---|---|
| <local standalone / remote CI> | <exact command in backticks plus exact project-root working directory; never MCP> | <SHA/build/browser> | <pass / fail / blocked / untested plus exit status> | <local relative file plus sha256 digest, or remote CI URL/run ID> |

- **Canonical local-command form:** `` `<one direct runner or repository test-wrapper command>` from `<exact project root>` ``. No compound shell, comment, echo/printf, inline assignment, quoting/substitution, redirection, or background/detached execution. Put complex setup in a reviewed repository script and record setup separately; the test command must complete before the runner returns.
- **Required PR check:** <real check name and owner, planned/not configured, or confirmed with durable run reference>
- **MCP used for execution:** No. E2E Stage 3 uses the autonomous repository runner.
- **Retry/flake history:** <first result, retries, classification, owner, and next action or None>

A local result must not be labeled as a remote CI pass. “Configured” or “expected to run” is not a completed CI check.
In a platform-managed Run, record repository-relative evidence files under the approved runtime directories (`test-results/`, `playwright-report/`, or `blob-report/`) and append one `sha256:<64 hex>` digest per file. The platform checks the command against its successful command-execution event, verifies the working directory and files stay inside the project, and recomputes every digest at approval. A prose-only local run/session ID is not evidence provenance. Outside a platform-managed Run, use the repository's evidence-path convention and record a digest when practical; the platform execution ID is `Not applicable`.

## Acceptance and regression results

| Criterion or regression obligation | Repository test or observation | Execution evidence | Result |
|---|---|---|---|
| <CC-AC-001 or US-...-AC-..> | <test ID/path or declared observation> | <current report/run/trace reference> | <pass / fail / blocked / untested> |

For a bug, include the pre-fix reproduction when available, post-fix behavior, and targeted regression result. A `direct`, `skip`, or `reuse` upstream disposition never waives this evidence.

## Deferred design verification

| Obligation ID | Targets and checks | Real evidence | Result | Defect / owner / release impact |
|---|---|---|---|---|
| <B-04 or None> | <viewport, keyboard, focus, live region, contrast, reduced motion, or other declared checks> | <steps, screenshot, log, tool output, or durable reference> | <pass / fail / blocked / untested> | <defect or unresolved owner and impact, or None> |

Copy every selected `design-spec.deferred_validations` ID exactly once and name every declared target, check, and evidence type. `blocked` and `untested` are visible risks, never passing evidence; vague prose without a path, run/session ID, screenshot, report, log, or tool output is not real evidence.

## Failure classification and routing

| Failure ID | Classification | Evidence | Owner | Next action | Status |
|---|---|---|---|---|---|
| <TEST-FAIL-001 or None> | <implementation bug / test bug / spec ambiguity / design ambiguity / architecture-NFR gap / environment-CI issue> | <reproduction/report/trace> | <role or human owner> | <specific action> | <open / resolved> |

## Coverage gaps

- <Untested criterion, reason, owner, next action, and release impact, or None>

## Defects and release risk

- <Defect, severity, reproduction, and owner, or None>
- <Residual risk, human owner, and decision reference, or None>
- **Release recommendation:** <same evidence-backed recommendation as Status; human retains the decision>
