# Tester Role Guide

This is the human-facing overview for the Verification phase. The executable procedure and Playwright rules remain in the canonical sources linked below.

## Purpose and non-goals

Tester turns the accepted Change Contract, regressions, deferred Design checks, NFRs, and material risks into an independent and reproducible Verification conclusion.

Tester owns risk mapping, selected verification, linked E2E test assets, execution evidence, defect classification, and the Run-scoped `test-report`. Tester does not redefine requirements, silently repair product code, weaken assertions, infer a legacy E2E repository, configure CI/required checks, commit or push, or approve release.

Playwright MCP is optional diagnostic exploration. It cannot satisfy repeatable E2E or CI evidence by itself.

## When it runs

Tester starts only after the current Implementation revision and engineering evidence pack have human approval.

Not every criterion needs E2E. Tester selects the strongest appropriate unit, integration, contract, E2E, or declared observation evidence from acceptance and risk. A Run without E2E obligations does not require a Linked E2E Workspace.

When durable E2E is required, a human must explicitly bind a separate, non-nested Linked E2E Workspace. The platform never searches for a sibling, conventional directory name, prior report, or legacy repository.

## Inputs and outputs

| Direction | Artifact or binding | Contract |
|---|---|---|
| Input | `change-contract` and Product clearance | Immutable scope, criteria, non-goals, and regressions |
| Input | Applicable `design-spec` | Observable behavior and stable deferred-validation obligations |
| Input | Accepted `architecture` / NFR evidence | Active constraints, quality targets, and risks |
| Input | `implementation-notes`, `engineering-test-evidence`, `engineering-review` | Current engineering handoff; self-review is input, not Tester approval |
| Conditional input | Linked E2E Workspace binding and preflight | Trusted roots, harness, scripts, browser, loopback target, and evidence contract |
| Output | `test-report` | Coverage, execution evidence, failures, gaps, defects, risk, and recommendation |

Linked scripts, manifests, and runtime evidence support `test-report`; they are not extra registered workflow artifacts.

## What the human reviews

Before Tester runs, confirm that `implementation-notes` is ready, the real diff exists, engineering test evidence is current, and no unresolved severe/security finding blocks Verification.

For required E2E, review this control chain:

1. the human-selected linked root is separate, non-nested, allowed, and ready;
2. optional MCP exploration is clearly non-gating and excluded from authoring context;
3. the platform freezes authoritative spec-only intent;
4. the platform copies the linked workspace to ephemeral staging;
5. a fresh Tier A/B Test Author changes only allowlisted tests/fixtures in staging and does not execute them;
6. the platform validates those changes and promotes only the allowlisted files to the unchanged linked root;
7. the platform enumerates and re-hashes the complete promoted executable suite, including unchanged files;
8. a human approves that exact baseline and aggregate hash;
9. after a freshness check, the platform runs fixed-argv standalone Playwright from the linked root with the configured real headless Chromium;
10. `test-report` binds product/E2E revisions, trusted command/cwd, exit, cleanup, and retained evidence hashes.

Any relevant file, manifest, binding, product revision, or E2E revision change invalidates script approval. Script approval authorizes those exact bytes to execute; it does not approve Verification, CI, merge, risk, or Release.

Verification passes only when every applicable criterion, regression, deferred validation, NFR, and material risk has current evidence; required E2E matches the approved manifest and real-browser execution; and all failures, blocked/untested scope, flakes, gaps, and residual risks remain visible.

A local pass is not a remote CI pass. An authorized human or repository/provider system configures credentials, browser provisioning, retention, branch protection, CI policy, and required checks. Tester supplies the command and evidence contract; DevOps may record the expected check and evidence gap but does not configure it.

## Handoff and escalation

DevOps receives the current `test-report`, trusted evidence references, untested scope, defects, residual risk, and the expected external check contract.

Route failures by owner:

- product source, product-repository test, or public testability-interface defect → Software Engineer, evidence refresh, and Implementation reapproval;
- linked script defect → fresh staging Test Author, allowlist validation/promotion, new manifest review, and rerun;
- specification ambiguity → PM / BA or human contract owner;
- visible-behavior ambiguity → Designer;
- architecture/NFR gap → Architect or human risk owner;
- binding, browser, environment, CI/provider, credential, or retention issue → authorized operator/provider system.

Tester records the supported recommendation but does not make final go/no-go.

## Canonical sources

- [Canonical Tester Agent](../../../templates/agents/tester.md)
- [Global workflow definition](../../../templates/ai-native.yaml)
- [Shared workflow](../../../templates/shared/.ai-sdlc/workflows/default.md)
- [Tester workflow](../../../templates/shared/.ai-sdlc/roles/tester/workflow.md)
- [Playwright E2E reference](../../../templates/shared/.ai-sdlc/roles/tester/references/e2e-playwright.md)
- [Test report template](../../../templates/shared/.ai-sdlc/templates/test-report.md)
- [Platform runtime contract](../../../platform/docs/runtime-contract.md)
- [Platform security model](../../../platform/docs/security-model.md)

Return to [Role Relationships](../README.md).
