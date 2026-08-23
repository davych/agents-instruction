# Software Engineer workflow clarity — seven-lens review

## Verdict

Ready for human review. No unresolved implementation blocker was found in the delivered platform change; the real FE-cc feature remains separately and correctly blocked, but its missing Product answers, Designer work, and Architecture decisions are now visible and actionable in the Web flow.

## Behaviour preservation

Finding: none found. The six phases, seven artifact IDs, owner model, human approval boundary, and semantic engineering evidence gate remain unchanged. The new decision layer derives presentation and approval policy from existing artifacts and reviews without adding a phase, artifact, or database table.

## Hidden assumptions

Finding: none found. The fallback explicitly requires an approved, selected `user-stories` snapshot and stable `US-...-AC-...` headings; it does not infer authority from titles or objectives. A captured answer is intentionally not treated as resolved until the owning role removes the blocker from the formal artifact.

## Spec/architecture drift

Finding: none found. This change improves presentation, legacy lookup, execution readiness, review ordering, and decision routing without changing phase order, role ownership, artifact ownership, architecture approval, or security authority.

## Confirmation without evidence

Finding: none found. The real-target claim was verified against platform DB selection state, selected document contents, the target Git diff, 11 concrete AC strings, and direct decision extraction. The probe produced 5 Product decisions, 1 Designer task, 4 Design dependencies, 2 Architecture decisions, and 4 Architecture dependencies; all automated checks and counts are recorded.

## Test independence

- Finding ID: CLARITY-REV-001
- Severity: low
- Evidence: `changes/software-engineer-workflow-clarity/test-evidence.md`
- Impact: same-session authoring is weaker than independent Tier A/B test design.
- Action / owner: human reviewer should inspect the focused cases and UI wording; Owner: human maintainer.
- Status / resolution evidence: disclosed as Tier Limited with full regression and real-target probe; no independence waiver is claimed.

## Security surface

Finding: none found. Product, Design, Architecture, and User Story content is parsed as text and never executed. Decision capture validates IDs, head revisions, per-answer length, uniqueness, and a 7,000-character aggregate bound. The machine block uses base64url to prevent Markdown fences or marker-like answer text from corrupting the audit record, while legacy fenced records remain readable.

## Over-engineering

Finding: none found. The pure API resolver, readiness/decision domains, and Web presentation module keep policy testable; existing append-only reviews carry decision capture, so no dependency, schema, phase, or artifact was added.

## Adversarial pass

### Pre-mortem

- Finding ID: CLARITY-ADV-001
- Severity: medium
- Failure / trigger: a legacy Run has approved phase rows but its selected PRD, Design, or Architecture documents still say Blocked, contain unchecked decisions, or are not ready.
- Evidence: the current FE-cc Run exhibits this exact state.
- Impact: the old flow displayed “writing code”, produced no feature code, and generated another seven-document Blocked pack.
- Action / owner: expose the decision inbox, exclude inconsistent approvals from clean progress, enforce semantic approval/readiness before downstream execution, and route each issue to PM/BA, Designer, or Architect; upstream humans still own true decisions.
- Status / resolution evidence: resolved in the platform by decision/API/Web gates and 389/389 full tests; the target decisions remain intentionally open until a human answers and each role updates its formal artifact.

### Edge-case-hunter

- Finding ID: CLARITY-ADV-002
- Severity: medium
- Condition / expected behaviour: captured human text may contain Markdown fences, HTML-comment-like markers, or enough content to stress the review prompt; it must remain bounded and round-trip without turning an audit record into malformed evidence.
- Evidence: `human-decisions.check.ts` fence/marker round-trip, legacy parser case, and `contracts.check.ts` aggregate bound.
- Impact: prevents a valid decision from silently disappearing and prevents oversized decision feedback from overwhelming the existing review channel.
- Action / owner: preserve the encoded v1 block, legacy fallback, aggregate bound, and optimistic artifact-head lock; Owner: Platform maintainers.
- Status / resolution evidence: resolved by focused decision tests and the final 389/389 platform suite.

## Human boundary

This review does not answer or approve the FE-cc Product/Design/Architecture decisions, fabricate implementation completion, publish a PR, merge, deploy, or authorize release.
