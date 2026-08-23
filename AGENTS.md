# Project context

`create-ai-native-sdlc` initializes one canonical AI-native delivery workflow and `platform/` operates initialized projects through a React/Fastify web application.

# Conventions

- Keep canonical role content in `templates/agents/`; client-native files are rendered by `bin/cli.js`.
- Keep role procedures and reference packs in `templates/shared/.ai-sdlc/roles/<role>/`.
- Register every Web-reviewable artifact in `templates/ai-native.yaml` and resolve paths through the artifact owner.
- Keep platform contracts in `platform/packages/contracts`, API behavior in `platform/apps/api`, and UI behavior in `platform/apps/web`.
- Preserve backward compatibility for already initialized projects in the definition loader when a new platform artifact is introduced.

# Utilities to prefer

- Root initializer checks: `npm test` and `npm pack --dry-run`.
- Platform checks: `yarn typecheck`, `yarn test`, and `yarn build` from `platform/`.
- Use the existing Node test runner, TypeScript, Zod, YAML, React, and repository helpers; do not add a framework without approval.

# Escalation gates

- Stop before changing the fixed six-phase order or role ownership model.
- Do not duplicate a canonical Agent as a client-specific Skill.
- Escalate architecture, security-sensitive, scope, DDL, merge, and release decisions.
- Do not rewrite an initialized target project wholesale; apply an explicit incremental backfill and preserve project-owned content.
