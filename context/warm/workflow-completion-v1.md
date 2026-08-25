# Workflow completion v1 — warm context

## Executable architecture map

| Concern | Canonical location | Runtime consumer |
|---|---|---|
| Role identity/boundary | `templates/agents/*.md` | CLI renders the selected native Agent set; Web runner resolves that installed file. |
| Role procedure/reference | `templates/shared/.ai-sdlc/roles/<role>/` | Native Agent reads ordinary project Markdown. |
| Phase/artifact graph | `templates/ai-native.yaml` | Initialized project plus API definition loader. |
| Path and compatibility | `platform/apps/api/src/services/definition-loader.ts` | API registration, Run creation, execution, review. |
| Run-scoped paths | `platform/apps/api/src/domain/task-artifact-paths.ts` | Change Contract, Design, engineering, Test Report, Release runbook. |
| Execution boundary | `platform/apps/api/src/services/codex-runner.ts` and workspace guards | Selected outputs, control resources, read-only Verification/Release workspaces. |
| Semantic phase gates | API validators + `workflow-service.ts` | Implementation, Verification, and DevOps V1 Release approval. |
| Shared API input | `platform/packages/contracts` | API and Web project creation. |
| UI | `platform/apps/web` | Client selection, phase execution/review, artifact inspection. |

## Compatibility rule

New platform capabilities may be projected into an old definition in memory, but a semantic gate that requires a new role pack/template must be capability-gated. The loader never rewrites `ai-native.yaml`; an explicit future updater needs its own architecture and checksum policy.

## Channel contract

- Direct IDE use and Web use share the six canonical roles, artifact IDs, path rules, and human boundaries.
- Direct IDE use does not receive platform DB events, frozen revisions, or the supervised Linked E2E lifecycle automatically.
- Web execution is performed by the Codex runner even when the initialized native role files target GitHub Copilot or Claude Code; this is execution-engine compatibility, not a claim that the three clients provide identical runtime guarantees.

