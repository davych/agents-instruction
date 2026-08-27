# Engineering provenance

Provenance lets a reviewer reconstruct what was requested, what evidence was trusted, what changed, how it was verified, and which decisions remained human-owned. It is a compact index, not a replacement for the linked artifacts or repository diff.

## Required fields

- **Tool/model:** actual implementation and independent-review tools/models, or `Unknown` with a reason.
- **Context loaded:** exact project instructions, configured Markdown, upstream artifact revisions, and repository evidence used.
- **Verification gates:** Implementation-owned project checks, independent-test status and isolation tier, seven-lens verdict, and unresolved Implementation blockers. Put downstream Tester-owned deferred validation in limitations/handoff instead of marking the Implementation gate failed or blocked.
- **Human decisions:** approval, waiver, override, or decision evidence with owner and durable reference; use `None` when there was none.
- **Known limitations:** untested scope, unavailable environment, uncertainty, and residual risk.
- **Session timing:** start, end, or duration when the platform provides it; never invent timestamps.
- **SDD approach:** `greenfield`, `brownfield`, or `hybrid`, with the preserved-behaviour or boundary reference.
- **Publication boundary:** state that Software Engineer generated future-use traceability but did not create, open, or publish a PR, merge, deploy, or approve release.

## Evidence links

Link the current Run and exact revisions of:

- immutable Change Contract and active Product, Design, and Architecture clearances;
- implementation plan and separately registered implementation tasks;
- implementation notes/index and repository diff or commit when one exists;
- engineering session log;
- independent test evidence and real test paths;
- seven-lens/adversarial review;
- human exception or decision records.

Resolve paths through the registry. Do not hardcode `docs`, link an ambiguous “latest” revision, or point to an artifact from another Run without explicit imported provenance.

## Accuracy rules

- Use `Not run`, `Not available`, `Unknown`, or `Blocked` instead of implying evidence exists.
- Separate facts, measured results, assumptions, recommendations, and human decisions.
- Never word a Software Engineer recommendation as its approval of scope, architecture, a security/risk exception, PR publication, merge, deployment, or release; those decisions remain human-owned.
- Never include secrets, credentials, production data, private prompt content, or raw logs that violate the sensitivity classification.
- A link is evidence only when its target exists, is non-empty, belongs to the current Run or has valid imported provenance, and actually supports the claim.
- Every changed criterion and targeted regression obligation must be traceable through plan, task, implementation, test, and review evidence.

## PR boundary

The provenance document is only traceability that may be copied into a future PR body. Producing it does not create or open a PR. Software Engineer does not create, open, publish, approve, merge, or close a PR under this workflow. If an outer platform or human later performs one of those actions, that actor owns and records the resulting external provenance separately.
