# Software Engineer evidence pack — session log

## Task contract

Implement the Brownfield delta in [`changes/software-engineer-evidence-pack/delta.md`](../../changes/software-engineer-evidence-pack/delta.md): replace the placeholder Software Engineer role with a project-native Agent, role pack, seven Web-reviewable evidence outputs, semantic approval gate, safe runner boundary, legacy compatibility, and an incremental FE-cc backfill.

## Context loaded

- Hot: `AGENTS.md`.
- Warm: `docs/context/stack.md`, `docs/context/testing.md`.
- Cold: `context/cold/gap-log.md`.
- Requirement source: the user-provided Engineering role/workflow course extract.
- Repository precedents: Architect Agent/role pack, global artifact registry, definition loader, task-scoped artifact paths, Codex runner, generic Web artifact review UI, and current tests.
- Target state: `/Users/Davy_Chen/workspace/ai-run/FE-cc` plus its existing Agent, workflow, context, and project files.

## Ordered action log

1. Mapped the Architect integration from canonical Agent through role pack, registry, API, Web, tests, and initializer.
2. Wrote a Brownfield delta, implementation plan, task ledger, and layered project context before implementation.
3. Replaced the Software Engineer placeholder with a concise canonical policy Agent and a procedural role workflow backed by seven focused references.
4. Registered exactly seven Run-scoped engineering outputs and added eight templates; the eighth is the conditional, unregistered replay packet.
5. Extended task path pinning and legacy definition loading without rewriting old `ai-native.yaml` files.
6. Added Web fallback definitions, labels, purpose-specific descriptions, and legacy missing-output selection behavior.
7. Added a semantic approval validator for acceptance traceability, isolation tiers, human waivers, review findings, security closure, and provenance boundaries.
8. Hardened real execution protection across all client Agents, role packs, workflows, evidence templates, control files, environment variants, and permission modes while retaining confirmed-scope source/test writes.
9. Had an implementation-blind Tier A subagent freeze and author tests from the delta and public contracts, then classified every failure before changing implementation or fixtures.
10. Ran a separate seven-lens/code-review pass and closed the reproducible approval, path, runner, and template-contract findings it found.
11. Incrementally backfilled FE-cc rather than reinitializing it, preserving project-owned content and syncing the rendered Software Engineer and Tester Agents.
12. Corrected one pre-existing Figma test stub to emit the current `codex_apps=ready` notification; production Figma behavior and timeout policy were unchanged.

## Rejected alternatives

- A second Software Engineer Skill or duplicate client Agent: rejected because this project has one canonical Agent rendered per selected client.
- A new workflow phase or database migration: rejected because ordinary Markdown artifacts already fit the fixed six-phase model and generic revision UI.
- Global engineering filenames: rejected because concurrent Runs require deterministic task-scoped paths and pinned reruns.
- Treating fake-runner Markdown as verification: rejected because independent-test evidence must describe real isolation and commands.
- Reinitializing FE-cc: rejected because the CLI correctly refuses an existing `ai-native.yaml` and wholesale initialization could overwrite project-owned state.
- Machine-enforcing exact production-code scope without a reviewed path contract: rejected as an unapproved architecture expansion; the remaining limitation is recorded explicitly.

## Verification gates

| Gate | Result | Evidence |
|---|---|---|
| Root initializer | Pass | `npm test` — 3/3 tests |
| Published package contents | Pass | `npm pack --dry-run --cache /private/tmp/my-sdlc-workflow-npm-cache` — 79 files |
| Independent validator suite | Pass | 176/176 tests |
| Runner boundary suite | Pass | 15/15 tests |
| Focused engineering regression | Pass | 238/238 tests |
| Platform typecheck | Pass | `yarn typecheck` |
| Platform full regression | Pass | `yarn test` — 370/370 tests |
| Platform production build | Pass | `yarn build` |
| FE-cc lint | Pass | `npm run lint` |
| FE-cc regression | Pass | `npm test` — 5/5 tests |
| FE-cc production build | Pass | `npm run build` |
| FE-cc definition smoke | Pass | 7 unique Software Engineer paths under `docs/ai-native/engineering/`, with no doubled subdirectory |
| Patch hygiene | Pass | `git diff --check` |

## Outcome

The requested role, workflow, Web integration, approval semantics, runner protections, documentation, tests, and FE-cc Markdown backfill are complete. No PR was published, no merge or release decision was made, and no dependency or schema migration was added.

The known residual limitation is that a failed real Codex execution is not a Git/worktree transaction: protected evidence and control resources are restored, but confirmed-scope source/test edits can remain for human inspection.
