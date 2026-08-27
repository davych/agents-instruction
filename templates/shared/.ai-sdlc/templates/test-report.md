# Test Report

## Status and recommendation

- **Verification state:** <Ready for release review / Failed / Blocked>
- **Release recommendation:** <evidence-backed recommendation; a human retains the decision>
- **Platform execution ID:** <current Verification execution UUID, or Not applicable outside a platform-managed Run>
- **Product revision binding:** <exact platform-supplied product Git/workspace revision; do not invent or normalize it>
- **Linked E2E Workspace binding:** <workspace ID, canonical root/descriptor binding supplied by the platform, or Not applicable when E2E is not required>
- **E2E suite revision binding:** <exact platform-supplied E2E Git/workspace before-and-after revisions, or Not applicable>
- **Approved script manifest:** <sha256:64-hex for the complete promoted executable baseline plus human review reference, or Not applicable>

Script approval, a passing build, unit/jsdom results, or MCP success is not Verification approval and is not a browser E2E pass.

## Contract, scope, and environment

- **Change Contract:** <artifact ID, revision, and path; for a legacy Run cite only the approved user-stories artifact and stable AC IDs>
- **Design Spec:** <artifact ID, revision, path, or Not applicable for a valid Design skip>
- **Implementation Notes:** <artifact ID and refreshed revision>
- **Engineering Test Evidence:** <artifact ID and refreshed revision>
- **Engineering Review:** <artifact ID and refreshed revision>
- **Product environment:** <real build/version and loopback target>
- **E2E environment:** <linked descriptor revision, package manager, configured real browser/project, and platform readiness event>
- **Test data:** <synthetic/seeded data and cleanup, with no secrets or personal data>
- **Applicable acceptance sources:** <Change Contract and/or approved story revisions>

## Verification strategy

| Criterion, regression, deferred check, NFR, or risk ID | Evidence level | E2E disposition and reason |
|---|---|---|
| <CC-AC-001> | <unit / integration / E2E / manual observation / other> | <required / existing / not applicable, with reason> |

E2E is risk-based. Do not create a browser test for every criterion when a faster level provides stronger evidence. When E2E is not required, record why and use the selected evidence; a Linked E2E Workspace is then `Not applicable`, not silently inferred.

## E2E Stage 0: Linked workspace and readiness

- **E2E required:** <yes / no, with exact AC/risk IDs and reason>
- **Binding source:** <explicit human configuration/review reference, or Not applicable; never inferred from a sibling or legacy project>
- **Path safety:** <platform result for canonical allowed, separate non-nested roots, or Not applicable>
- **Package and script readiness:** <Playwright package/lockfile and validated package-manager/test/start identifiers>
- **Browser readiness:** <configured Chromium executable plus real headless launch-and-close probe result; a version string alone is insufficient>
- **Product target readiness:** <start-script, loopback URL, readiness, timeout, and cleanup result>
- **Workspace policy:** <allowed tests/fixtures/evidence paths and protected product/Git/environment boundary>
- **Preflight conclusion:** <ready / blocked / not applicable, with machine event and actionable owner>

The platform does not scan for or adopt a legacy E2E folder. Missing binding, dependency, browser, start script, or target readiness remains an environment/configuration blocker and cannot be converted to `pass` by prose.

## E2E Stage 1: Exploration

- **Playwright MCP status:** <not needed / completed / blocked>
- **Session/run reference:** <real session ID or None>
- **Environment and path explored:** <URL/build plus user-visible steps or None>
- **Observations and selector candidates:** <diagnostic findings or None>
- **Diagnostic evidence:** <screenshot/log/tool reference or None>
- **Isolation statement:** <MCP code/transcript/DOM dump was not passed to the Test Author, or disclose the real limitation>
- **Gate statement:** Exploration is an optional one-off diagnostic draft. MCP “ran through” is not repeatable acceptance or CI evidence and cannot pass Verification by itself.

A real MCP screenshot may supplement a specifically declared manual/deferred observation when its contract accepts that evidence type. It still does not prove an approved reusable script or standalone Chromium run.

## E2E Stage 2: Crystallization and script review

- **Frozen test-intent reference:** <deterministic durable AC/regression scenario reference or Not applicable>
- **Authoring isolation:** <Tier A / Tier B / Tier C / Limited / Not applicable>
- **Fresh Test Author:** <platform authoring stage/model/session identity or Not applicable>
- **Inputs visible during intent authoring:** <approved Change Contract or story ACs, observable Design/NFR, frozen intent, and linked public harness only>
- **Excluded context confirmed:** <product implementation, implementation diff/transcript, private helpers, exploration code/transcript, MCP actions, and DOM dump were not visible, or disclose the limitation>
- **Temporary staging identity:** <fresh staging-copy ID, baseline revision, and workspace token, or Not applicable>
- **Author working directory:** <exact temporary staging root; never the Linked E2E Workspace or product root, or Not applicable>
- **Staging write policy:** <allowlisted tests/fixtures only; no execution, dependency install, Git/environment/workflow mutation, CI configuration, or direct linked-root write>
- **Staging validation:** <non-executing path/symlink/protected-file/allowlist/schema checks and result>
- **Product workspace mutation:** <No, backed by the platform guard; otherwise Failed>
- **E2E before/after revision:** <exact platform bindings>
- **Validated promotion result:** <platform event that copied only validated allowlisted tests/fixtures into the linked root, or blocked / Not applicable>
- **Promoted suite baseline:** <linked-root revision/token plus complete executable test/fixture file set, including unchanged files>

| Linked-workspace test/fixture path | Stable AC/scenario IDs and exact test name | Content SHA-256 | Change |
|---|---|---|---|
| <tests/checkout-coupon.spec.ts> | <CC-AC-003 · applies an eligible coupon> | <sha256:64-hex> | <created / changed / unchanged> |

- **Aggregate manifest hash:** <sha256:64-hex for the complete promoted executable baseline, or Not applicable>
- **Human script review:** <approved exact promoted-baseline manifest hash + durable review ID/date, request changes, or Not applicable>
- **Approval freshness:** <product revision, linked-root revision/binding, complete file set, and bytes still match immediately before execution / invalidated>
- **Selector rationale:** <role/label/text/reviewed test contract; explain any documented CSS fallback>

A candidate script or change manifest is not passing evidence. The fresh Test Author writes only in temporary staging and never executes generated code. After non-executing validation, the platform promotes only the validated allowlisted changes, then records and re-hashes the complete linked-root executable baseline. A human reviews that exact promoted baseline; script review authorizes execution only, not promotion, Verification, CI policy, PR, merge, risk, or release. Any approved-baseline byte, file set, product/E2E revision, or binding drift blocks execution and requires a new staging cycle.

If a failure requires product source, product-repository tests, or a product testability-interface change, cite the refreshed Software Engineer evidence and Implementation reapproval before resuming. An E2E-only test bug returns to a fresh staging copy, authoring, validation, promotion, complete-baseline hash review, and execution instead.

## E2E Stage 3: Execution

| Execution | Exact command and trusted working directory | Product and E2E revisions / real browser | Result | Durable evidence |
|---|---|---|---|---|
| <platform local standalone / remote CI> | <exact validated package-manager test script in backticks plus exact linked E2E root; never MCP> | <both bindings + Chromium project/version/launch event> | <pass / fail / blocked / untested plus exit code> | <configured local file plus sha256 digest, or durable remote CI URL/run ID> |

- **Platform launch contract:** <fixed argv, `shell: false`, trusted linked cwd, and machine stage/event IDs>
- **Product server lifecycle:** <start event, loopback readiness, stop/cleanup result, and logs>
- **Real browser launched:** <yes with Chromium launch event, or no with exact error; `No browser is available` is blocked>
- **MCP used for execution:** No. Stage 3 uses the platform-supervised standalone runner.
- **Retry/flake history:** <first result, retries, classification, owner, and next action or None>
- **Required PR check:** <expected autonomous command/check contract plus separately authorized human/provider owner; planned/not configured, or confirmed with durable run reference>

The canonical local form is `` `<one validated package-manager test script>` from `<exact trusted linked E2E root>` ``. Markdown cannot authorize an arbitrary external cwd or invented command. The command must match the current successful platform `command_execution` event; compound shell, comments, inline assignments, substitutions, redirection, and detached/background commands are not valid evidence.

For platform-managed local evidence, use only the configured Linked E2E Workspace evidence directories and append one `sha256:<64 hex>` digest per report, trace, screenshot, video, or log file. Approval re-hashes scripts and evidence and validates both product and E2E revisions. A local pass is not a remote CI pass; “configured” or “expected to run” is not a completed required check. Tester and DevOps only record or validate the expected check contract; only a separately authorized human or provider system configures it.

## Acceptance and regression results

| Criterion or regression obligation | Test or declared observation | Current machine execution evidence | Result |
|---|---|---|---|
| <CC-AC-001 or US-...-AC-..> | <linked script path + test name, repository test, or declared observation> | <platform event/report/trace/hash reference> | <pass / fail / blocked / untested> |

For a bug, include pre-fix reproduction when available, post-fix behavior, and targeted regression. A `direct`, `skip`, or `reuse` upstream disposition never waives this evidence. Unit/jsdom success must remain labeled as such and cannot replace required real-browser evidence.

## Deferred design verification

| Obligation ID | Targets and checks | Real evidence | Result | Defect / owner / release impact |
|---|---|---|---|---|
| <deferred-validation-id or None> | <viewport, keyboard, focus, live region, contrast, reduced motion, or other declared checks> | <real-browser event, screenshot, trace, log, or durable reference> | <pass / fail / blocked / untested> | <defect or unresolved owner and impact, or None> |

Copy every selected `design-spec.deferred_validations` ID exactly once and name every target, check, and evidence type. `blocked` and `untested` are visible risks, never passing evidence; static source review, jsdom, or vague prose cannot replace a required real-browser observation.

## Failure classification and routing

| Failure ID | Classification | Evidence | Owner | Next action | Status |
|---|---|---|---|---|---|
| <TEST-FAIL-001 or None> | <implementation bug / testability-interface gap / test bug / spec ambiguity / design ambiguity / architecture-NFR gap / environment-CI issue> | <reproduction/report/trace/log/hash> | <role or human owner> | <specific action> | <open / resolved> |

Product or product-repository test changes return to Software Engineer and refresh engineering evidence. E2E-only test bugs return to a fresh staging copy and repeat validation, promotion, complete-baseline exact-hash review, and execution. Environment/browser/server problems return to the authorized operator and preflight.

## Coverage gaps

- <Untested criterion, reason, owner, next action, and release impact, or None>

## Defects and release risk

- <Defect, severity, reproduction, and owner, or None>
- <Residual risk, human owner, and decision reference, or None>
- **Release recommendation:** <same evidence-backed recommendation as Status; a human retains the decision>
