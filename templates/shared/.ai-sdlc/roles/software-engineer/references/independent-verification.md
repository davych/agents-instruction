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

## Procedure

1. Give the independent author only the immutable Change Contract, applicable acceptance and regression evidence, approved observable Design behaviour, relevant public Architecture constraints, and the project's test interface or commands needed to create runnable tests.
2. Do not provide the implementation diff, implementation-session transcript, private helper design, or the author's proposed solution.
3. Map every in-scope criterion and targeted regression obligation to at least the configured minimum number of tests. Preserve stable story AC IDs. For an unnumbered Change Contract criterion, derive `CC-AC-001`, `CC-AC-002`, and so on from source array order only for traceability, record the source position, and do not change the contract. Test IDs or names must cite the resulting trace ID in code or adjacent durable metadata.
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

## Tester-returned E2E crystallization

When Tester exploration identifies a missing or invalid durable E2E script, treat the return as a test-only engineering change, not as permission for the Verification phase to mutate repository source after approval.

In a platform-managed Run, the current Verification review may use the exact envelope `E2E crystallization request: <nonempty scenario>` on line 1, one `AC: <current Change Contract ID>` line per mapped criterion, and one `Frozen intent: <observable behavior>` line. The platform passes only those validated bounded fields plus reviewed `test-report` head metadata into this rerun as read-only revision feedback; it does not pass the report body or free-form comment. It is diagnostic context, never a new authoritative input or permission to change scope.

1. Receive stable AC/scenario IDs, frozen behavior intent, and the stated E2E gap. Do not use Playwright MCP success as the expected result.
2. Start a Tier A/B authoring context before exposing the implementation or exploration transcript. The author may receive the authoritative behavior contract and minimum public test harness; it must not receive exploration code, the MCP action transcript, copied DOM dumps, the implementation diff, or the implementation-session transcript.
3. Freeze the test intent, then allow public interface/harness inspection only to adapt the test so it runs. Adaptation cannot weaken the expected behavior.
4. Integrate the repository-conventional test path, run focused and required regression checks, and classify failures using the normal procedure.
5. Refresh every stale engineering artifact, including `implementation-notes`, `engineering-test-evidence`, `engineering-review`, and `engineering-provenance`, and obtain Implementation reapproval before Tester resumes standalone execution.

A candidate `tests/e2e/*.spec.ts` patch outside the refreshed evidence chain is not a CI-ready asset.

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

The test-evidence artifact records the tier, session/reviewer identity, implementation visibility, frozen test-intent reference, criterion-to-test matrix, changed test paths, exact commands and results, failure classifications, coverage gaps, waiver if any, and final status. “Tests pass” without this evidence is not independent verification.
