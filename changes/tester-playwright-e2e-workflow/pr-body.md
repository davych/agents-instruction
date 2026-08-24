# Tester Playwright E2E workflow — delivery provenance

## Summary

- Add an explicitly configured Linked E2E Workspace that is separate from the product repository and is never inferred from a sibling or legacy E2E project.
- Add a fresh spec-only Test Author that writes only managed tests/fixtures, followed by human review of the complete executable suite and exact hashes.
- Add platform-supervised product startup, real headless Chromium target probing, standalone Playwright execution, durable success/failure evidence, process-group/port cleanup, and dual-workspace provenance.
- Add a state-aware Verification UI for configure → preflight → generate → review scripts → run Chromium → review Verification, while retaining the ordinary path for Runs explicitly proven unconfigured.
- Keep the fixed six phases, existing phase owners, registered artifacts, human Verification approval, and release boundary unchanged.

## Human-owned architecture/scope decision

The user explicitly chose a separately maintained E2E project whose scripts are produced and maintained by the testing flow. The implementation applies that decision through a Linked E2E Workspace. No Agent approved an architecture/security exception, DDL, CI/secrets change, merge, deploy, or release.

## Evidence links

- Spec: `changes/tester-playwright-e2e-workflow/delta.md`
- Plan: `changes/tester-playwright-e2e-workflow/plan.md`
- Tasks: `changes/tester-playwright-e2e-workflow/tasks.md`
- Session log: `sessions/tester-playwright-e2e-workflow/session-log.md`
- Tests: `changes/tester-playwright-e2e-workflow/test-evidence.md`
- Review: `reviews/tester-playwright-e2e-workflow/review.md`
- Real Chromium smoke: `changes/tester-playwright-e2e-workflow/artifacts/real-chromium-smoke.json`
- Sanitized runner manifest: `changes/tester-playwright-e2e-workflow/artifacts/real-chromium-runner-manifest.json`

## Verification

- Independent acceptance contract: 20/20 pass.
- Linked E2E focused gate suite: 93/93 pass.
- Root suite: 23/23 pass.
- Platform suite: 683/683 pass.
- Typecheck, production build, package dry-run, and diff hygiene: Pass.
- True-browser platform smoke: Playwright 1.62.1; Chromium 151.0.7922.34; target HTTP 200; test exit 0; server exit 0; cleanup `sigterm`.
- Final independent Tier B adversarial verdict: Pass, with no remaining P1/P2 in the supported POSIX local-execution scope.

## Isolation and provenance

- AC-TESTER-001 through AC-TESTER-013 began with a Tier A acceptance-contract authoring session before implementation.
- AC-TESTER-014 through AC-TESTER-020 received a Tier B spec-only adversarial matrix frozen before repository inspection, followed by independent failure reproduction and re-verification.
- Product and E2E revision tokens, full script contents/hashes, DB script review, fixed commands/cwd/base URL, browser/version/target result, raw exit code, cleanup, reports/traces/screenshots, and evidence hashes are bound by machine events rather than Markdown claims.
- The final real-browser fixture was temporary, did not use the legacy E2E project, and was deleted after sanitized machine evidence was retained.

## Known limitations

- The real-browser smoke validates the platform runner, not any user's product acceptance criteria.
- The workspace guard is synchronous rollback protection rather than an OS sandbox; authoring is Tier B isolation.
- POSIX descendant-process cleanup is covered. Windows does not yet have equivalent process-tree coverage, but retained port occupancy fails closed.
- Dependency/browser setup is explicit and may need operator-approved network access.
- The complete script-review payload is bounded to 200 kB and fails closed above that size.
- Remote CI references are not provider-authenticated without a connector.
- The Web production build retains an existing large-chunk warning unrelated to this change.

## Publication boundary

- PR created or opened by Software Engineer: No
- PR published by Software Engineer: No
- Merge performed or approved by Software Engineer: No
- Deploy or release performed or approved by Software Engineer: No
