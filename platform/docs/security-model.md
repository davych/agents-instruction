# Platform security model

This document describes the current V1 security boundary of the local AI SDLC Platform. It is not a production-security claim.

For installation and operator commands, see the [Platform README](../README.md). For workflow behavior, see the [runtime contract](runtime-contract.md).

## Supported trust model

Use the platform only when all of these conditions hold:

- it runs locally in a trusted environment;
- every registered project is trusted;
- project state is disposable or otherwise recoverable;
- allowed project roots are narrow and explicitly configured;
- the operator understands that real model execution sends required task context to the configured model service;
- consequential changes remain subject to explicit human review.

Do not expose this V1 as a remote or multi-user service. Do not register an untrusted repository.

## Explicitly missing boundaries

The current platform does not provide:

- API authentication or user authorization;
- tenant isolation;
- an OS sandbox for Codex or its child processes;
- credential isolation suitable for untrusted code;
- a network egress policy;
- containment for escaped background or detached descendants after the end-of-run scan;
- a general rollback guarantee for all product-source changes;
- safe execution of arbitrary untrusted repositories.

The real runner invokes Codex with `--dangerously-bypass-approvals-and-sandbox` and the registered project as its working directory. This permits intended source and artifact changes, but it also means the Codex process is outside the CLI approval and sandbox boundary.

Authentication plus an isolated worktree, container, VM, or staging workspace with apply-only promotion remains the production security requirement.

## Application-level boundaries

The API coordinates filesystem, database, and command access. The browser does not receive database credentials and does not read project directories directly.

`AI_SDLC_ALLOWED_PROJECT_ROOTS` limits which canonical local roots may be registered. Project and artifact path checks reject unsafe absolute/traversal/backslash/control-character forms, symlink escape, cross-owner placement, case/Unicode-equivalent collisions, and file/directory overlap. These checks reduce accidental or confused-deputy writes; they do not create an OS sandbox.

The selected native Agent directory, `ai-native.yaml`, `.ai-sdlc/`, Git control state, root Agent/environment controls, and other project-control paths receive additional protection according to the phase workspace policy.

## Initialization boundary

New-project initialization is create-only and preflights all planned destinations. It rejects an existing `ai-native.yaml`, conflicting files/directories, symlink parents, and path escape.

The initializer stages and publishes files exclusively, journals its transaction, and removes only transaction-owned unchanged files plus newly empty directories after a normal failure or cancellation. Crash recovery verifies inode and content identity before cleanup. Modified, replaced, unjournaled, or unverifiable remnants are preserved and recovery fails closed for human inspection.

This is crash-recoverable publication, not simultaneous multi-file visibility, an in-place upgrade, or a merge into an initialized project.

## Review and approval boundary

Human approval controls workflow state, not arbitrary process behavior:

- a review binds the exact artifact heads shown to the reviewer;
- a stale browser cannot approve a newer unseen revision;
- a rejected revision is not promoted by a later rerun;
- an upstream revision or rerun reopens affected downstream work;
- script-manifest approval authorizes only the exact current executable bytes;
- Release readiness prepares a human decision and grants no deployment authority.

For ordinary phases, the runner protects project controls and unselected registered artifacts and restores selected-output paths after a failed execution. Implementation intentionally allows product-source changes before human review, so approval is not a general source rollback mechanism.

## E2E authoring boundary

The Linked E2E Workspace must be explicitly selected by a human, allowed, separate from the product root, and non-nested. The platform does not infer it from a sibling path, conventional directory name, Git history, prior report, or legacy documentation.

For fresh E2E authoring, the platform:

1. copies the linked workspace into an ephemeral staging directory;
2. runs the spec-only Test Author in that staging copy;
3. permits only allowlisted test/fixture changes;
4. rejects symlinked or protected targets and validates the staged output;
5. promotes only validated allowlisted files back to an unchanged linked root;
6. enumerates the complete promoted executable suite, including unchanged files, and records exact file and aggregate hashes for human review;
7. executes approved scripts later from the linked root, not from the authoring process.

The author does not receive product implementation or exploration transcript, install dependencies, mutate Git/environment controls, configure CI, execute the generated scripts, or start detached work. This staging-and-promotion boundary is separate from the later real-browser execution boundary.

## Verification workspace policy

Verification adds a synchronous workspace mutation detector and restoration layer. It snapshots tracked and untracked files plus directory topology without relying on Git, then scans at the end of the runner window. Discovery, scan, or restoration errors fail closed.

For a supported Git repository:

- the canonical Git top level must equal the registered project root;
- the Git directory and common directory must resolve inside that root;
- the project-root `.git` state, including `HEAD`, config, index, refs, hooks, and logs, is protected;
- a `.git` pointer file is snapshot-protected;
- linked worktrees with external metadata and project roots nested below a parent repository are blocked because their mutable Git control state cannot be restored inside the registered root.

The selected Run-scoped `test-report` must be one standalone Markdown file. It must not overlap Git metadata, `ai-native.yaml`, root Agent/environment controls, `.ai-sdlc/`, `.codex/`, `.claude/`, `.github/`, runtime-evidence roots, or snapshot-excluded trees.

Verification may additionally retain writes under these project-root runtime evidence trees:

- `test-results/`;
- `playwright-report/`;
- `blob-report/`.

The byte snapshot excludes dependency, cache, build, and generated trees whose directory component is one of:

```text
node_modules  .pnpm-store  .cache  .next  .nuxt  .turbo
dist  build  target  coverage  .pytest_cache  .mypy_cache
.ruff_cache  __pycache__  .gradle  .venv  venv
```

It also excludes `.yarn/cache/` and `.yarn/unplugged/`. Ephemeral changes there may remain, but those paths are not approval evidence and must not contain authoritative source, tests, role/workflow resources, or project controls.

The same SHA-256 `workspaceRevisionToken` is supplied to the Tester prompt and execution evidence so review can bind the report to the protected pre-run worktree.

## Release workspace policy

Release uses the mutation detector with a stricter policy:

- only the selected standalone Markdown `release-runbook` is writable;
- there are no retained runtime-evidence roots;
- there are no dependency, cache, build, virtual-environment, or report exclusions;
- Git metadata and all other workspace content are protected;
- `GIT_OPTIONAL_LOCKS=0` is set;
- the default snapshot limits are 512 MiB and 200,000 entries and fail closed when exceeded.

A worktree too large for those bounds requires a separately designed isolated runner. The platform must not silently weaken Release protection.

## Process-lifetime limitation

Verification and Release forbid background or detached commands and require child processes to finish before the runner returns. Even so, these controls are not OS process sandboxes. They cannot contain a descendant that escapes supervision and writes after the end scan has completed.

For that reason, snapshot and restoration controls are defense in depth for trusted local work, not containment for hostile code.

## Definition and compatibility limitation

The platform reads most workflow configuration from the project's live `ai-native.yaml` for each action. Run creation pins task-and-Run artifact paths, but it does not freeze the complete workflow definition version.

Avoid changing workflow configuration while a Run is active. Legacy paths remain pinned until an explicit authorized backfill; the platform does not silently rewrite project-owned YAML or move evidence.

## Operator checklist

Before real execution:

- bind API and Web development servers only where intended;
- keep `AI_SDLC_ALLOWED_PROJECT_ROOTS` narrow;
- inspect the registered project path and ensure it is trusted and recoverable;
- keep production credentials and personal data out of project evidence;
- confirm that fake execution is not being treated as real evidence;
- review selected outputs and every consequential source change;
- stop if the repository uses an unsupported worktree/Git layout;
- do not rely on mutation restoration as the only recovery mechanism;
- never represent local execution as remote CI success;
- keep merge, deployment, rollback, risk acceptance, and release authorization external.

## Related documentation

- [Repository overview](../../README.md)
- [Platform operator guide](../README.md)
- [Platform runtime contract](runtime-contract.md)
- [End-to-End Workflow](../../guidelines/workflow/README.md)
- [Configuration and artifact paths](../../guidelines/configuration/README.md)
