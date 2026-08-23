# Playwright E2E reference

Use this reference when a user-critical browser journey needs exploration, a durable E2E test, or standalone execution evidence.

## Tool boundary

| Surface | Best use | Durable asset | Can satisfy repeatable E2E/CI gate alone? |
|---|---|---|---|
| Playwright MCP | AI exploration, DOM/accessibility observation, selector discovery, screenshots, fast diagnosis | No; transient session note only | No |
| Repository `*.spec.ts` | Reviewable scenario, assertions, fixtures, and selectors | Yes, after Software Engineer integration and evidence refresh | Not until executed |
| Standalone `playwright test` | Local or CI execution of the repository suite | Result, report, trace, screenshot/video when configured | Yes, when current, successful, and traceable |

MCP and the Playwright test runner may use the same browser automation technology, but they serve different control planes. MCP is an AI tool session. CI must be able to start from the repository and environment configuration with no AI or MCP connection.

## Independent session contract

Before the independent author sees the runnable implementation, freeze:

- authoritative AC and scenario IDs;
- preconditions and synthetic test data;
- user-observable actions;
- expected state transitions and assertions;
- required negative or recovery path;
- any declared viewport, accessibility, locale/time, or NFR obligation.

Allowed authoring inputs are the immutable Change Contract, approved observable product/design behavior, public Architecture/NFR constraints, frozen intent, and the minimum public test harness/command contract. Exclude the implementation diff, private helper design, implementation transcript, exploration code, MCP action transcript, copied DOM dump, and exploration-generated test code.

After intent is frozen, public UI and harness inspection may adapt the script so it runs. Record what became visible and confirm that no expected outcome was changed during adaptation.

## Selector policy

Choose the highest stable observable contract available:

1. Accessible role and name: `getByRole`, including an exact user-visible name.
2. Associated label or stable user-facing text: `getByLabel`, then careful `getByText` use.
3. A deliberate product test contract such as `data-testid` when no stable accessible locator exists; ask Software Engineer to add it as a reviewed interface rather than inventing a brittle DOM path.
4. CSS locator only for a documented compatibility constraint.

Avoid generated classes, deep CSS chains, XPath, layout position, and `nth-child`/`nth()` when a semantic contract exists. A selector that merely survived one MCP session is a candidate, not proof of stability. The durable test should assert business-visible outcomes, not implementation-only DOM structure.

## Scenario example: checkout coupon

For a request such as “verify that a user can complete checkout with a coupon”:

1. Map the scenario to stable IDs, for example `CC-AC-003` and `REG-CHECKOUT-001`.
2. Freeze intent: an eligible coupon is applied, the displayed total reflects the rule, the order completes once, and an invalid/expired coupon follows the specified failure behavior.
3. Use MCP only to learn whether the path is runnable and which accessible contracts exist. Keep its session and screenshots as diagnostic references, not the pass result.
4. In a fresh Tier A/B session, author a candidate following repository conventions. The final integrated path may be `tests/e2e/checkout-coupon.spec.ts`; do not copy the MCP action code.
5. Return the candidate to Software Engineer for integration, real checks, and engineering evidence refresh.
6. After reapproval, run the project command, for example `playwright test tests/e2e/checkout-coupon.spec.ts` or its repository script. Record the exact command that really ran, not this illustrative string.
7. Link the current revision, result, HTML/JUnit report, and any retained failure trace/screenshot in `test-report`.

For platform-managed Verification, the current revision is not free-form prose. Preserve the supplied `workspace sha256:<token>; platform execution <UUID>` and pre-run Git binding exactly: `git HEAD <full SHA>`, `git unborn <symbolic ref>`, or `git state:not-repository`. Do not infer non-Git from a failed post-run command. For every local row, use exactly `` `<one direct runner or repository test-wrapper command>` from `<exact project root>` ``, retain the report under `test-results/`, `playwright-report/`, or `blob-report/`, and record its SHA-256 digest. Compound shell, comments, echo/printf, inline assignments, quoting/substitution, redirection, and background/detached execution are rejected; place complex setup in a reviewed repository script, record setup separately, and wait for the test command to complete. Approval recomputes the protected-worktree token and evidence digests, compares current Git state/HEAD to the persisted pre-run state, and matches that same canonical command against the successful command-execution event. Extra command prose or candidates are rejected. A typed local run ID, nonexistent path, or invented revision will fail closed.

## Test data and environment

- Use synthetic, seeded, or explicitly approved non-production data. Never expose production secrets or personal data in screenshots, traces, videos, or reports.
- Make setup and cleanup deterministic. A test that depends on order, shared mutation, wall-clock coincidence, or an unrecoverable account is not CI-ready.
- Declare base URL, browser/project, viewport, locale/timezone, feature flags, external-service stubs, and authentication fixture where they affect behavior.
- Do not use retries to mask nondeterminism. Record the first failure and the final classification.

## CI handoff contract

Tester hands DevOps or the repository owner:

- exact repository command and working directory;
- test file/project scope and mapped AC/risk IDs;
- required environment variables by name only, never secret values;
- browser/dependency installation expectations;
- pass/fail exit semantics and timeout budget;
- reporter format and artifact locations;
- trace/screenshot/video retention policy, especially on failure;
- expected required-check name and triggering PR events;
- known flake, external dependency, data cleanup, and parallelism constraints.

DevOps validates that the command runs in CI without MCP and makes the check required when authorized. Tester records only real local or remote evidence. “Expected to run in CI” is readiness, not a successful CI run.
