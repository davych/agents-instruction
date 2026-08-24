# Playwright E2E reference

Use this reference when a user-critical browser journey needs optional exploration, an independently authored durable E2E test, or platform-supervised standalone execution evidence.

## Tool and control-plane boundary

| Surface | Best use | Durable asset | Can satisfy repeatable E2E/CI gate alone? |
|---|---|---|---|
| Playwright MCP | Optional AI exploration, accessibility/DOM observation, diagnostic screenshots | No; transient session note only | No |
| Fresh spec-only Test Author | Write reviewable scenarios and fixtures only in the explicitly linked E2E workspace | File manifest, scenario IDs, and script SHA-256 | No; exact generated hashes require human approval and execution |
| Platform-supervised standalone `playwright test` | Launch the configured real headless Chromium and run approved scripts from the trusted linked root | Exit result, report, trace, screenshot/video/log hashes | Yes, when current, successful, complete, and provenance-bound |

MCP and the Playwright test runner may use the same automation technology, but they are different control planes. MCP is an AI tool session. The gate runner is a platform-spawned foreground process with fixed argv and `shell: false`; CI must be able to run the same repository wrapper with no AI or MCP connection.

Vitest/Jest/jsdom, lint, typecheck, and build evidence may prove important lower-level obligations, but they do not launch a real browser. Never label those results as a Chromium E2E pass.

## Linked E2E Workspace contract

The E2E harness is a separately maintained local project explicitly linked by a human. It is not the product root, not a nested directory, and not another six-phase platform Project. The platform supplies its trusted identity and path to Verification.

- Never scan sibling directories, guess names such as `e2e`, follow legacy documentation, or adopt an old repository automatically.
- Use only the configured canonical allowed absolute root, loopback base URL, package-manager/script identifiers, browser, test/fixture allowlist, and evidence directories.
- Registration rejects a symlink root or symlinked write target, identical or nested product/E2E roots, path traversal or absolute descriptor subpaths, unsafe package-manager/script identifiers, and initialization into a non-empty unmanaged directory.
- Product source, product-repository tests, workflow controls, Git metadata, environment files, and paths outside the linked root are read-only.
- The Test Author may change only allowed test/fixture assets. It must not install packages, mutate `.git` or `.env*`, commit, push, configure CI, or start detached/background work.
- If E2E is required and no safe binding exists, stop with the platform's configuration action. If E2E is not selected by the risk map, the missing binding is not itself a blocker.

## Readiness is not execution

Preflight reports these conditions separately:

1. linked-workspace binding/path safety and descriptor hash;
2. package manifest, lockfile, Playwright package, and validated test/start script identifiers;
3. configured Chromium executable and a real headless launch-and-close probe;
4. product start-script and loopback-target readiness;
5. writable test/fixture and runtime-evidence policy;
6. product and E2E Git/workspace baselines.

`playwright --version`, a package entry, an MCP connection, a build pass, or a unit test does not prove that Chromium can launch. Missing package/browser/start readiness is an actionable environment failure, never acceptance evidence. Binding and dependency/browser installation are explicit human setup actions; the test flow does not silently import or prepare an unrelated legacy repository.

## Independent authoring contract

Before the fresh author process starts, freeze:

- authoritative AC, regression, and scenario IDs;
- preconditions and synthetic test data;
- user-observable actions;
- expected state transitions and assertions;
- required negative or recovery path;
- declared viewport, accessibility, locale/time, or NFR obligations.

Allowed inputs are the immutable Change Contract, approved observable product/design behavior, public Architecture/NFR constraints, approved legacy `user-stories` ACs where a structured contract does not exist, frozen intent, and the minimum linked-workspace harness/command contract. Exclude the product implementation, implementation diff, private helper design, implementation transcript, exploration code, MCP action transcript, copied DOM dump, exploration transcript, and exploration-generated script.

The author runs as a fresh Tier A/B subprocess in only the linked E2E root and does not execute newly generated code. A different prompt in the Tester/exploration process is not fresh isolation. If the authoritative observable contract does not expose a stable selector, request a reviewed testability interface from Software Engineer; do not inspect private implementation structure or relax the frozen expected outcome.

## Selector policy

Choose the highest stable observable contract available:

1. Accessible role and exact user-visible name: `getByRole`.
2. Associated label or stable user-facing text: `getByLabel`, then careful `getByText`.
3. A deliberate product test contract such as `data-testid` when no stable accessible locator exists; Software Engineer owns that product-interface change and its engineering evidence refresh.
4. CSS locator only for a documented compatibility constraint.

Avoid generated classes, deep CSS chains, XPath, layout position, and `nth-child`/`nth()` when a semantic contract exists. A selector seen in one MCP session is only a diagnostic candidate and cannot be copied into the author context.

## Generated-script review

Authoring produces a machine manifest, not a passing result. For each generated or changed executable asset, retain:

- linked-workspace-relative path;
- mapped stable AC/scenario IDs and exact test name;
- content SHA-256;
- E2E workspace before/after revision tokens;
- one aggregate manifest hash.

A human must approve that exact aggregate manifest hash before the platform executes the new scripts. Any changed byte, file set, binding, product revision, E2E revision, or workspace token invalidates approval. Script approval authorizes execution only; it does not approve Verification, CI policy, a PR, merge, risk, or release.

## Scenario example: checkout coupon

For “verify that a user can complete checkout with a coupon”:

1. Map the scenario to stable IDs such as `CC-AC-003` and `REG-CHECKOUT-001`.
2. Freeze intent: an eligible coupon changes the displayed payable total, the order completes once, and invalid/expired coupons follow the approved failure behavior.
3. Optionally use MCP to diagnose whether the live path is reachable. Do not pass its actions, transcript, DOM dump, or generated code to the Test Author.
4. Start a fresh spec-only author in the explicitly linked root and produce a conventional file such as `tests/checkout-coupon.spec.ts` with stable IDs.
5. Persist the file and aggregate manifest SHA-256. Stop until a human approves the exact current manifest hash.
6. After approval, let the platform supervise the product server and run the configured wrapper from the linked root against real headless Chromium. Do not type or invent an illustrative command into the report.
7. Link both product and E2E revisions, the trusted command/cwd event, exit result, HTML/JUnit report, and retained trace/screenshot/video/log hashes in `test-report`.

If the script exposes a product bug or missing product testability interface, return that product change to Software Engineer and refresh Implementation evidence. If the script itself is wrong, return to a fresh Test Author, approve the new manifest hash, and rerun without mutating the product repository.

## Platform execution and dual provenance

For platform-managed Verification, copy only the bindings supplied by the current execution. The report carries:

- the product Git/workspace revision;
- the Linked E2E Workspace identity and descriptor hash;
- the E2E Git/workspace before and after revisions;
- the approved script manifest hash;
- the current platform execution/stage IDs.

For every local E2E row, use exactly `` `<one validated package-manager test script>` from `<exact trusted linked E2E root>` ``. The platform, not Markdown, authorizes that cwd through its linked-workspace event and matches the command to the successful `command_execution` event. Compound shell, comments, echo/printf, inline assignments, substitutions, redirection, and detached/background execution are invalid.

Keep report, trace, screenshot, video, and log output under configured linked-workspace evidence directories and record one `sha256:<64 hex>` digest per file. Approval re-hashes scripts and evidence, verifies the product remained read-only, checks both workspace/Git bindings, and rejects stale, invented, missing, or mismatched data.

The platform runner must supervise product-server startup/readiness and cleanup. `No browser is available`, a missing Chromium executable, launch failure, nonzero/timeout test result, or cleanup failure remains non-passing with real logs. A typed local run ID or a successful MCP session is not provenance.

## Test data and environment

- Use synthetic, seeded, or explicitly approved non-production data. Never expose production secrets or personal data in screenshots, traces, videos, or reports.
- Make setup and cleanup deterministic. A test that depends on order, shared mutation, wall-clock coincidence, or an unrecoverable account is not CI-ready.
- Declare loopback base URL, browser/project, viewport, locale/timezone, feature flags, external-service stubs, and authentication fixture where they affect behavior.
- Do not use retries to mask nondeterminism. Preserve the first failure and classify any flake.

## CI handoff contract

Tester hands DevOps or the authorized owner:

- exact validated package-manager command and linked-workspace working directory;
- test files, manifest hash, mapped AC/risk IDs, and both bound revisions;
- required environment variable names only, never secret values;
- browser/dependency and product-server expectations;
- exit semantics and timeout budget;
- reporter and evidence directories;
- trace/screenshot/video/log retention policy;
- expected required-check name and trigger events;
- known flake, external dependency, cleanup, and parallelism constraints.

DevOps validates that CI can run the same wrapper without MCP and makes the check required when authorized. Tester records only real local or remote evidence. “Expected to run in CI” is readiness, not a successful CI run.
