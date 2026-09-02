# Delivery workflow

The six phases below provide a stable order and ownership vocabulary. A repository can initialize any subset of the dedicated role agents. The subset may be sparse: a later role does not require every earlier role to be local.

Read `.ai-sdlc/project-profile.md` before starting. It names the local agents and their phase coverage.

Use `docs/ai-sdlc/index.md` as the entry point for artifacts owned by this repository. When a needed artifact is not local, use `.ai-sdlc/artifact-hosts.json` with the `sdlc-artifact-bridge` skill. The registry may route each phase to this repository, another filesystem repository, or a canonical URL.

| Phase | Owner | Outputs when useful |
|---|---|---|
| Discovery | PM / BA | `docs/ai-sdlc/prd.md` and files under `docs/ai-sdlc/stories/` |
| Design | Designer | `docs/ai-sdlc/design-baseline.md` and `docs/ai-sdlc/design-spec.md` |
| Architecture | Architect | `docs/ai-sdlc/technology-profile.md`, `docs/ai-sdlc/architecture.md`, and relevant Architecture Pack files |
| Implementation | Software Engineer | Working code, tests, and optional plan, tasks, and notes |
| Verification | Tester | `docs/ai-sdlc/test-report.md` |
| Release | DevOps | `docs/ai-sdlc/release-runbook.md` |

## Resolve inputs

For each input needed by the current phase:

1. Read the request and the current repository's instructions and evidence.
2. Check `docs/ai-sdlc/index.md` for a local artifact.
3. If it is absent, invoke the `sdlc-artifact-bridge` skill with the phase or host route and artifact path. Read the source artifact rather than creating a local copy.
4. Record the source repository, path or URL, and revision when that information is available.
5. If a route host is null or inaccessible, ask the user for the host, path, or access only when the missing input is required for the requested work.

## Rules

1. Start with the user's goal and the current project.
2. Keep the six phase names and owners in the documented order when describing a complete delivery lifecycle. Run only the phases needed for the current request.
3. Use a dedicated local role agent when it was initialized and applies to the work. A role not initialized here may be performed elsewhere or may be unnecessary.
4. Do not initialize, simulate, or create filler work for a missing role. Do not block a selected later role merely because an earlier role is not local.
5. Continue from the request and available evidence when they are sufficient. If a required decision or source is missing, ask for that specific input and state which work depends on it.
6. Keep each phase as small as the change allows. If a phase needs no new work, say why in the current task instead of creating a filler document.
7. When a document is useful, start from its file in `.ai-sdlc/templates/`.
8. Record facts from real files, artifact hosts, and commands. Do not invent evidence or silently replace a missing upstream artifact.
9. Treat an existing technology profile, project instructions, current code, and accepted ADRs as authoritative evidence. A proposed profile is not an accepted decision.
10. When information is missing or conflicting, inspect all configured sources that are available before asking the user.
11. When a human decision is required, pause at that point and use the AI tool's structured question UI when available; otherwise ask in the current conversation. Offer two or three mutually exclusive options, put the recommended option first, and explain each option's impact or trade-off in one sentence.
12. Continue dependent work only after the answer. Record the selected decision and its source in the relevant document. Do not defer an unresolved decision to an end-of-document question or checklist.
13. People remain responsible for product scope, material architecture choices, risk acceptance, and release decisions.
14. When you create, update, move, or delete a delivery document other than `docs/ai-sdlc/index.md`, update its row in the local index. Use a link relative to the index, such as `./prd.md`. Keep external artifacts in the host registry and cite their canonical source in the consuming document. Add one plain-English description, remove stale rows, and list only artifacts that exist.
15. The artifact bridge is read-only context resolution. Do not synchronize, copy, or modify another repository unless the user separately requests that work.
