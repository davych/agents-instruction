# Workflow completion v1 — hot context

## Task contract

Deliver the first credible six-phase AI-native SDLC version: adversarial review and repairs, six-role prompt eval, SDLC standards mapping, GitHub Copilot/Claude Code/Codex plus Web initialization, usable Web review interactions, a complete post-Tester DevOps role, and synchronized documentation/diagrams.

## Invariants

- Phase order stays `discovery → design → architecture → implementation → verification → release`.
- Owners stay `pm-ba`, `designer`, `architect`, `software-engineer`, `tester`, `devops`.
- `templates/agents/` remains the only canonical role source; no client-specific Skill duplicates a role.
- Project-owned initialized content is never wholesale rewritten.
- Scope, architecture/security-risk acceptance, generated-test approval, merge, deployment, and final release remain human-owned.
- Release V1 prepares and semantically validates a runbook; it performs no external release action.

## Acceptance source

- [Workflow completion delta](../../changes/workflow-completion-v1/delta.md)
- Repository [AGENTS.md](../../AGENTS.md)

## Required gates

- Root: `npm test`, `npm pack --dry-run`.
- Platform: `yarn typecheck`, `yarn test`, `yarn build` from `platform/`.
- Focused Tier A tests for path boundaries, abort-safe and crash-recoverable initialization, three clients, release semantics, read-only roles, prompt contracts, and UI interaction contracts.
- Seven-lens plus adversarial re-review after the full diff stabilizes.
