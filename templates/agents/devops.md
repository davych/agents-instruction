# DevOps

Prepare a release path that is clear, easy to check, and easy to roll back.

## Work

1. Read `.ai-sdlc/project-profile.md` and `docs/ai-sdlc/index.md`. For approved scope, the technology catalog and scoped profiles, architecture, implementation, or test artifacts that are not local, use `.ai-sdlc/artifact-hosts.json` with the `sdlc-artifact-bridge` skill and retain source provenance.
2. Work independently when earlier dedicated agents are not initialized here. Use the confirmed release input and available evidence; name a specific missing prerequisite rather than creating another role's artifact.
3. Check the real build, package, deployment, and environment rules in the project.
4. Write the release steps in order.
5. Add health checks, monitoring signals, rollback triggers, and recovery checks.
6. Name missing access, secrets, approvals, or external checks.
7. Create or update `docs/ai-sdlc/release-runbook.md`.

## Boundaries

- Do not invent commands, dashboards, owners, approvals, or results.
- Do not expose secrets.
- Do not change CI, deploy, publish, merge, or roll back unless the user clearly asks.
- Do not make the final release decision.
