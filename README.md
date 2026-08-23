# create-ai-native-sdlc

A lightweight interactive initializer for an AI-native software delivery workflow.

It keeps one canonical Markdown source for each role, then installs one client-native Agent set in a target project. It is designed for solo builders and small teams that want clear role boundaries and handoffs without adding an orchestration platform.

## Project goal

The project helps one person work through a complete product delivery cycle with six explicit roles:

- Every Run starts with an immutable Change Contract and an evidence-backed Product Impact route.
- PM / BA runs only for partial or full product work; a new Run does not automatically rewrite the PRD.
- Designer can skip, reuse, partially update, or fully design work according to real UI/UX impact.
- Architect compares options and prepares a human-approved architecture pack.
- Software Engineer implements the confirmed product, design, and architecture, then packages independently verifiable engineering evidence for the Run.
- Tester verifies acceptance criteria and important risks.
- DevOps prepares a repeatable, observable, and reversible release path.

The workflow is controlled by `ai-native.yaml`. Markdown remains the source format for role content and working documents. The initializer installs the selected client's native Agent files; it does not run the Agents or approve workflow gates for you.

## Core model

```mermaid
flowchart LR
  Intent["Immutable Change Contract"] --> Product["Product Impact"]
  Product --> Design["Design Impact"]
  Design --> Architect["Architecture Impact<br/>skip / reuse / partial / full"]
  Architect --> Engineer["Software Engineer"]
  Engineer -->|"Run-scoped engineering evidence pack"| Tester["Tester"]
  Tester -->|"Test evidence"| DevOps["DevOps"]
  DevOps -->|"Release runbook"| Human["Human release decision"]
```

Each arrow is a handoff. `direct`, `skip`, and `reuse` can avoid a role execution while preserving evidence and provenance; `partial` updates only affected outputs. A bounded bug may therefore use Product `direct`, Design `skip`, and Architecture `skip` to reach Software Engineer without running those Agents, but it still needs acceptance and targeted regression evidence in Verification. Human decisions stay human-owned, especially product scope, architecture selection and acceptance, risk acceptance, and release approval.

## What to do after Software Engineer

The seven engineering Markdown files are one automatically generated evidence pack for one code change. They are not seven forms for you to complete, and they never replace the real source diff and repository tests.

Use this review order:

| Order | Artifact ID / default Markdown | Decision to make |
|---|---|---|
| 1 | `implementation-notes` / `implementation-notes.md` | Is the implementation `Ready for verification`, what code changed, and what is still limited or blocked? This is the pack index. |
| 2 | The real source/test diff / not a Markdown artifact | Does the claimed implementation actually exist in the repository and stay inside the approved scope? |
| 3 | `engineering-test-evidence` / `independent-test-evidence.md` | Does every AC/regression map to an executable test, did real commands pass, and is the Tier A/B independence claim credible? |
| 4 | `engineering-review` / `review.md` | Are all seven lenses and both adversarial passes complete, with no unresolved high/security finding? |
| 5 | `engineering-provenance` / `pr-provenance.md` | Do the spec, session, tests, review, limitations, and human boundaries link to real evidence? PR-ready text is not a published or merged PR. |

The platform prefixes those default basenames with the safe task title and full Run ID. Use the artifact ID shown in the Web UI as the stable identity; do not assume the physical filename is unprefixed.

Use `implementation-plan`, `implementation-tasks`, and `engineering-session-log` when you need to audit scope, unfinished work, command history, or a disagreement. Then choose one branch:

- If any primary file says `Failed`, `Blocked`, contains an unresolved finding, reports an unrun required check, or contradicts the real diff, do not approve. Return the named problem to Product, Design, Architecture, or Software Engineer, rerun the affected work, and review the refreshed pack.
- If the code and evidence are complete and current, approve the Implementation gate. That unlocks Tester; it does not merge a PR or approve release.
- Tester independently maps risk and writes `test-report`. When E2E applies, Tester may explore with Playwright MCP, ensures the durable script was independently crystallized and integrated through Software Engineer, then executes it with standalone Playwright. When E2E does not apply, Tester records the stronger applicable unit, integration, contract, or declared observation evidence instead.
- DevOps or the authorized repository owner turns the applicable repository suite into a required PR check; for E2E, it reuses the standalone command. A human still decides merge and release.

There are also two Markdown namespaces in this repository:

| Location | Meaning | What you do next |
|---|---|---|
| Initialized project `docs/ai-native/engineering/` or platform Run-scoped engineering paths | Delivery evidence produced for the product change | Review the pack above, approve or return it, then run Tester. |
| This initializer repository's `changes/`, `sessions/`, and `reviews/` | Maintainer evidence for changes to the workflow project itself | Use it to review this repository change or prepare a PR; it is not an initialized project's next-phase input. |

## Complete workflow and E2E lifecycle

```mermaid
flowchart TD
  subgraph Definition["Define and clear the Run"]
    W01["W01 · Immutable Change Contract"] --> W02{"W02 · Product Impact"}
    W02 --> W03{"W03 · Design Impact"}
    W03 --> W04{"W04 · Architecture Impact"}
  end

  subgraph Implementation["Implementation"]
    W04 --> W05["W05 · Software Engineer changes code and tests"]
    W05 --> W06["W06 · Seven-file engineering evidence pack"]
    W06 --> W07{"W07 · Human Implementation review"}
    W07 -->|"return"| W05
  end

  subgraph Verification["Verification · Tester"]
    W07 -->|"approve"| W08["W08 · Read notes → test evidence → review"]
    W08 --> W09["W09 · Map ACs, regressions, deferred checks, NFRs, risks"]
    W09 --> W10{"W10 · Need interactive discovery?"}
    W10 -->|"yes"| W11["W11 · Playwright MCP exploration<br/>transient, non-gating"]
    W10 -->|"no"| W12{"W12 · Durable E2E ready?"}
    W11 --> W12
    W12 -->|"missing or changed"| W13["W13 · Fresh Tier A/B crystallization<br/>freeze intent from spec"]
    W13 --> W14["W14 · Software Engineer integrates test<br/>refreshes evidence"]
    W14 --> W07
    W12 -->|"valid"| W15["W15 · Execution of mapped verification<br/>standalone Playwright when E2E"]
    W12 -->|"not applicable"| W15
    W15 --> W16["W16 · Run-scoped test-report"]
    W16 --> W17{"W17 · Verification gate"}
    W17 -->|"fail or blocked"| W18["W18 · Classify and return to owning role"]
    W18 -->|"product/spec"| W02
    W18 -->|"design"| W03
    W18 -->|"architecture/NFR"| W04
    W18 -->|"implementation"| W05
    W18 -->|"test script"| W13
    W18 -->|"local environment/runner"| W15
    W18 -->|"required-check configuration"| W19
  end

  subgraph Release["Release preparation and continuous enforcement"]
    W17 -->|"pass"| W19["W19 · DevOps runbook + required-check configuration"]
    W19 --> W20["W20 · Required PR check runs repository tests"]
    W20 -->|"fail"| W18
    W20 -->|"pass"| W21{"W21 · Human merge/release decision"}
  end
```

The Playwright steps are three E2E stages inside the existing Implementation-to-Verification boundary, not three extra global phases. They correspond to the user's Phase 1/2/3 description, but this documentation calls them stages so they cannot be confused with Product, Design, Implementation, Verification, and the other global phases. The return from W14 to W07 is deliberate: adding or changing `tests/e2e/*.spec.ts` makes the old engineering evidence stale, so Software Engineer must integrate it and refresh the pack before Tester can use it as current evidence.

## Workflow node details

| Node | Owner | Input | Action | Output or gate | Failure route |
|---|---|---|---|---|---|
| W01 | Human/platform | Request and evidence | Freeze scope, expected behavior, ACs, regressions, and non-goals | Immutable Change Contract | New outcome requires a new Run |
| W02 | Human + PM / BA | W01 | Choose direct/reuse/partial/full; run PM / BA only when needed | Product clearance and applicable product evidence | Unclear scope or policy stays here |
| W03 | Human + Designer | Product clearance | Choose skip/reuse/partial/full; define observable UI and deferred runtime checks | Design clearance and applicable spec | Missing interaction/accessibility decision returns here |
| W04 | Human + Architect | Product/design clearance | Choose skip/reuse/partial/full; accept boundaries, ADRs, risks, and NFRs | Architecture clearance | Boundary, security, or NFR decision returns here |
| W05 | Software Engineer | W01-W04 | Implement the smallest complete change and repository tests | Real source/test diff and check results | Implementation defect stays with Engineer |
| W06 | Software Engineer | W05 | Index plan, tasks, session, independent tests, review, and provenance | Seven Run-scoped evidence files | Missing/stale record blocks W07 |
| W07 | Human reviewer | W05-W06 | Inspect notes, real diff, test evidence, review, and provenance | Approve Implementation or request changes | Return to W05; no merge occurs |
| W08 | Tester | Approved W07 | Read `implementation-notes`, then test evidence and review | Verified intake and known-risk list | Stale/blocked evidence returns to Engineer |
| W09 | Tester | Contract, design/NFR, W08 | Map every AC, regression, deferred validation, and material risk to an evidence level | Verification strategy | Ambiguity routes to its upstream owner |
| W10 | Tester | W09 | Decide whether UI path discovery adds value | Explore or proceed | MCP absence blocks only required exploration |
| W11 | Tester | Runnable non-production app | Operate Playwright MCP, observe DOM/accessibility, diagnose selectors | Transient session/screenshot notes | Never counts as repeatable pass alone |
| W12 | Tester | W09-W11 and existing tests | Decide whether durable E2E is required and already valid | Reuse/not-applicable or crystallization request | Missing/changed script goes to W13 |
| W13 | Fresh independent authoring session | Authoritative spec, frozen intent, public harness | Author from spec without implementation/exploration transcript; adapt selectors only after intent is frozen. In a platform Run, Verification requests changes with an exact first-line `E2E crystallization request: <nonempty scenario>`, one current-contract `AC: <ID>` per line, and one `Frozen intent: <observable behavior>`; only those parsed bounded fields reach the later Engineer rerun | Candidate repository-conventional `*.spec.ts` plus traceable read-only feedback | Tier C/Limited stays blocked without human exception |
| W14 | Software Engineer | W13 candidate | Integrate test, run real checks, refresh all stale engineering evidence | Current test path and reapprovable evidence pack | Back to W07, never straight to CI |
| W15 | Tester/runner | Approved current revision and W09 evidence map | Execute every applicable mapped unit, integration, contract, E2E, or declared observation check; E2E uses actual `playwright test` or the repository wrapper, never MCP | Current exit/result plus report, trace, screenshot, log, or observation evidence as applicable | Classify at W18 |
| W16 | Tester | W09-W15 | Record exploration status, isolation, test path, exact execution, gaps, defects, and risk | Run-scoped `test-report` | Missing evidence remains fail/blocked/untested |
| W17 | Human/workflow gate | W16 and declared obligations | Check all applicable evidence is current and no material blocker remains | Verification pass or return | Failure goes to W18 |
| W18 | Tester + owning role | Reproduction and failure evidence | Classify implementation/test/spec/design/architecture/environment cause before changing anything | Named owner and next action | Routes to W02/W03/W04/W05/W13; local runner repair returns to W15, CI-policy repair to W19 |
| W19 | DevOps/authorized owner | Passing Verification plus Tester command/report contract, or a required-check configuration failure | Prepare release/rollback and configure the real CI job, secrets, browser, reporter, retention, and check name | Runbook and enforced CI contract | Retry W20 after CI repair; local Tester execution never skips W15-W17 |
| W20 | CI | Every relevant PR revision | Execute repository tests autonomously; MCP is not present | Required-check pass/fail plus durable report | Failure goes to W18 |
| W21 | Human | Current CI, test report, runbook, residual risk | Decide merge timing and release | Explicit human decision | No Agent self-approves |

See the [Tester guide](guidelines/roles/tester/README.md) for the operating procedure and the [End-to-End Workflow](guidelines/workflow/README.md) for phase contracts and feedback rules.

## Quick start

Requirements: Node.js 20 or later.

The npm package is not published yet. Run the current repository version with:

```bash
npx --yes --package=github:davych/my-sdlc-workflow \
  create-ai-native-sdlc init .
```

After the first npm release, the command will be:

```bash
npx create-ai-native-sdlc@latest init .
```

The CLI asks for the project name, project summary, target AI client, optional Designer Markdown inputs, and an optional component catalog module. The client choice decides the Agent directory and file format. It does not take the project name or summary as command flags.

See [Getting Started](guidelines/getting-started/README.md) for the full setup and first-run guide.

## What is installed

```text
ai-native.yaml
.ai-sdlc/
  roles/        # optional role workflows, configs, rules, and scripts
  workflows/    # the shared execution order and artifact rules
  templates/    # templates for AI-produced artifacts
  guides/       # initialized usage guidance
  tasks/        # task workspace

# Exactly one native Agent set is installed:
.github/agents/*.agent.md   # GitHub Copilot
.claude/agents/*.md         # Claude Code
.codex/agents/*.toml        # Codex
```

The repository keeps only six canonical Markdown Agent sources. Initialization asks for GitHub Copilot, Claude Code, or Codex and installs only that client's files. Codex TOML files are generated from the same Markdown sources during initialization; they are not a second source to maintain.

AI-produced artifacts are written under `docs/` by default. Change `paths.outputs` in `ai-native.yaml` to use another output root.

Each Agent defines one role's identity, rules, boundaries, and handoff. PM / BA, Designer, Architect, Software Engineer, and Tester also have role packs under `.ai-sdlc/roles/` for longer procedures, configuration, and references. Their `workflow.md` and `references/*.md` files are ordinary Markdown read explicitly by the canonical Agent; they are not client-native Skills, second Agents, or alternate sources of role identity.

The Software Engineer phase creates a working repository change plus seven registered, Run-scoped Web outputs: `implementation-notes` as the pack index, `implementation-plan`, `implementation-tasks`, `engineering-session-log`, `engineering-test-evidence`, `engineering-review`, and `engineering-provenance`. The pack records layered context, Greenfield or Brownfield planning, independent-test isolation, seven-lens and adversarial review, and PR-ready provenance. It prepares evidence for review but does not publish or merge a pull request.

## Documentation

| Guide | What it explains |
|---|---|
| [Getting Started](guidelines/getting-started/README.md) | Installation, interactive setup, generated files, and the first task |
| [Configuration](guidelines/configuration/README.md) | `ai-native.yaml`, role configs, artifact paths, and safe customization |
| [End-to-End Workflow](guidelines/workflow/README.md) | Phase order, gates, feedback loops, artifacts, and human decisions |
| [Role Relationships](guidelines/roles/README.md) | How the six roles depend on and hand work to one another |
| [PM / BA](guidelines/roles/pm-ba/README.md) | Change Contract routing, Product Impact, PRD/story deltas, acceptance criteria, and handoff |
| [Designer](guidelines/roles/designer/README.md) | Design Impact, skip/reuse/partial/full paths, project baseline, task spec, and handoff |
| [Architect](guidelines/roles/architect/README.md) | Context, options, human selection, C4, ADRs, NFRs, and premortem |
| [Software Engineer](guidelines/roles/software-engineer/README.md) | Layered context, contract-driven implementation, independent tests, seven-lens review, and provenance |
| [Tester](guidelines/roles/tester/README.md) | Playwright MCP exploration, independent E2E crystallization, standalone execution, evidence, defects, and test report |
| [DevOps](guidelines/roles/devops/README.md) | Release preparation, monitoring, rollback, and runbook |

## Local validation

```bash
npm test
npm pack --dry-run
```

The repository includes a small CI workflow and an npm publish workflow. A future release needs an `NPM_TOKEN` repository secret and a matching package version.

## License

MIT
