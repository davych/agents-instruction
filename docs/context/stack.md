# Stack reference

## Initializer

- Node.js 20+ ESM package with an interactive CLI in `bin/cli.js`.
- Canonical Markdown role sources live in `templates/agents/`; the CLI renders GitHub Copilot Markdown, Claude Markdown, or Codex TOML.
- Shared workflow, role resources, and artifact templates are copied recursively from `templates/shared/`.

## Platform

- Yarn 4 workspace under `platform/`.
- Web: React 18, TypeScript, Vite, TanStack Query, Tailwind, Radix primitives, Markdown/Mermaid previews.
- API: Fastify, TypeScript, PostgreSQL, Zod, YAML, and a local Codex runner.
- Contracts: `@ai-sdlc/contracts` supplies shared schemas and DTOs.

## Artifact model

- `ai-native.yaml` is the source of role, phase, gate, and artifact registrations.
- The API resolves the global output root plus the artifact owner's optional role subdirectory.
- The browser reviews database revisions whose content is materialized at safe project-relative paths.
- `change-contract` and selected feature evidence use deterministic Run-scoped file names.

Verified against `package.json`, `platform/package.json`, and workspace package manifests on 2026-08-19.
