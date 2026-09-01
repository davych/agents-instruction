# Delivery workflow

Work through these phases in order.

Use `docs/ai-sdlc/index.md` as the stable entry point for delivery documents.

| Phase | Owner | Outputs when useful |
|---|---|---|
| Discovery | PM / BA | `docs/ai-sdlc/prd.md` and files under `docs/ai-sdlc/stories/` |
| Design | Designer | `docs/ai-sdlc/design-baseline.md` and `docs/ai-sdlc/design-spec.md` |
| Architecture | Architect | `docs/ai-sdlc/architecture.md` and the relevant Architecture Pack files |
| Implementation | Software Engineer | Working code, tests, and optional plan, tasks, and notes |
| Verification | Tester | `docs/ai-sdlc/test-report.md` |
| Release | DevOps | `docs/ai-sdlc/release-runbook.md` |

## Rules

1. Start with the user's goal and the current project.
2. For each phase, use the role agent named in the table.
3. Start from the artifact index and read only the inputs needed for the current change.
4. Keep each phase as small as the change allows.
5. If a phase needs no new work, say why in the current task. Do not create a filler document.
6. When a document is useful, start from its file in `.ai-sdlc/templates/`.
7. Record facts from real files and commands. Do not invent evidence.
8. Record missing or conflicting information in the relevant document or current task.
9. People remain responsible for product scope, material architecture choices, risk acceptance, and release decisions.
10. When you create, update, move, or delete a delivery document other than `docs/ai-sdlc/index.md`, update its row in the index. Use a link relative to the index, such as `./prd.md`, for a local artifact. Use a canonical URL for an artifact owned by another repository. Add one plain-English description, remove stale rows, and list only artifacts that exist.
