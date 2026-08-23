# Configuration Guide

`ai-native.yaml` is the global source of truth for the initialized workflow. Role configs add role-specific inputs and a child output directory. They do not replace the global workflow.

## Global YAML

The root `ai-native.yaml` has six main sections:

| Section | Purpose |
|---|---|
| `project` | Project name, short summary, and content locale |
| `agent` | The AI client selected during initialization |
| `paths` | The selected client's native Agent directory and the global AI-output root |
| `roles` | Role IDs, missions, and responsibilities |
| `workflow.phases` | Phase owners, declared inputs, outputs, and completion gates |
| `artifacts` | Stable artifact IDs, owners, and paths |

Example:

```yaml
agent:
  client: "codex"

paths:
  agents: ".codex/agents"
  outputs: docs
```

`agent.client` records `github-copilot`, `claude-code`, or `codex`. `paths.agents` records the native Agent directory selected by the initializer. `paths.outputs` controls the root for later AI-produced artifacts.

Do not move the installed Agent files or edit `agent.client` or `paths.agents` by hand. Native discovery depends on the selected client's project directory. Run the initializer in a new target project to choose another client.

## Artifact path resolution

Never guess an artifact path. Resolve it from its artifact ID and owner.

```mermaid
flowchart LR
  ArtifactId["Requested artifact ID"] --> Registry["Find owner and path in ai-native.yaml"]
  Registry --> Root["Read paths.outputs"]
  Registry --> Owner["Read artifact owner"]
  Owner --> RoleConfig{"Does the owner have a role config?"}
  RoleConfig -->|"Yes"| Subdirectory["Read output.subdirectory"]
  RoleConfig -->|"No"| NoSubdirectory["Use no role subdirectory"]
  Registry --> ArtifactPath["Read artifact path"]
  Root --> Join["Join path parts"]
  Subdirectory --> Join
  NoSubdirectory --> Join
  ArtifactPath --> Join
  Join --> Result["Resolved artifact location"]
```

The diagram means:

1. Find the artifact record in `ai-native.yaml`.
2. Start with the global `paths.outputs` value.
3. Read the artifact owner.
4. If that owner has `.ai-sdlc/roles/<owner>/config.yaml`, append its `output.subdirectory`.
5. Append the artifact `path` from the global YAML.

Always use the artifact owner's config, not the active role's config.

For the default Change Contract, `change-contract.md` is a configured basename. The platform creates one immutable human artifact for every Run and resolves it to a stable task-specific filename:

```text
docs + ai-native/product + change-contract.md
+ current task "修复结算舍入" + run 550e8400-e29b-41d4-a716-446655440000
= docs/ai-native/product/修复结算舍入--550e8400-e29b-41d4-a716-446655440000-change-contract.md
```

Its logical ID remains `change-contract`. Although its registry owner is `pm-ba`, every Agent consumes it read-only. Changing the requested outcome requires a new Run and Change Contract, not an Agent edit.

For the default Designer spec, `design-spec.md` is a configured basename. A platform-managed task resolves it to a stable task-specific filename:

```text
docs + ai-native/design + design-spec.md
+ current task "登录改版" + run 550e8400-e29b-41d4-a716-446655440000
= docs/ai-native/design/登录改版--550e8400-e29b-41d4-a716-446655440000-design-spec.md
```

The logical artifact ID remains `design-spec`, so downstream dependencies do not depend on a filename. Every re-run of that task resolves the same path; another task, including one with the same title, resolves a different path because its run ID differs. The active execution contract is authoritative for every task-scoped artifact in that Run.

The phase input arrays declare the full evidence vocabulary for compatible clients. In a platform-managed Run, Product, Design, and Architecture dispositions resolve the concrete alternatives. For example, Product `direct` does not require a fake PRD and Design `skip` does not require a fake design spec. The platform extends older initialized projects with `change-contract` support in memory rather than rewriting project-owned YAML.

Software Engineer has a role config with `output.subdirectory: ai-native/engineering`. Its seven artifact paths are registered as basenames in `ai-native.yaml`, so normal owner-aware resolution produces paths such as:

```text
docs + ai-native/engineering + implementation-notes.md
= docs/ai-native/engineering/implementation-notes.md
```

In a platform-managed Run, all seven engineering artifacts are task-scoped after that normal resolution. The platform derives a stable task-and-Run namespace without rewriting the project-owned registry:

```text
docs/ai-native/engineering/implementation-notes.md
+ current task "修复结算舍入" + run 550e8400-e29b-41d4-a716-446655440000
= docs/ai-native/engineering/修复结算舍入--550e8400-e29b-41d4-a716-446655440000-implementation-notes.md
```

The same namespace applies to `implementation-plan`, `implementation-tasks`, `engineering-session-log`, `engineering-test-evidence`, `engineering-review`, and `engineering-provenance`. `implementation-notes` is the pack index. Tester consumes that index plus the independently reviewable `engineering-test-evidence` and `engineering-review` heads from the same Run.

The platform also task-scopes `test-report` after its normal direct registry resolution, so different Runs do not overwrite one shared verification report:

```text
docs/ai-native/testing/test-report.md
+ current task "修复结算舍入" + run 550e8400-e29b-41d4-a716-446655440000
= docs/ai-native/testing/修复结算舍入--550e8400-e29b-41d4-a716-446655440000-test-report.md
```

When a Run already has a persisted artifact revision, that stored path remains pinned across reruns even if the live project configuration later changes.

Legacy compatibility is intentionally non-destructive: an older Run whose persisted `test-report` still uses the former shared basename keeps that path. If two pre-upgrade Runs already point to the same physical report, they remain shared until an authorized operator performs an explicit per-Run backfill. Do not rerun Verification for either shared Run, sequentially or concurrently: either order can overwrite evidence before the platform can prove Run ownership. Resume only after each Run has its own pinned report path; never assume the platform silently moved project-owned evidence. New Runs always receive distinct Run-scoped paths.

An artifact path may name one file or one directory. For example, `user-stories` and `architecture-adrs` are directory artifacts.

## Role configs

Four roles have their own config:

| Role | Config | What it may control |
|---|---|---|
| PM / BA | `.ai-sdlc/roles/pm-ba/config.yaml` | Business Markdown inputs and `output.subdirectory` |
| Designer | `.ai-sdlc/roles/designer/config.yaml` | Role resources, upstream artifacts, extra Markdown, component query/validation paths, and `output.subdirectory` |
| Architect | `.ai-sdlc/roles/architect/config.yaml` | Upstream artifacts, evidence Markdown, confirmed context, review floors, and `output.subdirectory` |
| Software Engineer | `.ai-sdlc/roles/software-engineer/config.yaml` | Upstream artifact vocabulary, layered-context candidates, evidence IDs, quality floors, and `output.subdirectory` |

A role config may:

- name project-relative input Markdown;
- name registered upstream artifact IDs;
- choose that role's child output directory;
- hold role-specific settings that do not redefine the global workflow.

A role config must not:

- replace `paths.outputs`;
- redefine artifact file names;
- write outside the target project;
- store credentials or private tokens;
- make an unknown project fact look confirmed.

Tester and DevOps currently have no role config. Their artifact paths are registered directly in `ai-native.yaml`.

The Software Engineer config does not redefine the role. The selected client's native Agent remains the one role definition, while `.ai-sdlc/roles/software-engineer/workflow.md` and its `references/*.md` files are ordinary supporting Markdown. They are not Skills or additional Agents. The config may declare Tier A/B as normally passing verification tiers and seven review lenses as a quality floor; it cannot let the Agent approve its own Tier C/Limited exception, architecture choice, risk acceptance, PR publication, or merge.

## Change the output root

To move all later AI artifacts from `docs/` to `product-docs/`, edit only the global root:

```yaml
paths:
  outputs: product-docs
```

The role child directories remain the same:

```text
product-docs/ai-native/product/
product-docs/ai-native/design/
product-docs/ai-native/architecture/
product-docs/ai-native/engineering/
product-docs/ai-native/testing/
product-docs/ai-native/operations/
```

## Change a role child directory

To move only PM / BA outputs inside the global root:

```yaml
output:
  subdirectory: product
```

The final PRD becomes:

```text
<paths.outputs>/product/prd.md
```

Do not repeat the global root in a role subdirectory.

## Add role input Markdown

Use project-relative paths:

```yaml
inputs:
  markdown:
    - docs/research/interviews.md
    - docs/business-rules.md
```

The role should report a missing or conflicting source. It must not silently invent its contents.

## Global workflow changes

You may edit phases and artifacts in `ai-native.yaml`, but keep these rules true:

- every phase has one owner;
- every declared input points to a registered artifact;
- every declared output is owned by the phase owner;
- later phases do not use an output before it is produced;
- artifact IDs stay stable when existing documents depend on them;
- human-owned decisions remain explicit gates.

See [End-to-End Workflow](../workflow/README.md) before changing phase dependencies.
