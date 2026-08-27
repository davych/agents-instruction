# Software Engineer Role Guide

This is the human-facing overview for the Implementation phase. The executable procedure and focused engineering rules remain in the canonical sources linked below.

## Purpose and non-goals

Software Engineer turns the current Run's confirmed product, design, and architecture contracts into the smallest complete working change and one reviewable engineering evidence pack.

Software Engineer owns product source/configuration changes, repository-conventional tests, implementation planning, independent-test evidence, engineering review, and provenance. It does not redefine acceptance criteria, make product/design/architecture decisions, approve verification exceptions or risk, publish or merge a pull request, deploy, or replace Tester.

Markdown explains the work. It never substitutes for a real source diff or passing checks.

## When it runs

Implementation starts only after Product, Design, and Architecture have current-Run clearances. Evidence-backed `direct`, `skip`, and `reuse` clearances are valid inputs and do not require placeholder artifacts.

Reopen the owning upstream impact check when implementation reveals an omitted product, visible-experience, architecture, security, data, NFR, deployment, or operational impact.

Tester returns work to Software Engineer only when resolution requires product source, product-repository tests, or a product testability interface. A linked E2E script defect stays in Tester's staging-author and complete-baseline-review loop.

## Inputs and outputs

Authoritative inputs are resolved through `ai-native.yaml`, the artifact owner's config, and either the supplied platform execution contract or the bounded direct-IDE execution brief:

- immutable `change-contract`;
- Product clearance and applicable PRD/story evidence;
- Design clearance and applicable baseline/spec;
- accepted `architecture` index and active C4, ADR, pattern, and NFR evidence;
- verified repository behavior, tests, dependency metadata, runtime configuration, and project instructions.

The phase produces a real source/test change plus seven registered evidence artifacts:

| Artifact | Human purpose |
|---|---|
| `implementation-notes` | Status, actual change, limitations, risks, and index to the pack |
| `implementation-plan` | Scope, preserved behavior, strategy, risks, and exit criteria |
| `implementation-tasks` | Atomic work status, repository targets, dependencies, and criterion mapping |
| `engineering-session-log` | Context read, ordered actions, decisions, failures, and actual commands |
| `engineering-test-evidence` | Isolation tier, frozen intent, AC/test coverage, commands, failures, and results |
| `engineering-review` | Seven lenses plus pre-mortem and edge-case-hunter findings |
| `engineering-provenance` | Traceability, tooling, limitations, non-actions, and PR-ready text |

All seven form one Run evidence pack. They are not seven manual assignments. `implementation-notes` is the index; the real source and repository tests stay in their normal locations.

## What the human reviews

Use this order:

1. Read `implementation-notes`; stop unless its exact status is `Ready for verification`.
2. Inspect the real source/test diff for existence, scope, preserved behavior, and unauthorized changes.
3. Read `engineering-test-evidence` for exact criterion-to-test mappings, executable paths, commands, results, failures, and credible isolation.
4. Read `engineering-review` for all seven lenses, both adversarial passes, and unresolved severe/security findings.
5. Read `engineering-provenance` for truthful links, revisions, limitations, and explicitly unperformed actions.
6. Use plan, tasks, and session log only when deeper traceability or recovery is needed.

Independent test authoring uses these review classes:

| Tier | Human interpretation |
|---|---|
| A | Fresh model and session; implementation hidden; normally pass-capable |
| B | Fresh session, possibly same model; implementation hidden; normally pass-capable |
| C | Same implementation session told to ignore prior context; blocked without human exception |
| Limited | Independence cannot be established; blocked without human exception |

A Tier C/Limited exception must be scoped to named criteria, have a non-Agent human owner and durable approval reference, explain why A/B was unavailable, name compensating evidence and residual risk, and include a revisit condition. Artifact prose cannot self-approve it.

Approve Implementation only when current code, tests, all seven artifacts, upstream clearances, and real command evidence agree. Approval unlocks Tester; it does not approve Verification, merge, deployment, or Release.

## Handoff and escalation

Tester receives the working change, `implementation-notes`, `engineering-test-evidence`, and `engineering-review`, with links to the remaining pack and real diff. Tester independently verifies acceptance, regression, NFR, deferred Design, and risk obligations.

Return scope, policy, or acceptance wording to PM / BA or the human owner; visible behavior to Designer; boundaries, ADRs, security constraints, or NFR exceptions to Architect/human risk owner. Escalate non-test DDL, credential/sensitive-data behavior, material risk, verification exceptions, PR publication, merge, deployment, rollback, and release decisions to an authorized human.

## Canonical sources

- [Canonical Software Engineer Agent](../../../templates/agents/software-engineer.md)
- [Global workflow definition](../../../templates/ai-native.yaml)
- [Shared workflow](../../../templates/shared/.ai-sdlc/workflows/default.md)
- [Software Engineer workflow](../../../templates/shared/.ai-sdlc/roles/software-engineer/workflow.md)
- [Software Engineer config](../../../templates/shared/.ai-sdlc/roles/software-engineer/config.yaml)
- [Contract-driven engineering](../../../templates/shared/.ai-sdlc/roles/software-engineer/references/spec-driven-development.md)
- [Independent verification](../../../templates/shared/.ai-sdlc/roles/software-engineer/references/independent-verification.md)
- [Seven-lens review](../../../templates/shared/.ai-sdlc/roles/software-engineer/references/seven-lens-review.md)
- [CI and project checks](../../../templates/shared/.ai-sdlc/roles/software-engineer/references/ci-enforcement.md)
- [Engineering provenance](../../../templates/shared/.ai-sdlc/roles/software-engineer/references/provenance.md)
- [Engineering artifact templates](../../../templates/shared/.ai-sdlc/templates)

Return to [Role Relationships](../README.md).
