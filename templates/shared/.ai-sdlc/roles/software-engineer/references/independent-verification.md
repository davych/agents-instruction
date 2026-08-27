# Independent verification

Independent test design challenges the external contract instead of confirming assumptions shared with the implementation. Tests are real repository files and must execute against the real change; independence applies to their design and authoring context, not to pretending the implementation does not exist at execution time.

## Isolation tiers

| Tier | Test-authoring context | Gate result |
|---|---|---|
| A | Fresh model and fresh session; authoritative requirements visible; implementation and implementation-session transcript not visible | Pass-capable |
| B | Fresh session, possibly the same model; authoritative requirements visible; implementation and implementation-session transcript not visible | Pass-capable |
| C | Same session with an instruction to ignore previously seen implementation | Blocked unless a human grants a verification-gate exception |
| Limited | Independence cannot be established or the test author saw material implementation detail | Blocked unless a human grants a verification-gate exception |

A different prompt in the implementation session is not Tier A or B. A code review after test intent is frozen does not retroactively destroy isolation, but the evidence must distinguish authoring from later execution and debugging.

## Independent authoring method

1. Give the independent author only the immutable Change Contract, applicable acceptance and regression evidence, approved observable Design behaviour, relevant public Architecture constraints, and the project's test interface or commands needed to create runnable tests.
2. Do not provide the implementation diff, implementation-session transcript, private helper design, or the author's proposed solution.
3. Map every in-scope criterion and targeted regression obligation to at least the configured minimum number of tests. Preserve stable story AC IDs. For an unnumbered Change Contract criterion, derive `CC-AC-001`, `CC-AC-002`, and so on from source array order only for traceability, record the source position, and do not change the contract. Test IDs or names must cite the resulting trace ID in code or adjacent durable metadata. In `engineering-test-evidence`, every passing criterion row must keep the exact trace ID, real executable test path and test name, durable result evidence, and `Pass` on that same row.
4. Include relevant core, failure, boundary, authorization, state, compatibility, and regression paths. Do not manufacture irrelevant tests to reach a count.
5. Freeze and record the authored test intent before revealing the implementation.
6. Write the tests to the repository and execute them against the implementation with the real project runner.
7. Classify each failure before changing code or tests:
   - `implementation bug`: implementation violates the authoritative contract;
   - `test bug`: the test misstates the contract or cannot validly observe it;
   - `spec ambiguity`: authoritative evidence permits materially different expectations.
8. Correct implementation bugs in code. Correct test bugs with a recorded reason that cites the authoritative evidence. Return spec ambiguity to the owning human or upstream role; do not choose an interpretation.
9. Re-run affected tests and required regression checks, preserving the command and result history.

## Human exception contract

Tier C or Limited remains blocked unless the evidence names:

- the human owner granting the exception;
- date or durable review reference;
- exact affected criteria and scope;
- reason A or B was unavailable;
- compensating verification;
- accepted residual risk and expiry or revisit condition.

The Agent may request this exception but cannot approve it. Without all fields, record `waiver: none` and keep the engineering gate blocked.

## Tester E2E feedback boundary

The normal platform E2E path does not ask Software Engineer to integrate Tester-owned scripts into the product repository. A fresh spec-only Test Author writes allowlisted tests/fixtures only in a temporary staging copy of the explicitly configured Linked E2E Workspace. The platform validates and promotes only the allowlisted changes, re-hashes the complete promoted executable baseline, and runs it from the linked root only after a human approves that exact baseline hash.

Software Engineer becomes the owner only when Verification evidence shows that the product itself must change:

1. Receive the stable AC/scenario IDs, frozen behavior, failing script/report/trace hash, and classification. Playwright MCP success is never the expected result.
2. Confirm the requested work is product source, a product-repository test, or a reviewed product testability interface such as an intentional selector. An E2E-only test bug remains in Tester's staging, review, and promotion loop.
3. Use the normal Tier A/B engineering procedure for any new product-repository test. Do not import exploration code, MCP actions/transcript, DOM dumps, or linked test internals as the product specification.
4. Make and verify only the authorized product change; do not edit Tester's staging copy or Linked E2E Workspace, approve or promote its manifest, configure CI, or run/claim Tester's gate on Tester's behalf.
5. Refresh every stale engineering artifact, including `implementation-notes`, `engineering-test-evidence`, `engineering-review`, and `engineering-provenance`, and obtain Implementation reapproval before Tester repeats linked-workspace preflight/script approval/standalone execution.

The platform never infers a sibling or legacy E2E repository. Staged E2E authoring, validated promotion, and promoted-baseline review remain Tester-owned; product changes remain Software Engineer-owned.

For a Web approval, the human review comment must carry these exact, independent lines; artifact text cannot grant the exception:

```text
Verification gate exception: Tier <C or Limited> - <why Tier A/B is unavailable>
Verification exception owner: <non-Agent human owner>
Verification exception reference: <date or durable review reference>
Verification exception scope: <all affected CC-AC IDs and bounded scope>
Verification exception compensating evidence: <durable artifact/path/URL reference>
Verification exception residual risk: <risk explicitly accepted by the human>
Verification exception revisit: <expiry date or revisit condition>
```

## Evidence minimum

The test-evidence artifact records the tier, session/reviewer identity, implementation visibility, frozen test-intent reference, criterion-to-test matrix, changed test paths, exact commands and results, failure classifications, coverage gaps, waiver if any, and final status. “Tests pass” without this evidence is not independent verification. A future Tester-owned validation is preserved as a coverage gap/handoff item; it is not entered as a skipped, failed, unrun, or blocked Implementation command when all Software Engineer-owned checks passed.
