# Project Profile

This file is a human-readable snapshot of choices made during initialization. It guides local role discovery and cross-repository handoffs, but it does not authorize dependency installation, application scaffolding, framework migration, external repository changes, or replacement of existing project conventions.

The authoritative repository identity and delivery mode are the `repositoryId` and `deliveryMode` fields in `.ai-sdlc/installation.json`. Editing the snapshot below changes neither value.

## Configuration

| Setting | Choice |
|---|---|
| Repository ID | {{REPOSITORY_ID}} |
| Local role agents | {{LOCAL_ROLE_AGENTS}} |
| Active local phases | {{ACTIVE_LOCAL_PHASES}} |
| Delivery mode | {{DELIVERY_MODE}} |
| Generated developer agents | {{GENERATED_DEVELOPER_AGENTS}} |
| Engineering areas | {{ENGINEERING_AREAS}} |
| Engineer agent mode | {{ENGINEER_AGENT_MODE}} |
| Architecture source | {{ARCHITECTURE_SOURCE}} |
| Technology catalog | `/docs/ai-sdlc/technology-profile.md` through the configured Architecture route when available |
| Artifact host registry | `.ai-sdlc/artifact-hosts.json` |
| Artifact bridge skill | `.agents/skills/sdlc-artifact-bridge/SKILL.md` |

## Role and artifact coverage

Each route is independent. `Local` means the dedicated agent was initialized in this repository. `Unconfigured` means no local agent was selected and an external artifact host can be added later without changing the other routes.

| Phase | Role | Local agent | Artifact route |
|---|---|---|---|
{{ROLE_COVERAGE_ROWS}}

The machine-readable route source is `.ai-sdlc/artifact-hosts.json`. Use the bridge skill to resolve a route. A configured external Architecture source is read-only. Do not treat an unconfigured earlier phase as a reason to initialize that role automatically or to block a later phase when the user and available evidence provide enough context.

## Technology and validation guidance

Initialization may choose an engineering area so the correct developer identity is generated, but it does not choose a stack or validation depth. When application architecture work first needs technology guidance, the Architect follows `.ai-sdlc/technology-planning.md`, creates the catalog at `docs/ai-sdlc/technology-profile.md`, and creates only the applicable child profiles under `docs/ai-sdlc/technology/frontend/` or `docs/ai-sdlc/technology/backend/`.

Developer agents read the authoritative `repositoryId` from `.ai-sdlc/installation.json` and match candidate catalog rows by that exact value plus their engineering area. If the snapshot row above differs, they report it as stale and do not use it for matching. They select the affected deployable or Scope ID set from the request and code paths, ask if that set remains ambiguous, and then read only those child profiles through the Architecture route. Only `Required` and `Accepted` entries instruct implementation. `Observed`, `Proposed`, `Excluded`, and `Unknown` do not authorize a technology change.

Use commands confirmed by project files, wrappers, CI, accepted ADRs, or project instructions. Do not invent a command or claim that a check passed. Technology planning is guidance; it does not install dependencies or scaffold an application.

## Detected evidence

This is an initialization snapshot. If current project files conflict with it, use the current evidence and point out that this profile is stale.

| Path | Detected signal | Used for |
|---|---|---|
{{DETECTED_EVIDENCE_ROWS}}
