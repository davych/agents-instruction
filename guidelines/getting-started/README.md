# Getting Started

This guide explains how to initialize the workflow in a target project and start the first role.

## Before you start

You need:

- Node.js 20 or later;
- a target project directory;
- permission to create files in that directory;
- an AI coding tool that can read project files.

The initializer is client-neutral. It does not ask whether you use Copilot, Claude, Codex, or another tool. Every tool reads the same canonical Markdown Agent files.

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
| Canonical Agent directory | No | Defaults to `.ai-sdlc/agents`. All six Agent files are copied here once. |
| Designer Markdown inputs | No | Comma-separated project-relative Markdown paths that the Designer should read. |
| Designer component catalog module | No | A project-relative `.mjs` module used to query real project components. |

The project name and summary are collected interactively. There are no `--name` or `--summary` flags.

Press Enter for the default Agent directory unless your AI tool reads Agents from another project-relative directory. The initializer still creates only one copy of each Agent.

## Write safety

The initializer checks every planned destination before writing.

It stops when:

- `ai-native.yaml` already exists;
- another planned file already exists;
- a planned file conflicts with an existing directory;
- a parent path is a file or a symbolic link;
- a path could escape the target project.

It does not merge, overwrite, or partly initialize a conflicting project. Resolve the conflict, then run the command again.

## Generated project structure

With the default Agent directory, the target project receives:

```text
ai-native.yaml
.ai-sdlc/
  agents/
    pm-ba.md
    designer.md
    architect.md
    software-engineer.md
    tester.md
    devops.md
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
  workflows/
    default.md
  templates/
  guides/
  tasks/
```

The PM / BA, Designer, and Architect have extra role packs because they need longer procedures, role-specific inputs, references, or validation rules. Their `workflow.md` files are ordinary Markdown read explicitly by the canonical Agent; they are not client-native Skills. Software Engineer, Tester, and DevOps keep their shorter procedures in the Agent file.

The initializer does not create product deliverables under `docs/`. The Agents create those artifacts later, following `ai-native.yaml`.

## Start the first task

1. Open `ai-native.yaml` and confirm the project summary, output root, role list, phase order, and artifact registry.
2. Add product source documents to `.ai-sdlc/roles/pm-ba/config.yaml` under `inputs.markdown` when they exist.
3. Find the canonical PM / BA Agent by reading `paths.agents` from `ai-native.yaml` and appending `/pm-ba.md`.
4. Ask your AI tool to read the Agent, the shared workflow, the PM / BA role workflow, and the supplied source files.
5. Run the discovery phase. Review the PRD and stories before allowing the design phase to start.

A simple first prompt is:

```text
Read ai-native.yaml and .ai-sdlc/workflows/default.md. Resolve paths.agents,
then read the single pm-ba.md Agent and .ai-sdlc/roles/pm-ba/workflow.md.

Act as PM / BA for this task: [describe the opportunity or feature].
Use these business sources: [paths or "none provided"].
Create or update the registered PRD and user-story artifacts. Show assumptions,
open human decisions, and whether the discovery gate is ready.
```

## Continue through the workflow

After each phase:

1. review the output artifacts;
2. check the phase gate in `ai-native.yaml`;
3. resolve open human decisions;
4. pass the registered artifacts to the next role;
5. keep evidence in the artifacts or active task file.

See [End-to-End Workflow](../workflow/README.md) for the complete sequence and [Role Relationships](../roles/README.md) for the handoff map.

## Local package development

From this repository:

```bash
npm test
npm pack --dry-run
```

The publish workflow runs tests before `npm publish`. It requires a repository secret named `NPM_TOKEN`.
