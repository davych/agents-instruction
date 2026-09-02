# Project Profile

This file records choices made during initialization. It guides local role discovery and cross-repository handoffs, but it does not authorize dependency installation, application scaffolding, framework migration, external repository changes, or replacement of existing project conventions.

## Configuration

| Setting | Choice |
|---|---|
| Local role agents | {{LOCAL_ROLE_AGENTS}} |
| Active local phases | {{ACTIVE_LOCAL_PHASES}} |
| Technology profile | `docs/ai-sdlc/technology-profile.md` when first created by the Architect |
| Artifact host registry | `.ai-sdlc/artifact-hosts.json` |
| Artifact bridge skill | `.agents/skills/sdlc-artifact-bridge/SKILL.md` |

## Role and artifact coverage

Each route is independent. `Local` means the dedicated agent was initialized in this repository. `Unconfigured` means no local agent was selected and an external artifact host can be added later without changing the other routes.

| Phase | Role | Local agent | Artifact route |
|---|---|---|---|
{{ROLE_COVERAGE_ROWS}}

The machine-readable route source is `.ai-sdlc/artifact-hosts.json`. Use the bridge skill to resolve a route. Do not treat an unconfigured earlier phase as a reason to initialize that role automatically or to block a later phase when the user and available evidence provide enough context.

## Technology and validation guidance

Initialization does not choose a stack or validation depth. When the Architect first works and no technology profile can be found locally or through the artifact routes, follow `.ai-sdlc/technology-planning.md`, ask only for material choices that cannot be established from evidence, and create `docs/ai-sdlc/technology-profile.md`.

Use commands confirmed by project files, wrappers, CI, accepted ADRs, or project instructions. Do not invent a command or claim that a check passed. Technology planning is guidance; it does not install dependencies or scaffold an application.

## Detected evidence

This is an initialization snapshot. If current project files conflict with it, use the current evidence and point out that this profile is stale.

| Path | Detected signal | Used for |
|---|---|---|
{{DETECTED_EVIDENCE_ROWS}}
