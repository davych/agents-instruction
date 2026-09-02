# Delivery workflow

Work through these phases in order.

Read `.ai-sdlc/project-profile.md` before starting. It names the active phases, dedicated agents, stack preference, and validation depth for this project.

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
2. Keep the six phases and their owners in this order. Use the named dedicated agent for each active phase.
3. When the profile says `No development`, Implementation, Verification, and Release have no active work. Say so when the workflow reaches them, and do not create filler documents or simulate missing development agents.
4. Start from the artifact index and read only the inputs needed for the current change.
5. Keep each phase as small as the change allows.
6. If a phase needs no new work, say why in the current task. Do not create a filler document.
7. When a document is useful, start from its file in `.ai-sdlc/templates/`.
8. Record facts from real files and commands. Do not invent evidence.
9. Treat the configured stack as a preference. Existing code, project instructions, and accepted ADRs remain authoritative unless a human explicitly approves a change.
10. When information is missing or conflicting, inspect the available sources first. If no human choice is required, state the known gap in the current task or relevant document.
11. When a human decision is required, pause at that point and use the AI tool's structured question UI when available; otherwise ask in the current conversation. Offer two or three mutually exclusive options, put the recommended option first, and explain each option's impact or trade-off in one sentence.
12. Continue dependent work only after the answer. Record the selected decision and its source in the relevant document. Do not defer an unresolved decision to an end-of-document question or checklist.
13. People remain responsible for product scope, material architecture choices, risk acceptance, and release decisions.
14. When you create, update, move, or delete a delivery document other than `docs/ai-sdlc/index.md`, update its row in the index. Use a link relative to the index, such as `./prd.md`, for a local artifact. Use a canonical URL for an artifact owned by another repository. Add one plain-English description, remove stale rows, and list only artifacts that exist.
