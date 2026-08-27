# PM / BA workflow

Route the immutable Run Change Contract to the smallest sufficient product evidence. Only `partial` and `full` dispositions run this Agent; neither permits rewriting the Change Contract.

## Steps

1. Read `ai-native.yaml`, `.ai-sdlc/workflows/default.md`, any supplied execution contract or direct-IDE execution brief, and the resolved `change-contract`. Verify that the Change Contract is not writable in this execution.
2. Read `.ai-sdlc/roles/pm-ba/config.yaml`, configured Markdown inputs, and every current or inherited PRD/story revision named by the supplied contract or brief.
3. Read [spec-rules.md](references/spec-rules.md). Identify the user, problem, desired outcome, confirmed scope, business rules, acceptance and regression obligations, evidence, assumptions, and open decisions. Do not fill gaps with invented facts.
4. Follow the recorded Product disposition:
   - `direct`: do not execute this workflow; the recorded human/platform route uses the immutable Change Contract as sufficient product evidence.
   - `reuse`: do not execute this workflow; the recorded human/platform route names the exact approved PRD/story evidence with provenance.
   - `partial`: edit only selected `prd` or `user-stories` outputs. Preserve inherited sections, IDs, ordering, and wording outside the declared impact. Update the PRD story index only when its scope, rule, or story reference actually changes.
   - `full`: create or comprehensively revise the selected PRD and categorized story set because the product domain or model materially changed.
5. For a selected PRD, start from `.ai-sdlc/templates/prd.md` only when no current baseline exists. Otherwise edit the existing document instead of regenerating it.
6. For selected stories, split confirmed scope by business domain and user value. Keep stable IDs, never renumber existing stories, and start new IDs after the highest current `US-<three-digits>` value.
7. Create one `story.md` per new story from `.ai-sdlc/templates/story.md`. Include a core path, at least one relevant failure path, business rules, and observable Gherkin acceptance criteria. Modify only affected existing stories.
8. Keep priority only in the PRD story index. Use a human-confirmed value or `TBD`; do not choose one.
9. Compute every PRD-to-story and story-to-PRD link from the resolved artifact paths. Do not assume the default folder names or depth.
10. Check that the Change Contract's included outcomes and acceptance obligations map to either its direct evidence or the active PRD/story evidence, and that no PM / BA file contains design or technical decisions.
11. Hand unresolved scope, priority, policy, compliance, pricing, and release questions back to the human owner.

Use the owner-aware artifact resolution and direct IDE fallback defined in `.ai-sdlc/workflows/default.md`. PM / BA contributes only its configured output namespace; a platform execution contract supplies any Run-scoped physical path. Do not hardcode `docs`, guess a filename, or write outside the resolved selected output.

The platform resolves `change-contract` to a task-scoped filename for the current Run. It is a human-authored immutable artifact even though its registry owner is `pm-ba`; never write it. Generate no placeholder PRD or story merely to make a static artifact list look complete.

## Completion checks

- The immutable Change Contract remains byte-for-byte unchanged.
- `direct` has an authoritative expected-behavior reference, observable acceptance criteria, and targeted regression obligations.
- `reuse` points to approved evidence that actually covers the current contract.
- `partial` changed only declared outputs and preserves unaffected baseline content and stable IDs.
- `full` is used only when a local delta cannot truthfully express the changed product model.
- Every included outcome is traceable to acceptance evidence; material open decisions name a human owner.
