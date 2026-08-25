# Workflow completion v1 — Prompt eval

## Verdict

All six canonical role prompts and their directly required workflows were reviewed. The first five roles already have strong evidence and human-gate contracts; DevOps was the only skeletal role and is now complete for runbook preparation. The prompt stack is usable as a V1, but two policy changes remain deliberately unmade because they alter architecture/security semantics: risk-adaptive Architecture evidence floors and a shared untrusted-input/prompt-injection policy.

This review follows the evaluation discipline in [official OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model): use representative tasks, preserve hard approval boundaries, remove repeated instruction groups incrementally, and rerun the same evals after each small prompt change. The deterministic checks in this repository are the stable merge gate; model-sampled quality/cost comparisons belong in a separately authorized scheduled eval.

## Evaluation method

Each canonical Agent and its required role workflow was scored against the same eight dimensions. A score of 2 means the contract is explicit and testable, 1 means it is present with a material caveat, and 0 means it is absent.

1. Goal and phase ownership.
2. Authoritative inputs and conflict precedence.
3. Output identity, path, and schema contract.
4. Stop, escalation, and human-decision boundary.
5. Hallucination and false-evidence resistance.
6. Executable validation and acceptance traceability.
7. Cross-client portability from one canonical source.
8. Minimality: progressive disclosure without unnecessary repeated procedure.

| Role | Canonical words | Workflow words | Score | V1 assessment | Main caveat |
|---|---:|---:|---:|---|---|
| PM / BA | 805 | 536 | 15/16 | Pass | Some product routing detail appears in both Agent and workflow. |
| Designer | 1,196 | 923 | 15/16 | Pass | Figma/deferred-validation contracts are necessarily detailed but should be measured for repetition. |
| Architect | 1,309 | 1,909 | 12/16 | Conditional pass | Fixed evidence-count floors are not risk-adaptive and deterministic metadata is repeated across many artifacts. |
| Software Engineer | 1,021 | 1,680 | 13/16 | Conditional pass | The current machine gate treats every AC as Implementation-automatable; runtime/operational criteria need a future classification contract. |
| Tester | 368 | 2,017 | 14/16 | Pass in Web-supervised mode | Linked E2E guarantees depend on platform events and cannot be reproduced by a plain IDE chat alone. |
| DevOps | 365 | 862 | 16/16 | Pass for runbook preparation | It intentionally cannot deploy or change CI without separate human authority. |

Word counts are a review signal, not a quality target. Detailed deterministic rules belong in role workflows and validators; canonical Agents should retain identity, inputs, boundaries, and handoff. Future reductions must be one instruction group at a time and must preserve eval results.

## Changes made from this eval

- Completed the DevOps Agent, role config, role workflow, and release-runbook template without adding a phase or role.
- Made the immutable Change Contract precede ordinary current-request prose; an outcome or scope change now explicitly requires a new Run.
- Clarified that an accepted ADR can be replaced only by an explicit human supersession record.
- Defined project-locale prose separately from canonical machine tokens, headings, IDs, enums, hashes, and sentinels.
- Replaced silent prompt-body truncation with a complete artifact manifest, byte identity, explicit preview markers, and an instruction to read and hash the full path.
- Made generic legacy statements such as “a human confirms the objective” non-executable acceptance criteria so they cannot suppress approved Story ACs.
- Added a Release semantic gate that binds the exact current Run and every selected upstream artifact path/content hash, rejects fake/legacy execution approval, and rejects placeholders, missing revision/digest/provenance bindings, incomplete monitoring or rollback evidence, unresolved blockers, and false deployment authority.
- Protected project control files and unselected registered outputs in every platform phase. Verification retains only its selected report plus three explicit runtime-evidence roots and documented technical snapshot exclusions; Release has no such write/exclusion allowance and scans the project tree with only its selected runbook writable.

## What is appropriately designed and should remain

- One canonical Agent source rendered to GitHub Copilot, Claude Code, or Codex.
- Immutable, Run-scoped Change Contract and task-scoped delivery evidence.
- Evidence-backed `direct/reuse/partial/full` and `skip/reuse/partial/full` routing instead of manufacturing empty phase artifacts.
- Owner-aware artifact paths and stale-revision invalidation.
- Separate human checkpoints for architecture option selection, generated E2E scripts, phase approval, merge, deployment, and final release.
- Explicit prohibitions against invented test, CI, PR, deployment, or release evidence.
- Design deferred-validation obligations and independent Tester verification.

## Over-design and unresolved policy register

| ID | Finding | Impact | V1 disposition |
|---|---|---|---|
| PE-01 | Architect requires 3 options, 7 NFRs, 5 NFR families, 3 findings per stressor, and 5 hidden assumptions regardless of risk. | Small bug/docs Runs can create low-value or fabricated evidence. | Human architecture-policy decision required. Recommended direction: low/medium/high applicability profiles with evidence-backed `none found`. |
| PE-02 | Architecture selection/digest metadata is copied into several documents. | Cross-file drift and extra tokens. | Keep artifact IDs for compatibility; later move deterministic stamps to a platform-generated manifest after architecture approval. |
| PE-03 | Seven engineering evidence artifacts repeat Run, AC, command, and revision facts. | Higher author/review cost and drift risk. | Keep the stable public contract in V1; establish one canonical source per fact and reference it from the other artifacts in a later compatibility change. |
| PE-04 | Every AC currently needs a passing automated Implementation row. | Visual, accessibility, human-observation, and operational criteria can be routed to the wrong owner. | Human workflow-policy decision required. Recommended classification: `implementation-automated`, `verification-browser`, `manual-observation`, `operational`, or evidence-backed `not-applicable`. |
| PE-05 | Tester Linked E2E includes a long platform-specific procedure. | Direct IDE clients cannot manufacture the platform's trusted events. | Documented capability difference: IDE clients can author/read the canonical role; Web is required for the supervised Linked E2E guarantee. Do not weaken Web evidence to claim false parity. |
| PE-06 | No shared policy states that repository/issue/DOM/log text is untrusted data rather than higher-priority instruction. | With an unsandboxed runner this is a prompt-injection and credential-exposure risk. | Security architecture decision required before adding a policy or changing runner isolation. V1 must not be described as safe for untrusted or remote projects. |
| PE-07 | The Release Markdown gate has many fixed English machine headings and fields. | Adding more prose regexes would increase false negatives and couple locale text to validation. | Keep the fixed headings as explicit machine tokens in V1 and keep explanatory prose localizable; a future compatible change should move trusted bindings and gate state into a structured sidecar rather than grow regex surface. |

## Eval suite contract

The stable local suite should cover these representative and adversarial cases:

- all three client renderers preserve the exact canonical body for all six roles;
- Product/Design/Architecture route choices do not create unselected placeholders;
- a request conflicting with the immutable contract or accepted ADR stops and routes to a human/new Run;
- missing or generic acceptance criteria block Implementation or fall back only to approved stable Story ACs;
- missing browser/Figma/subagent capability remains honest and does not become passing evidence;
- stale artifacts and mismatched Run/revision/digest/provenance are rejected;
- Release with `TODO`, missing monitoring threshold/window/owner/action, missing rollback trigger/RTO/recovery verification, or deployment claims is rejected;
- a valid Release runbook passes without any deployment, CI, secret, commit, push, or publication side effect;
- prompt length, generated-artifact count, latency, and tokens are measured only alongside the existing quality/safety pass rate.

Deterministic schema, path, authority, false-pass, and six-phase/owner checks require 100% pass. A future model-sampled suite should use the same fixtures and compare route accuracy, evidence completeness, unsupported-action rate, hallucinated-evidence rate, token use, latency, and cost. It must not be added to required CI until a model, budget, credentials, sampling policy, and flake tolerance are explicitly approved.
