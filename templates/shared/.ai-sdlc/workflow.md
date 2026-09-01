# Delivery workflow

Work through these phases in order.

| Phase | Owner | Main output |
|---|---|---|
| Discovery | PM / BA | `docs/ai-sdlc/prd.md` |
| Design | Designer | `docs/ai-sdlc/design-spec.md` |
| Architecture | Architect | `docs/ai-sdlc/architecture.md` |
| Implementation | Software Engineer | Working code, tests, and `docs/ai-sdlc/implementation-notes.md` |
| Verification | Tester | `docs/ai-sdlc/test-report.md` |
| Release | DevOps | `docs/ai-sdlc/release-runbook.md` |

## Rules

1. Start with the user's goal and the current project.
2. For each phase, use the role agent named in the table.
3. Read only the inputs needed for the current change.
4. Keep each phase as small as the change allows.
5. If a phase needs no new work, say why in the current task. Do not create a filler document.
6. When a document is useful, start from its file in `.ai-sdlc/templates/`.
7. Record facts from real files and commands. Do not invent evidence.
8. Send missing or conflicting information back to the role that owns it.
9. A human owns product scope, major architecture choices, material risk, and the final release decision.

The workflow guides work. It does not run tools, approve gates, merge code, or release software.
