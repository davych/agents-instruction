# Platform security model

This document describes the current self-hosted Cloud MVP security boundary. It is not a production multi-tenant security claim.

For installation and operator commands, see the [Platform README](../README.md). For workflow behavior, see the [runtime contract](runtime-contract.md).

## Supported trust model

Use the Cloud MVP only when all of these conditions hold:

- one trusted operator controls the deployment, access token, Git allowlist and Worker image;
- users of this deployment belong to the same trust domain;
- project state is disposable or otherwise recoverable;
- the Managed Workspace Root is a dedicated, recoverable directory;
- the operator understands that real model execution sends required task context to the configured model service;
- consequential changes remain subject to explicit human review.

The repository itself is always treated as untrusted Prompt/data input. Import is allowed only by the Git Origin policy. The standalone legacy Run/Codex execution path has a second, narrower gate and requires the repository's exact URL in `AI_SDLC_REAL_EXECUTION_TRUSTED_REPOSITORIES`; that entry means the single trusted operator has reviewed the execution risk, not that every future commit or dependency is safe. Chat-first Agent Session phases do not use that Codex/Worker gate: the trusted API calls the selected Provider and applies rooted file tools directly to the already materialized Session Workspace. Those tools do not execute repository code, but they are also not a container or hostile-code isolation boundary. Do not offer this MVP to mutually untrusted tenants.

## Explicitly missing boundaries

The current platform does not provide:

- user accounts, organization membership, RBAC, per-user authorization or token rotation UI;
- tenant isolation;
- VM/microVM-grade isolation for Codex or its child processes;
- a durable distributed job queue, phase pause/cancel, or multi-node Workspace coordination;
- safe horizontal API scaling against one Managed Root; the Cloud MVP supports one API instance;
- a network egress policy;
- short-lived model-credential proxying, per-Run spend quotas, or automatic secret scanning of model context and generated changes;
- containment for escaped background or detached descendants after the end-of-run scan;
- a hard per-Worker writable-repository disk quota supplied by the application;
- automatic retention/deletion policy for successful Run workspaces;
- a general rollback guarantee for all product-source changes;
- automated push, PR, merge, deployment or release authority.

The deployment-level Bearer Token prevents anonymous use but every holder has the same authority, including changing instance-wide Provider endpoints and credentials. It is a bearer secret, so remote traffic must use HTTPS.

There are two different real execution boundaries:

- **Chat-first Agent Session:** the trusted API invokes the selected configured Provider and exposes only bounded, repository-relative list/read/search/create-directory/write/patch tools. Reads and searches reject symlinks, hard-linked files and common sensitive directories. Writes reject unselected registered artifacts and platform-control paths in every phase; Implementation may edit only the remaining in-scope product source, tests and non-sensitive implementation configuration. Provider credentials stay inside the Provider registry/Vault and are never placed in the Workspace, model-visible tool arguments, phase instruction, browser response or execution record. This path has no arbitrary Shell, process, network, Desktop Figma or Codex E2E author/run tool. The production wiring currently supplies no isolated `run_check` implementation, so it cannot run repository tests or claim fresh command/browser evidence. Verification can inspect files and update its report, but must remain Pending/Blocked when acceptance requires trusted execution or provenance evidence.
- **Standalone legacy Run/Codex:** remote real execution invokes Codex only inside the constrained Docker Worker and still requires the execution trust allowlist. The Worker is non-root, has a read-only root filesystem, dropped capabilities, no-new-privileges, resource limits, bounded tmpfs and exact mounts. It still has model/network egress and a writable Run repository; malicious code can intentionally fill that writable filesystem until the Host quota is reached.

A compromised trusted API is host-significant on either path. A kernel/container escape, allowed-network abuse, or unlimited writes within a poorly provisioned filesystem is outside this MVP's guarantee. Production hostile-code service requires microVM/VM isolation, egress enforcement, hard per-Run quotas and per-tenant identity.

## Application-level boundaries

The API is a trusted coordinator. The browser receives only Public Project DTOs and never receives database credentials, Git secrets or host Workspace paths. Non-loopback binding is refused without a strong deployment token, and CORS uses exact configured Origins. Compose publishes Web on `127.0.0.1` by default. Remote access must keep that loopback binding, terminate TLS in a reverse proxy, and configure the exact `https://...` Origin; plain HTTP would expose the Bearer Token and is not a supported remote deployment.

Cloud startup proves that the Managed Root can create, read and delete a private sentinel, reaches the Docker Server Version, and resolves an administrator-built image carrying `com.ai-sdlc.worker=true`. Real mode cannot skip this preflight because the standalone compatibility path remains available; passing it does not mean Chat-first Provider-native phases execute in that Worker. The Compose API healthcheck starts Web only after the API has passed these gates and migrations.

The trusted API holds database access, Git Broker credentials and—when deployed by Cloud Compose—the Docker socket. Compromise of the API is therefore host-significant. The Docker socket is never mounted into a Worker. Put the API on a dedicated host or VM, restrict who can reach it, and do not add repository-selected Docker flags, mounts or images.

Remote Git accepts HTTPS only. URL userinfo, query, fragment, alternate protocols and dangerous refs are rejected. Repository origins are exact-allowlisted; DNS answers are checked against loopback, private, link-local and reserved ranges by default and pinned into the Git transfer configuration. Redirects, hooks, submodule recursion and LFS smudge are disabled. Git uses a blobless fetch and checks the revision tree's file count before checkout. Time and process-output limits fail closed.

`AI_SDLC_GIT_MAX_REPOSITORY_BYTES` is checked **after materialization**. It is an acceptance gate for the finished snapshot, not proof that Git or checkout never used more temporary disk space. A deliberately compressed or otherwise expensive repository can consume transient space before the application measures it. Put `AI_SDLC_MANAGED_WORKSPACE_ROOT` on its own filesystem/volume with an operating-system or storage-level hard capacity quota; do not place it on `/`, a home directory, or a shared business-data volume. Capacity monitoring and reserve space remain operator responsibilities.

Credential Profiles bind one exact origin and keep the secret in a separate server environment variable, never in a Project row, argv, Prompt, Worker or browser response. Import permission is separate from execution permission. Standalone remote Run/Codex phases require both an administrator-approved `AI_SDLC_WORKER_IMAGE` and an exact full repository URL in `AI_SDLC_REAL_EXECUTION_TRUSTED_REPOSITORIES`; the empty list denies that compatibility path. Chat-first phases instead require an enabled Provider with a configured model and verified native tool calling, and do not receive Git credentials or the Provider credential itself. Use a dedicated low-quota, quickly rotatable model key for Workers.

Cloud project paths are restricted to the dedicated Managed Root and are never supplied by the browser. `AI_SDLC_ALLOWED_PROJECT_ROOTS` applies only to explicit `legacy-local` compatibility APIs. Project and artifact path checks reject unsafe absolute/traversal/backslash/control-character forms, symlink escape, cross-owner placement, case/Unicode-equivalent collisions, and file/directory overlap. These checks reduce accidental or confused-deputy writes; they do not create an OS sandbox.

The selected native Agent directory, `ai-native.yaml`, `.ai-sdlc/`, `.agents/`, `.codex/`, `.claude/`, Git control state, root Agent/environment controls, and other project-control paths receive additional protection according to the phase workspace policy. Provider-native tools deny these write targets before filesystem mutation and reuse Artifact/control snapshots and rollback guards as a second layer. Non-Implementation roles can write only their selected registered outputs; Implementation receives a broader in-scope product-source surface but still cannot write an unselected registered artifact or any control path. Remote Codex starts with its primary working directory outside the repository, receives `/workspace` only as an explicit writable directory, and disables user/repository project-doc and rule discovery. Repository-native Skills and Agent files are data, not platform instructions, and are excluded from Cloud Changesets.

Provider-native finalization is also fail closed. A no-tool model response is checked against every selected output before it is accepted, including the narrow `user-stories` contract: at least one canonical Story with two AC-owned complete scenarios, or one uniquely versioned root Blocker whose required sections contain substantive bullets. Sentinel/Blocker intent takes priority over stale Story files, and a valid Blocker is projected into the human gate so “reviewable” cannot become accidental approval. An incomplete or unreviewable attempt receives at most two platform-authored correction messages inside the same bounded loop; these contain only registered artifact keys, repository-relative paths, and materialization/quality rules, never an absolute Host path, artifact body, or raw Provider body. Corrections do not renew the wall-clock deadline or tool budget. Persistent failure rolls back all selected outputs, and user-visible errors retain only safe affected keys plus that rollback fact.

Real phase capacity is process-local and defaults to one through `AI_SDLC_MAX_CONCURRENT_PHASES=1`. Excess starts receive 429 rather than entering a durable queue. There is no cross-process lock or cancellation protocol, so running more than one API instance against the same database/Managed Root is unsupported.

## Work Item MCP boundary

Work Item MCP commands are installed and selected by the trusted operator. A browser cannot provide a command, argv, tool name, fixed argument, field mapping or environment name. Each command is an absolute path launched with `shell:false`; only a small environment allowlist and explicitly mapped Secret values enter the child. MCP stdout/stderr, time, individual protocol messages and concurrent child count are bounded, and stderr is discarded because it may contain a Secret or host path.

With Compose, the operator installs fixed-version Adapter binaries below `AI_SDLC_MCP_BIN_ROOT`; the directory is mounted read-only at `/opt/ai-sdlc/mcp-bin` in the API container. Repository content cannot replace these binaries. On timeout or disconnect the API waits for process close, escalates termination when needed, and keeps the concurrency slot until the child is actually gone. These controls do not make a third-party Adapter trustworthy; review and pin its source and checksum.

Jira, Linear and other issue content is untrusted external data. It is normalized through explicit field mappings, shown to a human for editing, and stored only after Run confirmation with a source fingerprint. It cannot replace the Control Pack, change the six phases or role owners, choose a Worker image, grant repository writes, approve an artifact or authorize push/merge/deploy/release. An Adapter summary saying `configured` means only that required server configuration and Secret references are present; reachability is proven only by a real resolve call.

## Project Ask boundary

Project Ask is a read-only application feature and is not a workflow execution role. Its model request has no shell, filesystem-write, Git, publishing, deployment, or phase-execution tool. Repository files and user messages are treated as untrusted data; instructions found in a README, Agent file, code comment, or earlier answer cannot expand Ask authority.

The API performs bounded repository retrieval itself. In Git projects it limits the corpus to tracked and non-ignored untracked files, then additionally skips symlinks, repository control data, dependency/build/cache trees, common secret and credential files, binary content, and oversized files. It sends only selected text excerpts to the configured model endpoint. Each excerpt is bound to a repository revision, relative path, line range, and content hash, and only server-issued source IDs can be displayed as verified citations.

Provider endpoints, protocols, models, and credentials are instance-wide operator configuration stored in an API-only encrypted filesystem Vault, not Provider-specific environment variables. A holder of the deployment Bearer Token may submit a replacement credential through the Web settings API, but no read response returns that credential or the complete endpoint. Ordinary Ask, DeepWiki and Agent requests can select only an enabled Provider ID and cannot override its endpoint, key or protocol.

The Vault uses authenticated encryption and keeps its master key separate from its ciphertext below the dedicated Managed Root. Both files are private API state, written with restrictive permissions and atomic replacement. Authentication failure, malformed state, or a missing key for existing ciphertext fails closed instead of creating an empty replacement. This protects backups or storage copied without the key; it does not protect against a compromised API process, Host root, debugger, malicious Provider endpoint, or someone who obtains both files. Back up, restore and rotate the pair as one security-sensitive unit. This Cloud MVP supports one API process and one shared set of four Provider slots; it has no per-user secret ownership, enterprise KMS, or cross-replica coordination.

The fixed OpenAI slot accepts only the official `https://api.openai.com` origin; an OpenAI-compatible proxy belongs in the Custom slot so audit records do not mislabel it as OpenAI. Other remote Provider endpoints require HTTPS. Plain HTTP is accepted only for explicitly allowed API-local or trusted Host-gateway development services. That opt-in removes transport encryption for selected excerpts, so it must not cross an untrusted network. Endpoint validation rejects URL credentials, query, fragment and high-risk literal destinations, but this is not a general outbound proxy or complete DNS-rebinding defense; deployment-level egress policy is still required for hostile environments. API keys, ciphertext, authorization headers and raw upstream error bodies are never returned to the browser, written to Ask history, sent to a phase Worker, or included in sanitized errors.

Choosing OpenAI or a remote custom endpoint sends selected repository excerpts outside the local machine. The operator is responsible for the endpoint's retention, training, regional processing, and access policies. LM Studio and Ollama remain local only when their configured endpoints are actually loopback addresses; changing them to a remote HTTPS service changes the real data boundary even if the Provider label is unchanged.

Cloud Ask Threads and messages are stored in PostgreSQL. The server fixes the Provider and raw source revision at Thread creation, reconstructs bounded history itself, and resolves old Threads through the matching retained Project Snapshot. This gives refresh continuity and revision integrity, but it is still a single-tenant record store without per-user privacy or retention controls.

Provider tool-call IDs and reported model identifiers are also untrusted upstream data. The API does not persist an upstream-supplied call ID verbatim in events, logs, or workflow business records; it records a bounded platform audit ID and one-way argument/output hashes instead. An actual model identifier is recorded only after bounded validation and a likely-Secret check; a secret-like value fails the phase without echoing that value. This prevents Provider-controlled metadata from becoming durable log content or an apparent platform authority token.

The old stateless Ask endpoint remains only for `legacy-local` compatibility. Remote Cloud projects must use a server-owned Ask Thread, so the browser cannot supply authoritative history or select a host path. Desktop Figma discovery is likewise hidden from the global Cloud surface and run-scoped calls reject remote projects.

## Initialization boundary

New-project initialization is create-only and preflights all planned destinations. It rejects an existing `ai-native.yaml`, conflicting files/directories, symlink parents, and path escape.

The initializer stages and publishes files exclusively, journals its transaction, and removes only transaction-owned unchanged files plus newly empty directories after a normal failure or cancellation. Crash recovery verifies inode and content identity before cleanup. Modified, replaced, unjournaled, or unverifiable remnants are preserved and recovery fails closed for human inspection.

For remote Cloud projects, raw initializer errors are server diagnostics only. The HTTP response is one fixed Control Pack failure and AppError details are omitted unless the error code has a closed public schema; unknown and nested path, token, key, command and Error-object details are not serialized.

This is crash-recoverable publication, not simultaneous multi-file visibility, an in-place upgrade, or a merge into an initialized project.

## Review and approval boundary

Human approval controls workflow state, not arbitrary process behavior:

- a review binds the exact artifact heads shown to the reviewer;
- a stale browser cannot approve a newer unseen revision;
- a rejected revision is not promoted by a later rerun;
- an upstream revision or rerun reopens affected downstream work;
- script-manifest approval authorizes only the exact current executable bytes;
- Release readiness prepares a human decision and grants no deployment authority.

Completion is an additional server-side authorization boundary for Session-owned Runs. After the durable Run state is `completed`, every mutation endpoint rejects human Artifact revisions, Reviews and structured decisions, Architecture selection, E2E script review, execution, retry, or advance. The completed audit remains readable. This rule is scoped to Session-owned Runs and does not silently change standalone Run semantics.

For ordinary phases, the runner protects project controls and unselected registered artifacts and restores selected-output paths after a failed execution. Implementation intentionally allows product-source changes before human review, so approval is not a general source rollback mechanism.

## Changeset boundary

For a remote Run, the API builds a Changeset against the Run's pinned `baseRevision` with a temporary Git index and quarantined object directory. It covers tracked, untracked, deleted, renamed and binary changes without modifying the real index or object store. Control Pack and runtime-report roots are excluded, patch bytes and manifest are bounded and SHA-256-bound, and the authenticated browser may download the patch. The platform does not apply it to another checkout or push it to any remote.

## E2E authoring boundary（legacy-local only）

Chat-first Cloud Verification currently cannot run test commands or browser suites because its Provider-native tool host has no production `run_check` runner, arbitrary Shell, browser or Codex E2E author/run action. It may inspect existing test sources and update the selected Test Report, but must report Blocked whenever approval requires fresh command, browser or provenance evidence. A standalone remote Run may execute repository-owned checks in its constrained Codex Worker, but it does not author a second Playwright repository or attach an operator-local browser. The rest of this section describes the retained `legacy-local` linked-E2E capability.

The Linked E2E Workspace must be explicitly selected by a human, allowed, separate from the product root, and non-nested. The platform does not infer it from a sibling path, conventional directory name, Git history, prior report, or legacy documentation. Session-owned Runs cannot use this legacy-local author/run path, and a completed Session-owned Run also rejects script-manifest review so completion cannot be reopened through an E2E approval endpoint.

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

Verification adds a synchronous workspace mutation detector and restoration layer on both paths. It snapshots tracked and untracked files plus directory topology without relying on Git, then scans at the end of the execution window. Discovery, scan, or restoration errors fail closed. This protects workspace integrity; it does not prove tests ran. On the Chat-first path the rooted tools expose only the selected report as writable and no check runner is wired, so runtime-evidence directories are not fresh Provider-native execution evidence.

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

The standalone Codex Verification and Release paths forbid background or detached commands and require child processes to finish before the runner returns. Even so, these controls are not OS process sandboxes. They cannot contain a descendant that escapes supervision and writes after the end scan has completed. Chat-first Provider-native tools do not expose process creation at all.

For that reason, snapshot and restoration controls are defense in depth for trusted local work, not containment for hostile code.

## Definition and compatibility limitation

Remote projects use a server-managed Control Pack outside the repository. Run creation pins both the exact Git `baseRevision` and the Control Pack `definitionVersion`; repository text cannot replace the six-phase order, role ownership, output authority or Worker configuration. Legacy local projects still read their live `ai-native.yaml`, so changing it while a legacy Run is active remains unsupported.

An existing remote Project and every existing Run keep their pinned version when the platform's bundled Control Pack changes. There is no silent in-place upgrade or automatic migration. To adopt a new version, re-import/register the repository as a new Project and create a new Run after reviewing the new controls; old evidence remains bound to the old version.

Project Snapshots are knowledge sources. Every remote Run receives a different exact-revision Workspace, and cross-Run reuse resolves the source Run Workspace explicitly. A Project sync never changes an older Run or Ask Thread. Retained snapshots referenced by Ask Threads and Run workspaces must not be manually removed from disk.

DeepWiki Lite is a bounded, deterministic map of one revision's files, file types, common entries, docs, tests/build clues and selected paths. It is not a complete browsable semantic Wiki, vector database, or proof that an absent fact does not exist. Ask performs a separate bounded retrieval and validates only that citations point at server-issued excerpts.

The platform owns Prompt assembly, so repository users do not maintain a long `CLAUDE.md`. This reduces configuration drift but does not promise a short final model request: the runtime layers role limits, phase procedure, artifact templates, task data, DeepWiki clues and approved upstream artifacts. Complex artifact context may use a character budget of roughly 180,000 before truncation/failure. Repository content inside that envelope stays untrusted data.

## Workspace lifetime and operator prune

Successful Run workspaces are retained because artifacts, Changesets and downloadable patches refer to them; the MVP does not automatically archive or delete them. Project snapshots and failed/provisioning remnants may also accumulate after a crash.

The authenticated `POST /api/operator/workspaces/prune` endpoint considers only old, inactive Project-snapshot or Run workspaces with no database reference. It preserves the active Project snapshot, every Ask Thread's source revision, every Run workspace, and any operation currently preparing/importing. Use `dryRun:true` first, operate one API instance only, and do not run prune concurrently with imports, Run creation, phase execution or other maintenance. The service checks references again before deletion, but it is not distributed garbage collection and cannot protect against manual filesystem deletion.

The prune endpoint is not a disk quota. Put the Managed Root on a dedicated hard-quota filesystem, monitor it, back it up as required, and schedule deliberate retention decisions for successful Runs.

## Operator checklist

Before real execution:

- keep Compose bound to loopback; terminate TLS in a reverse proxy, use a long random `AI_SDLC_ACCESS_TOKEN`, and configure the exact HTTPS CORS Origin;
- keep the Git Origin allowlist and Credential Profiles as narrow as possible;
- dedicate and back up the Managed Workspace Root, and put it on a filesystem/volume with a hard capacity quota; preserve the Provider Vault key and ciphertext as one restricted pair;
- give the deployment Bearer Token only to people allowed to replace every instance-wide Provider endpoint and credential;
- build and pin an administrator-reviewed Worker image for standalone legacy Run/Codex execution;
- list only reviewed exact repository URLs in `AI_SDLC_REAL_EXECUTION_TRUSTED_REPOSITORIES` and give standalone Workers a low-quota, rotatable model key;
- treat the API Host as the Chat-first execution boundary; keep Provider Vault material out of Workspace files and do not claim Provider-native test/browser evidence until an isolated approved check runner is wired;
- run one API instance and keep the real-phase concurrency cap at a capacity the Host can sustain;
- install reviewed, fixed-version MCP binaries through the read-only `/opt/ai-sdlc/mcp-bin` mount;
- protect the trusted API host and its Docker socket;
- keep production credentials and personal data out of project evidence;
- confirm that fake execution is not being treated as real evidence;
- review selected outputs and every consequential source change;
- stop if the repository uses an unsupported worktree/Git layout;
- do not rely on mutation restoration as the only recovery mechanism;
- never represent local execution as remote CI success;
- dry-run Workspace prune first, avoid maintenance races, and do not expect it to delete successful Runs;
- keep merge, deployment, rollback, risk acceptance, and release authorization external.

## Related documentation

- [Repository overview](../../README.md)
- [Platform operator guide](../README.md)
- [Platform runtime contract](runtime-contract.md)
- [End-to-End Workflow](../../guidelines/workflow/README.md)
- [Configuration and artifact paths](../../guidelines/configuration/README.md)
