# Getting Started

This guide explains how to initialize the workflow in a target project and start the first role.

## Before you start

You need:

- Node.js 20 or later;
- a target project directory;
- permission to create files in that directory;
- an AI coding tool that can read project files.

The repository keeps one canonical Markdown source for each role. During initialization, you choose GitHub Copilot, Claude Code, or Codex. The CLI then renders and installs exactly one native Agent set for that client from the same six sources.

## Run the initializer

### Current repository version

The package is not published on npm yet. Run it from GitHub:

```bash
npx --yes --package=github:davych/my-sdlc-workflow \
  create-ai-native-sdlc init .
```

Replace `.` with another target directory when needed:

```bash
npx --yes --package=github:davych/my-sdlc-workflow \
  create-ai-native-sdlc init ./my-project
```

### After the first npm release

```bash
npx create-ai-native-sdlc@latest init .
```

Do not use the npm command until the package has been published.

## Interactive questions

The CLI collects five values:

| Value | Required | Meaning |
|---|---:|---|
| Project name | No | Defaults to the target directory name. |
| Project summary | Yes | One short sentence that explains the problem the product solves. |
| Target AI client | Yes | Choose GitHub Copilot, Claude Code, or Codex. This decides the native Agent directory and format. |
| Designer Markdown inputs | No | Comma-separated project-relative Markdown paths that the Designer should read. |
| Designer component catalog module | No | A project-relative `.mjs` module used to query real project components. |

The project name and summary are collected interactively. There are no `--name` or `--summary` flags.

For automation, the optional client flag can answer only the client question:

```bash
npx create-ai-native-sdlc@latest init . --client codex
```

Valid CLI values are `copilot`, `claude`, and `codex`. The generated `ai-native.yaml` stores their canonical configuration values as `github-copilot`, `claude-code`, and `codex`. Name, summary, and any Designer inputs remain interactive.

You do not enter an Agent directory. The initializer uses the selected client's native project directory and installs only that client's Agent set.

## Write safety

The initializer checks every planned destination before writing.

It stops when:

- `ai-native.yaml` already exists;
- another planned file already exists;
- a planned file conflicts with an existing directory;
- a parent path is a file or a symbolic link;
- a path could escape the target project.

It does not merge or overwrite a conflicting project. Initialization is create-only, abort-safe, and transactionally all-or-nothing at its reported outcome: staged files are published exclusively, and a failed, timed-out, or cancelled attempt removes the files and newly empty directories that attempt created before reporting failure. A process crash can leave a journaled partial transaction; the next invocation verifies inode and content identities and removes only unchanged transaction-owned remnants before retrying. Externally replaced or modified remnants are preserved, and a hidden staging remainder created before the canonical journal was published is detected but not auto-deleted; both cases fail closed for human inspection. This is crash recovery, not simultaneous multi-file visibility. Resolve an ordinary conflict, then run the command again.

### Updating an already initialized project

The initializer is create-only, not an in-place upgrader. Do not rerun it over an existing project or replace project-owned workflow files wholesale. Adopt newer role procedures and artifact contracts through an explicit, reviewed incremental backfill. For this V1 that includes Tester's linked-workspace lifecycle and DevOps's config, workflow, Release inputs, task-scoped runbook, template, and semantic contract. Keep the existing six phase IDs and owners, preserve project-owned content and local conventions, add or reconcile only the affected artifacts, diff every file, run the applicable root and platform checks, and obtain human approval before using the updated gates.

## Generated project structure

Every target project receives the shared workflow files:

```text
ai-native.yaml
.ai-sdlc/
  roles/
    pm-ba/
      config.yaml
      workflow.md
    designer/
      config.yaml
      workflow.md
    architect/
      config.yaml
      workflow.md
    software-engineer/
      config.yaml
      workflow.md
      references/
        *.md
    tester/
      workflow.md
      references/
        e2e-playwright.md
    devops/
      config.yaml
      workflow.md
  workflows/
    default.md
  templates/
  guides/
  tasks/
```

It also receives exactly one native Agent set:

| Selected client | Installed Agent files |
|---|---|
| GitHub Copilot | `.github/agents/<role>.agent.md` |
| Claude Code | `.claude/agents/<role>.md` |
| Codex | `.codex/agents/<role>.toml` |

Every native format is generated from the same six canonical Markdown sources during initialization. The repository does not maintain client-specific role identities.

All six roles have supporting `workflow.md` procedures. PM / BA, Designer, Architect, Software Engineer, and DevOps also have role configs; focused reference files exist only where the procedure needs them. These files are ordinary project Markdown read explicitly by the canonical Agent. They are not client-native Skills or additional Agent definitions.

The initializer does not create product deliverables under `docs/`. In the platform, creating a Run creates its immutable Change Contract; selected Agents create only the artifacts required by the Run's impact dispositions. For a non-platform local workflow, a human starts `.ai-sdlc/templates/change-contract.md` before invoking a role.

Platform-resolved output paths must remain beneath `paths.outputs`, beneath the artifact owner's configured namespace where one exists, and outside workflow controls, Git control state, and the selected native Agent directory. Unsafe traversal, absolute or backslash forms, symlink escape, case/Unicode-equivalent collisions, and file/directory overlap are rejected.

## Software Engineer evidence pack

After Product, Design, and Architecture are cleared, Software Engineer reads its canonical native Agent plus `.ai-sdlc/roles/software-engineer/workflow.md` and the ordinary Markdown references in that role pack. It loads relevant project context in layers: the nearest `AGENTS.md` or `CLAUDE.md` hot rules, stack and testing documents as warm context, and gap or history logs as cold context. Only files actually read may be claimed as context.

The implementation phase produces real source and test changes and seven registered Web outputs for the current Run:

| Artifact ID | Purpose |
|---|---|
| `implementation-notes` | Evidence-pack index and Tester handoff |
| `implementation-plan` | Smallest complete vertical-slice strategy and Greenfield/Brownfield boundaries |
| `implementation-tasks` | Atomic task status, repository targets, dependencies, and acceptance-criterion mappings |
| `engineering-session-log` | Ordered actions, decisions, rejected alternatives, and actual command history |
| `engineering-test-evidence` | Independent-test isolation, criterion coverage, failures, and results |
| `engineering-review` | Seven required lenses plus adversarial findings |
| `engineering-provenance` | Cold-audit links and PR-ready provenance content |

The Web platform resolves all seven to stable Run-scoped paths, so one task cannot overwrite another task's engineering evidence. `implementation-notes` indexes the other six; it does not replace them or the real code and tests.

Independent test design records an isolation tier. Tier A uses a fresh model and session; Tier B uses a fresh session and may use the same model. Both may satisfy the normal gate when the author cannot see the implementation. Tier C reuses the implementation session with an instruction to ignore prior details, while Limited cannot establish independence; either remains blocked unless a human records an explicit verification-gate exception and compensating evidence.

Software Engineer also completes all seven review lenses and the adversarial pre-mortem and edge-case-hunter passes. It may generate PR-ready provenance, but it does not publish or merge a pull request, deploy, approve risk, or replace the independent Tester phase.

## After the engineering evidence appears

The seven files are one generated pack, not seven tasks for you to fill in.

1. Open `implementation-notes` and confirm it says `Ready for verification`; `Failed` or `Blocked` means return the named gap.
2. Inspect the real source/test diff. The evidence pack explains the change but does not replace it.
3. Read `engineering-test-evidence`, then `engineering-review`. Confirm every AC/regression has real passing evidence, the isolation tier is credible, and no high/security or unresolved finding remains.
4. Use plan, tasks, session log, and provenance when you need deeper audit. PR provenance is prepared text; it does not mean a PR was published, merged, or released.
5. Approve Implementation only when the current code and all evidence agree. That unlocks Tester.

Tester then follows `.ai-sdlc/roles/tester/workflow.md`: optionally explore the runnable UI with Playwright MCP; when E2E is required, use only a human-configured separate Linked E2E Workspace, let a fresh spec-only Test Author generate scripts there, review the exact manifest hash, and let the platform run standalone Playwright with a real headless Chromium before writing the Run-scoped `test-report`. The platform never searches for or adopts a sibling/legacy E2E repository. Product-source, product-repository-test, or testability-interface changes still return to Software Engineer and refresh Implementation evidence.

After Verification passes, DevOps reads the current `change-contract`, accepted architecture evidence, `implementation-notes`, `engineering-provenance`, and `test-report`. It prepares and validates only the task-scoped `release-runbook`: the exact Run ID and selected-input artifact/path/content-hash manifest, revision or digest binding, provenance and SBOM applicability, preconditions, ordered rollout, health and smoke checks, monitoring thresholds/windows/owners/actions, rollback triggers/RTO/data compatibility/recovery verification, incident escalation, risks, and the named human go/no-go owner. Web approval re-resolves current approved heads and refuses simulated/legacy Release executions. `Ready for human go/no-go` is a preparation result, not a release. The Agent does not deploy, configure CI or secrets, change branch policy, commit, push, merge, publish, roll back, or make the decision.

## Direct IDE and Web operation

The selected native Agent files support direct use from GitHub Copilot, Claude Code, or Codex. The Web new-project flow can select the same three targets and uses the same initializer, role ownership, phase order, and artifact registry. Web execution itself still uses the local Codex runner; selecting another native client does not make the server launch that client.

The Web platform adds persisted clearances, task-scoped artifact pins, semantic gates, and supervised Linked E2E events. A direct IDE session can follow the same role and artifact contract, but it must not claim Web-produced manifest approvals, trusted runner events, or equivalent Linked E2E guarantees unless those events actually came from the platform.

The current Web platform is only for local, trusted, disposable or otherwise recoverable projects. Its API has no authentication, and the Codex runner is not isolated by an OS sandbox. Do not expose it remotely or register untrusted repositories; authenticated access and an isolated worktree/container runner remain security-architecture blockers.

## Start the first task

1. Open `ai-native.yaml` and confirm the project summary, output root, role list, phase order, and artifact registry.
2. Add product source documents to `.ai-sdlc/roles/pm-ba/config.yaml` under `inputs.markdown` when they exist.
3. Create the Run Change Contract in the platform, or fill `.ai-sdlc/templates/change-contract.md` for a local workflow.
4. Record Product Impact as `direct`, `reuse`, `partial`, or `full`.
5. Invoke PM / BA only for `partial` or `full`, using the selected `prd` and/or `user-stories` outputs.
6. Review the Product clearance before moving to Design Impact. Do not create an empty PRD or story set for `direct`.

A simple first prompt is:

```text
Use the PM / BA Agent for this task.

Read ai-native.yaml, .ai-sdlc/workflows/default.md,
.ai-sdlc/roles/pm-ba/config.yaml, and
.ai-sdlc/roles/pm-ba/workflow.md.

The immutable Change Contract is: [resolved path].
The Product disposition is [partial or full].
The selected outputs are [prd and/or user-stories].
Use these business sources: [paths or "none provided"].
Create or update only the selected artifacts. Do not edit the Change Contract or
rewrite unaffected baseline content. Show assumptions, open human decisions,
regression obligations, and whether the discovery gate is ready.
```

## Continue through the workflow

After each phase:

1. review the output artifacts;
2. review the recorded impact disposition and check the phase gate in `ai-native.yaml`;
3. resolve open human decisions;
4. pass the registered artifacts to the next role;
5. keep evidence in the artifacts or active task file.

For the Implementation-to-Verification handoff, use the exact review order in [After the engineering evidence appears](#after-the-engineering-evidence-appears). A linked-workspace script stays in Tester's fresh-author and exact-hash-review loop. A change to product source, product-repository tests, or a product testability interface goes back through Software Engineer and Implementation reapproval. After Verification, DevOps prepares the current task's runbook and the Release semantic gate checks it before a human decides go/no-go. No Agent path skips to CI, merge, deployment, or publication.

See [End-to-End Workflow](../workflow/README.md) for the complete sequence and [Role Relationships](../roles/README.md) for the handoff map.

## Local package development

From this repository:

```bash
npm test
npm pack --dry-run

cd platform
yarn typecheck
yarn test
yarn build
```

CI runs the root initializer checks and the platform checks as separate jobs. The publish workflow runs tests before `npm publish`; it requires a repository secret named `NPM_TOKEN` and remains outside DevOps Agent authority.
