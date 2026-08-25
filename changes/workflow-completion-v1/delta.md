# Workflow completion v1 delta

## Goal

Complete and adversarially validate the first usable version of the canonical AI-native SDLC so the same role sources work through supported IDE-native agents and the Web platform, with a credible post-Tester Release phase, understandable UI, executable quality gates, and current documentation.

## Preserved behaviour

- Keep the fixed six phases in this exact order: Discovery, Design, Architecture, Implementation, Verification, Release.
- Keep the existing owners: PM / BA, Designer, Architect, Software Engineer, Tester, DevOps.
- Keep `templates/agents/` as the only canonical role source and render client-native files through `bin/cli.js`.
- Keep human ownership of scope, architecture acceptance, security-risk acceptance, verification exceptions, merge, deployment, and final release decisions.
- Preserve initialized-project content and apply only in-memory compatibility backfills when a platform capability requires one.

## ADDED

- A complete first-version DevOps procedure and release-runbook contract after Tester.
- Prompt-quality evaluation evidence covering all six canonical prompts, progressive disclosure, boundaries, and cross-client portability.
- Release-specific semantic checks and Web review guidance where implementation evidence shows they are needed.
- Independent acceptance tests and an adversarial re-review for every criterion below.

## MODIFIED

- Role, workflow, platform, UI, CI, and documentation content required to close confirmed audit findings.
- README files and workflow diagrams whose current descriptions no longer match the executable workflow.

## REMOVED

None.

## REMOVED audit

Before handoff, compare the six phase IDs, phase owners, canonical Agent IDs, registered artifact IDs, and tracked-file deletion status. No phase, owner, Agent, artifact, project-owned initialized content, or unrelated tracked file may be removed.

## Non-functional requirements

- Use the repository's existing Node test runner, TypeScript, Zod, React, Fastify, YAML, and workspace helpers; add no framework or runtime dependency.
- Fail closed on missing or placeholder gate evidence without claiming deployment, CI, security, or release authority.
- Keep role identity concise and put detailed procedures in ordinary Markdown role packs to avoid duplicated or overlong client-native prompts.
- Keep local and Web artifact path resolution owner-aware, deterministic, safe, and backward compatible.

## Human-owned decisions and exclusions

- This delta does not authorize a seventh phase, an owner change, production deployment, secret access, DDL, PR publication, merge, npm publication, branch-protection changes, or risk acceptance.
- Security-sensitive or release-policy changes discovered by the audit are documented for a human decision unless they are limited to non-authoritative validation, documentation, or fail-closed safeguards already implied by the current model.

## Acceptance criteria

- **AC-WF-001 — Adversarial functional review:** Every initializer, role handoff, platform phase, and material UI path is reviewed across correctness, security, error handling, edge cases, performance, maintainability, spec drift, and an adversarial pass. Confirmed in-scope defects are fixed and the affected area is reviewed again.
- **AC-WF-002 — AI prompt evaluation:** All six canonical prompts and their directly loaded role procedures are evaluated for clear goals, authoritative inputs, output contracts, stop/escalation rules, hallucination resistance, testability, cross-client portability, redundancy, and over-design. Findings and deliberate non-changes are recorded; canonical roles are not duplicated as client-specific Skills.
- **AC-WF-003 — Standard SDLC coverage:** The six-phase workflow is mapped to current authoritative secure-delivery guidance. Missing planning, security, supply-chain, operations, rollback, incident, feedback, or retirement obligations are either incorporated into the existing owners/phases without changing their order or explicitly recorded as human-owned gaps.
- **AC-WF-004 — IDE and Web parity:** Fresh initialization for GitHub Copilot, Claude Code, and Codex installs all six roles plus every required role procedure from one canonical source, and the Web definition/runner can resolve and execute the same role contract without client-specific path assumptions. Legacy definitions remain loadable without rewriting project-owned YAML.
- **AC-WF-005 — UI interaction quality:** The Web UI exposes clear actions, loading/error/empty/blocked states, accurate terminal-phase wording, keyboard-accessible controls, and phase-specific execution/review guidance. Release preparation is never worded as an already executed or approved deployment.
- **AC-WF-006 — First post-Tester role:** DevOps has a complete first-version prompt, role workflow, and release-runbook template covering verified inputs, preconditions, build/CI provenance, deployment sequence, observability, rollback, incident/escalation, evidence status, risks, and the final human go/no-go boundary.
- **AC-WF-007 — Documentation and diagrams:** Root, platform, getting-started, configuration, workflow, and role documentation consistently describe the implemented first version, its IDE/Web paths, gates, feedback loops, limitations, and exact local verification commands; Mermaid diagrams preserve the six-phase model and renderable syntax.

