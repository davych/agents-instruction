# Getting Started

This guide explains how to initialize the workflow in a target project and start the first role.

## Before you start

You need:

- Node.js 20 or later;
- a target project directory;
- permission to create files in that directory;
- an AI coding tool that can read project files.

The repository keeps one canonical Markdown source for each role. During initialization, you choose GitHub Copilot, Claude Code, or Codex. The CLI then installs exactly one native Agent set for that client.

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

You do not enter an Agent directory. The initializer uses the selected client's native project directory and installs only that client's Agent set.

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

Codex TOML is generated from the same six canonical Markdown sources during initialization. The repository does not maintain a second Codex role source.

The PM / BA, Designer, and Architect have extra role packs because they need longer procedures, role-specific inputs, references, or validation rules. Their `workflow.md` files are ordinary Markdown read explicitly by the canonical Agent; they are not client-native Skills. Software Engineer, Tester, and DevOps keep their shorter procedures in the Agent file.

The initializer does not create product deliverables under `docs/`. In the platform, creating a Run creates its immutable Change Contract; selected Agents create only the artifacts required by the Run's impact dispositions. For a non-platform local workflow, a human starts `.ai-sdlc/templates/change-contract.md` before invoking a role.

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

See [End-to-End Workflow](../workflow/README.md) for the complete sequence and [Role Relationships](../roles/README.md) for the handoff map.

## Local package development

From this repository:

```bash
npm test
npm pack --dry-run
```

The publish workflow runs tests before `npm publish`. It requires a repository secret named `NPM_TOKEN`.
