# Playwright E2E reference

Use this reference for the safety and evidence rules behind Tester's risk-based E2E procedure.

## Control-plane boundaries

| Surface | Allowed purpose | Durable evidence | Gate capability |
|---|---|---|---|
| Playwright MCP | Optional exploration and diagnostic observation | Real session reference and permitted diagnostics | Cannot prove repeatable E2E or CI |
| Fresh spec-only Test Author | Write allowlisted tests/fixtures in a temporary staging copy; never execute them | Staged relative-path change manifest and content hashes | Cannot pass until promoted, reviewed, and executed |
| Platform validation and promotion | Validate without execution and apply only allowlisted changes to the linked root | Change manifest, promotion event, linked-root revisions, complete promoted suite manifest | Cannot authorize execution or pass the gate |
| Human script review | Review the complete promoted executable baseline and its aggregate hash | Durable approval of that exact promoted baseline/hash | Authorizes execution only; not promotion or Verification |
| Standalone `playwright test` | Run the approved promoted baseline from the trusted linked root with real Chromium | Command event, exit, report, trace, media/log hashes | Pass-capable when current, complete, and provenance-bound |

MCP and the standalone runner use related automation technology but different control planes. The runner is a platform-spawned foreground process with fixed argv and `shell: false`. CI must use the same autonomous repository wrapper with no Agent or MCP dependency. Unit/jsdom, lint, typecheck, build, authoring, validation, review, and promotion remain accurately labeled; none is a real-browser pass.

## Linked workspace and staging safety

The E2E harness is a separate local project explicitly linked by a human. It is neither the product root nor another six-phase platform Project.

- Accept only the platform-supplied workspace identity, canonical allowed absolute root, descriptor hash, loopback base URL, package-manager/script identifiers, browser, writable test/fixture allowlist, and evidence directories.
- Reject a symlink root or write target; identical, nested, or overlapping product/E2E/staging roots; path traversal; absolute descriptor subpaths; unsafe identifiers; protected Git/environment/workflow paths; and initialization into a non-empty unmanaged directory.
- Never scan siblings, guess names such as `e2e`, follow legacy prose, or adopt an old repository automatically.
- Product source and product-repository tests remain read-only to Tester. The Linked E2E Workspace remains read-only during authoring.
- The platform derives each fresh temporary staging copy from the pinned public harness of the bound linked revision. The copy has a unique identity/token and no product implementation material.
- Only the staging root is writable to the Test Author, and only its allowlisted test/fixture paths may change. Staging runtime output, dependency installation, Git/environment mutation, CI configuration, commits, pushes, detached processes, and direct writes to the linked root are forbidden.
- Failed, invalid, or superseded staging copies are discarded. A rejected or stale promoted baseline remains non-executable and must be replaced through a new staging cycle; never reuse staging as authority for a later Run.

If E2E is required and no safe binding exists, stop at the platform configuration action. When E2E is not selected, a missing binding is `Not applicable` rather than a blocker.

## Structured readiness

Preflight reports these conditions separately:

1. workspace identity, descriptor hash, canonical-root separation, and product/E2E baselines;
2. package manifest, lockfile, Playwright package, and validated package-manager/test/start identifiers;
3. configured Chromium executable and a real headless launch-and-close probe;
4. product start script, loopback target readiness, timeout, and cleanup capability;
5. writable test/fixture paths, protected paths, and runtime-evidence policy;
6. ability to create an isolated staging copy and validate promotion without broad filesystem writes.

`playwright --version`, a package entry, MCP connectivity, a build, or a unit test does not prove Chromium can launch. Missing package, browser, server, target, staging, or cleanup readiness is an actionable environment failure.

## Independent author input

Freeze stable scenario IDs, preconditions, synthetic data, user-observable actions, assertions, negative/recovery behavior, and declared viewport/accessibility/NFR obligations before authoring.

The fresh Tier A/B Test Author may receive:

- the immutable Change Contract or stable IDs from the approved selected `user-stories` artifact for a legacy Run;
- approved observable Design behavior and public Architecture/NFR constraints;
- the frozen scenario intent;
- only the minimum public E2E harness, documented selector contract, and validated wrapper identifier.

It must not receive product source, implementation diff/transcript, private helpers, proposed implementation details, exploration code/transcript, MCP actions, copied DOM dumps, or generated exploration scripts. A new prompt inside an implementation, Tester, or exploration process is not a fresh author.

Prefer selectors in this order:

1. accessible role plus stable accessible name;
2. associated label, placeholder, or stable user-facing text;
3. reviewed product testability interface intentionally owned by Software Engineer;
4. documented stable CSS selector as a last resort.

Do not guess selectors from private DOM structure or weaken expected behavior to fit the implementation. Use synthetic, seeded, or explicitly approved non-production data; prevent secrets or personal data from entering tests, traces, screenshots, videos, or reports.

## Manifest validation, promotion, and review

Validation is non-executing. Compare staging to its pinned baseline and reject anything outside the allowlist. For every candidate change, record:

- normalized linked-root-relative path and change type;
- stable scenario IDs and exact test name or fixture purpose;
- content `sha256:<64 hex>`;
- staging identity, baseline revision/token, and authoring session;
- product revision plus linked binding/revision;
- one deterministic change-manifest hash over the ordered entries.

Validation also checks path containment, symlink resolution, file type, protected paths, fixture policy, declared scenario coverage, and any safe static schema/syntax rule that does not execute generated code.

After validation, the platform may promote only manifest-listed allowlisted tests/fixtures, from that staging identity, into the bound linked root. It records the linked-root before/after revisions. Promotion is a validated file operation, not an execution authorization.

After promotion, enumerate and re-hash the complete executable test/fixture baseline in the linked root, including unchanged suite files. Record every relative path and SHA-256, the promoted linked revision/token, and one deterministic aggregate promoted-suite manifest hash. A distinct human approves that exact complete baseline for execution. Review does not authorize promotion and does not approve Verification, CI policy, merge, risk, or release.

Immediately before execution, confirm the linked root still has the approved revision, file set, relative paths, and hashes. Any byte, scenario mapping, product revision, linked revision/binding, descriptor, or aggregate manifest drift invalidates approval. Regeneration starts in a new staging copy and repeats validation, promotion, complete-baseline review, and freshness checking.

## Standalone execution evidence

Execution begins only after human approval and a successful freshness check of the complete promoted suite manifest:

- build fixed argv from validated package-manager/script identifiers and spawn with `shell: false`;
- use the trusted Linked E2E Workspace root—not staging or the product root—as cwd;
- supervise the product server, loopback readiness, standalone test process, and cleanup as foreground work;
- require the configured real headless Chromium to launch and the persisted command to exit 0 for a local pass;
- preserve launch, readiness, timeout, test, and cleanup failures as non-passing logs;
- record product and E2E revisions, promoted manifest hash, command/cwd, browser/project/version, target/build, test data, exit, retry/flake history, and first failure;
- retain only approved reports, traces, screenshots, videos, and logs, with one SHA-256 per file.

The canonical local evidence form is `<validated wrapper> from <exact trusted linked root>` plus the matching platform `command_execution` event. Markdown cannot authorize a different command or cwd.

## CI and authority

Tester records the expected autonomous wrapper, check name, revision binding, and evidence requirements. DevOps may validate that expected contract and carry it into the runbook. Only a separately authorized human or provider system configures or changes CI/required checks, credentials, browser provisioning, environments, branch policy, or retention.

A local pass is not a remote CI pass. Record remote success only from a current durable provider run URL/ID bound to the same revision and approved scripts. “Expected,” “configured,” queued, skipped, or unavailable is not a completed passing check.
