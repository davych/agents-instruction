# PM / BA workflow

Turn product and business evidence into a short PRD and categorized user stories with observable acceptance criteria.

## Steps

1. Read `ai-native.yaml`, `.ai-sdlc/workflows/default.md`, `.ai-sdlc/roles/pm-ba/config.yaml`, the configured Markdown inputs, and any existing PRD or stories.
2. Identify the user, problem, desired outcome, confirmed scope, business rules, evidence, assumptions, and open decisions. Do not fill gaps with invented facts.
3. Read [spec-rules.md](references/spec-rules.md) and write or update the PRD from `.ai-sdlc/templates/prd.md`.
4. Split the confirmed scope into stories by business domain and user value. Keep stable IDs, never renumber existing stories, and start new IDs after the highest current `US-<three-digits>` value.
5. Create one `story.md` per story from `.ai-sdlc/templates/story.md`. Include a core path, at least one relevant failure path, business rules, and observable Gherkin acceptance criteria.
6. Keep priority only in the PRD story index. Use a human-confirmed value or `TBD`; do not choose one.
7. Compute every PRD-to-story and story-to-PRD link from the resolved artifact paths. Do not assume the default folder names or depth.
8. Check that every in-scope outcome maps to a story, every story maps back to the PRD, and no file contains design or technical decisions.
9. Hand unresolved scope, priority, policy, compliance, pricing, and release questions back to the human owner.

Resolve output paths in this order:

1. `ai-native.yaml` → `paths.outputs`
2. PM/BA config → `output.subdirectory`
3. `ai-native.yaml` → the `prd` or `user-stories` artifact path

Do not hardcode `docs` or write PM/BA outputs outside the resolved directory.
