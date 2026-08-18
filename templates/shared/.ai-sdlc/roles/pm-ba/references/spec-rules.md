# PM/BA specification rules

## Inputs

- Require the current Run's immutable `change-contract`. The platform-managed path is task-scoped; do not edit it.
- Treat the contract's requested outcome, included boundary, acceptance criteria, regression obligations, and evidence references as the routing unit.
- Treat business rules and constraints as facts only when a source confirms them.
- Use interview notes as evidence, not as automatic product decisions.
- If the basic problem, target user, or desired outcome is missing, ask one short question before writing the specification.

## Product Impact disposition

- `direct` is valid for a bug, technical change, or tightly bounded request only when the Change Contract plus an authoritative behavior source is sufficient to implement and verify the outcome. It creates no placeholder PRD or story.
- `reuse` is valid only when approved PRD/story revisions already cover every relevant contract outcome and acceptance criterion without reinterpretation.
- `partial` preserves the approved product baseline and changes only affected PRD sections, stories, rules, and acceptance criteria.
- `full` is required for a new product domain or a material change to target users, outcomes, scope, policy, pricing model, or cross-story business rules.
- `unknown` evidence is not `direct` or `reuse`. Return to Product Impact instead of guessing.

## PRD

- Keep the PRD short enough to scan in one sitting.
- State the problem, target users, goals, confirmed scope, business rules, story index, assumptions, and open questions.
- Keep `Out of scope` explicit. If no exclusion is confirmed, write: `No exclusions are confirmed yet; scope is limited to the In scope list.`
- Do not invent a success target. Write `TBD — human decision` when a measure or threshold is missing.
- Treat the PRD story index as the only source for priority. Use only a human-confirmed priority or `TBD`.
- Treat the PRD as a durable baseline, not a Run log. A partial update must not rewrite unaffected prose merely for consistency or style.

## Story split

- Group stories by a simple business-domain name such as `onboarding`, `billing`, or `settings`.
- Use `US-<three-digits>-<kebab-case-title>` for the story directory.
- Preserve existing IDs. Do not reuse or renumber them.
- Split by a user or business outcome, never by an implementation area.
- Apply INVEST: keep a story independent where practical, open to discussion, valuable, understandable in size, focused, and testable.
- Keep one story when several steps are required for one indivisible user outcome. Split it when each part gives useful value on its own.

## Acceptance criteria

- Write Gherkin scenarios with clear `Given`, `When`, and `Then` statements.
- Give each scenario a stable ID in the form `<US-ID>-AC-<two-digits>`, such as `US-001-AC-01`.
- Include at least one core-path scenario and one relevant failure-path scenario.
- Add a boundary scenario only when the source describes a real boundary.
- Make every result observable to a user or business owner.
- Keep every scenario at the user or business behavior level. Do not describe how it will be built.
- Do not invent generic error states. Use only failures supported by the business flow or input evidence.

## Completion check

- The Change Contract remains unchanged and its acceptance and regression obligations are traceable to the selected product evidence.
- Every in-scope PRD item maps to at least one story.
- Every story appears once in the PRD index and links to its `story.md`.
- Every acceptance-criteria ID is unique across the story set.
- Each story identifies its source, business rules, assumptions, and open questions.
- No story chooses scope, priority, policy, pricing, compliance, or release readiness.
- No PM/BA output contains visual design or technical decisions.
- A bug fast path still names the expected behavior source, observable fix criteria, reproduction evidence when available, and targeted regression scope.
