# Software Engineer Role Guide

## Purpose

Software Engineer turns confirmed product, design, and architecture decisions into a working software change.

This role implements the agreed scope, adds the necessary automated tests, runs available project checks, and records what changed. It does not choose product scope, invent missing design behavior, or approve architecture decisions.

## Place in the workflow

| Direction | Role | Relationship |
|---|---|---|
| Upstream | PM / BA | Provides scope, business rules, stories, and acceptance criteria. |
| Upstream | Designer | Provides the design baseline and `ready-for-engineering` design spec. |
| Upstream | Architect | Provides the human-accepted architecture index and active constraints. |
| Current role | Software Engineer | Implements, tests, and records the confirmed change. |
| Next phase | Tester | Verifies the implementation against acceptance criteria and risks. |

## Inputs

Resolve every artifact through `ai-native.yaml` and the shared workflow.

| Artifact | Owner | Why it is needed |
|---|---|---|
| `prd` | PM / BA | Understand the product goal and confirmed scope. |
| `user-stories` | PM / BA | Trace implementation and tests to acceptance criteria. |
| `design-baseline` | Designer | Follow verified project components, layout, accessibility, and content conventions. |
| `design-spec` | Designer | Read feature behavior and the engineering handoff. |
| `architecture` | Architect | Check pack status and active constraints. |
| `architecture-c4-containers` | Architect | Understand selected container boundaries and communication paths. |
| `architecture-adrs` | Architect | Follow accepted technical decisions. |
| `architecture-patterns` | Architect | Apply active patterns at their documented locations. |
| `architecture-nfrs` | Architect | Preserve confirmed quality budgets. |

Start architecture reading at the `architecture` index. A child artifact does not make a pending or unaccepted pack active.

Do not start implementation unless:

- the complete design phase gate has passed, including traceability and validation evidence;
- `design-spec` has status `ready-for-engineering` and its `blockers` array is empty;
- the architecture gate has passed.

## Outputs

Software Engineer owns `implementation-notes`.

With the default configuration:

```text
docs/ai-native/engineering/implementation-notes.md
```

The notes record implemented scope, changed areas, tests and checks that actually ran, known limits, and remaining risks. They do not replace source code, commits, test output, or architecture records.

## Role workflow

```mermaid
flowchart TD
  Inputs["Resolve product, design, and architecture inputs"] --> Design{"Design handoff ready?"}
  Design -->|"No"| ReturnDesign["Return missing behavior or blockers to Designer or human owner"]
  Design -->|"Yes"| Architecture{"Architecture gate passed?"}
  Architecture -->|"No"| Wait["Wait for an accepted architecture handoff"]
  Architecture -->|"Yes"| Trace["Trace stories and acceptance criteria to the change"]
  Trace --> Plan["Plan a small implementation inside confirmed scope"]
  Plan --> Implement["Implement the software change"]
  Implement --> Tests["Add and run the necessary automated tests"]
  Tests --> Checks["Run available project quality checks"]
  Checks --> Notes["Write implementation notes with real evidence"]
  Notes --> Gate{"Implementation and necessary tests complete?"}
  Gate -->|"No"| Gap["Record the gap and return it to the correct owner"]
  Gap --> Inputs
  Gate -->|"Yes"| Handoff["Hand off to Tester"]
```

### Step-by-step explanation

1. **Resolve inputs** — Use registered artifact IDs and owner-aware path rules. Do not guess file locations.
2. **Check design readiness** — A draft or blocked design spec is not an implementation instruction.
3. **Check architecture acceptance** — Read the index first and follow only active, accepted decisions.
4. **Create traceability** — Connect changed behavior and tests to story and acceptance-criteria IDs.
5. **Plan the smallest complete change** — Stay within confirmed scope and preserve current project conventions.
6. **Implement** — Follow active design behavior, ADR rules, pattern placement, and NFR constraints.
7. **Test** — Add tests needed for the changed behavior and run project-supported checks.
8. **Record evidence** — Name commands that actually ran and their results. Mark checks that did not run.
9. **Hand off** — Give Tester enough information to find the change, reproduce checks, and focus on remaining risk.

## Completion gate

The gate from `ai-native.yaml` is:

> The implementation and necessary tests are complete.

Evidence used to review this gate:

- the agreed implementation is complete;
- the necessary automated tests are complete;
- required project checks pass;
- acceptance-criteria traceability is visible;
- implementation notes contain real validation evidence and remaining risks.

Record every unresolved failure, but a failure that prevents the implementation or necessary tests from being complete keeps the gate blocked.

Passing this gate does not approve release.

## Handoff

The Tester handoff contains:

- story and acceptance-criteria IDs covered;
- changed code areas;
- important behavior and constraints;
- tests added or changed;
- commands that actually ran and their results;
- checks that did not run and why;
- known limits, defects, and regression risks.

## Human-owned decisions and boundaries

Software Engineer returns scope changes, missing design behavior, conflicting architecture decisions, NFR exceptions, and material risk acceptance to the responsible role or human owner.

Software Engineer does not:

- change confirmed product scope without approval;
- invent missing interaction behavior;
- mark a draft design ready;
- accept an architecture decision or risk;
- ignore an active ADR or NFR without escalation;
- claim tests or checks ran when they did not;
- approve release or claim deployment happened.

## Source files

- [Canonical Software Engineer Agent](../../../templates/agents/software-engineer.md)
- [Global workflow definition](../../../templates/ai-native.yaml)
- [Shared workflow rules](../../../templates/shared/.ai-sdlc/workflows/default.md)
- [Implementation notes template](../../../templates/shared/.ai-sdlc/templates/implementation-notes.md)

Software Engineer currently has no role-specific config or separate role workflow. Its procedure stays in the canonical Agent and uses the global artifact registry and shared workflow.

Return to [Role Relationships](../README.md).
