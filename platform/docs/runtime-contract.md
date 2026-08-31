# Platform runtime contract

This document defines the behavior the self-hosted Cloud Platform adds around the canonical six-phase workflow. The primary product path is browser → remote HTTPS Git → managed snapshot → independent Run workspace; users never bind a local directory or install a client integration. Legacy local projects remain available only through compatibility APIs.

The platform coordinates server-side execution and records evidence. It does not transfer product, architecture, risk, merge, deployment, or release authority from humans to Agents.

## Work item intake is a human-confirmed boundary

A Run may start from a manual description or an operator-configured Work Item MCP Adapter. The browser can select only an Adapter ID and submit an issue reference. Executable path, arguments, MCP tool, fixed arguments, field mapping and Secret environment mapping are server-owned configuration.

The Adapter performs a bounded stdio MCP handshake and tool call, then normalizes structured output into one editable draft. The result is not workflow authority and does not start a phase. A human must review and complete the current behavior, expected behavior, scope, acceptance criteria and regression scope. Run creation freezes that confirmed Change Contract together with the external Adapter ID, external reference, fetch time and evidence fingerprint; a later Jira or Linear edit cannot silently change an existing Run.

The generic Adapter supports Jira, Linear and another issue system only when an operator installs and configures a compatible MCP server or bridge. This MVP does not claim built-in vendor OAuth or zero-configuration connectivity.

## Project Ask is outside phase execution

Project Ask is a read-only project assistant. It does not create a seventh phase, own an artifact, change role authority, or provide execution evidence. An Ask answer may explain repository content and offer a draft, but it cannot modify the repository or advance a Run.

The browser must explicitly confirm an editable draft before calling the existing Run-creation API. The resulting Run starts at the existing first phase and keeps the canonical six-phase order and role ownership. Creating a Run from Ask does not automatically execute that Run or approve any phase.

Every Ask Thread is persisted by the server and bound to one Project, Provider, public Ask revision, and raw Git source revision. A follow-up supplies only the new question and expected revision. The server reloads bounded history and the matching Project Snapshot; it never trusts browser-supplied history or silently moves an old Thread to a newly synced commit. Verified citations bind the displayed revision, complete source-file SHA-256, and exact line range.

When a user turns an old Thread into a delivery task, the editable Change Contract and new Run stay on that Thread's retained source revision. The platform must not silently substitute the Project's newest revision. If the retained snapshot is genuinely unavailable, handoff fails visibly instead of creating a mismatched Run.

## Shared workflow, different execution guarantees

Direct IDE clients and the Web platform consume the same:

- six canonical role bodies;
- fixed phase owners;
- registered artifact IDs;
- owner-aware path rules;
- role procedures and output templates.

The native client selected during legacy initialization controls the files installed for GitHub Copilot, Claude Code, or Codex discovery. Real executions started through the legacy/standalone remote Run API always use the configured Docker Codex Worker. Chat-first Agent Session phases instead inherit the selected conversation Provider and bounded server-side history through the Provider-native rooted-tool runtime; they do not invoke Codex. Legacy local projects retain the host runner for compatibility.

Only the Web platform can claim events it actually persisted, including:

- impact clearances and current-Run imports;
- artifact head and review history;
- selected-output execution contracts;
- task-and-Run path pins;
- Architecture selection checkpoints;
- legacy-local Linked E2E Workspace bindings;
- legacy-local staging-author manifests and exact-hash reviews;
- trusted command events and semantic-gate results.

A direct IDE session may follow the same artifact schema but has no Web execution contract. It uses the bounded human-supplied execution brief and registered basename paths defined by the shared workflow, and must not invent or claim Web guarantees.

## Remote project import and Control Pack

A Cloud project accepts a generic HTTPS Git URL, optional ref, and optional administrator-defined Credential Profile. The Git Broker validates exact origin, DNS addresses, ref, credential-origin binding and repository limits, then resolves one exact commit. Import and sync publish a new Project Snapshot only after DeepWiki Lite for the same revision is ready; a failed sync leaves the previous active snapshot usable.

DeepWiki Lite is a deterministic, revision-bound file map: repository/file-type scale, common entry points, documentation, test/build clues and selected important paths. It is not a full browsable semantic Wiki, vector database or complete program-understanding claim. Ask uses it as a routing clue, then builds a bounded source pack with line-level citations for the actual question.

Remote repositories do not need platform files. The API creates a versioned Control Pack under the Managed Root. Definition loading reads roles, procedures and templates from that Control Pack while resolving output paths under the Run Workspace. Platform controls therefore do not appear in the user repository or Changeset.

Each remote Run copies the selected Project Snapshot into a separate workspace, stores `baseRevision` and `definitionVersion`, and reuses that workspace for all six phases. Later syncs do not move an existing Run. Cross-Run baseline reuse reads the source Run workspace and copies approved bytes into the target Run instead of assuming every Run shares one directory.

The pinned `definitionVersion` is part of the Run's evidence. Updating the platform's bundled Control Pack does not rewrite an existing Project or Run. To use a new Control Pack version, the operator re-imports/registers the repository and starts a new Run after reviewing the change. The MVP has no silent or in-place Control Pack upgrade.

Users do not maintain one long Prompt file. At execution time the platform layers the selected role and authority limits, phase procedure, output templates, Change Contract, DeepWiki clues and approved upstream artifacts. This makes Prompt ownership and provenance clear; it does **not** promise that the final request is short. Complex artifact context has a character budget of about 180,000 and may be truncated or rejected at its bounds.

Legacy local registration and initialization remain available through compatibility APIs. Their create-only and path-safety rules are unchanged, but they are not the Cloud Web entry path.

## Provider-native, legacy Codex, and fake execution

Chat-first Agent Session phases use the Provider selected for that continuation request and a server-pinned Provider configuration snapshot. The phase receives bounded persisted conversation context and only rooted repository file tools: list, read, search, create directory, write, and apply patch. Discovery additionally exposes `write_user_stories_blocker` only when `user-stories` is a selected writable directory; the model supplies 1–20 structured missing facts and open questions in one call while the platform owns the fixed Blocker Markdown and path. Multiple questions become separate human-decision cards and are submitted as one batch; partial answers do not authorize Story materialization. Current artifact decisions are replayed losslessly from the complete Review history before optional recent feedback, and answered-Blocker enforcement is emitted from that same replay bundle; if the authoritative answers cannot fit without truncation, execution fails closed before the Provider starts. Answered Blocker scopes fingerprint each missing fact and open question so deleting or reordering an already answered subset cannot manufacture a new decision. Read and search reject symbolic links, hard-linked regular files, Git metadata, and common credential or sensitive directories. Every phase rejects writes to unselected registered artifacts and platform-control paths; Implementation's wider write surface is limited to in-scope product source, tests, and non-sensitive implementation configuration. After those same scope, protected-path, and symlink checks pass, `write_file` safely creates missing parent directories inside the authorized output so a nested Story does not fail merely because the model omitted an intermediate `create_directory`. Three consecutive non-executable tool calls still stop the loop; the public Session error points to safe advanced-audit summaries and distinguishes selected-Artifact rollback from any wider Implementation workspace changes. The runner's Artifact/control snapshots remain defense in depth rather than the primary write authorization. The phase receives no arbitrary Shell, argv/env, network tool, Provider Secret, or Desktop Figma capability. The production Chat-first wiring does not inject the optional Blueprint `run_check` runner, so a phase cannot claim that it executed tests or commands; required command evidence must remain Pending or Blocked.

Saved Provider compatibility probes retain a 60-second request timeout so a bad endpoint fails promptly. Active Provider calls default to a 180-second per-request timeout (a workflow may deliberately choose a lower bound). A Provider-native phase uses two independent monotonic deadlines: accepted model responses, completed tool results, and completed finalization checks renew a four-minute inactivity lease, while a fixed absolute ceiling never moves (30 minutes outside Implementation and 45 minutes for Implementation). Tool, repair, output, and context budgets are monotonic and never renew. Deadline checks run synchronously after awaited work as well as from timers, and a mutating tool must become quiescent before failure escapes to selected-output rollback, so event-loop delay or a late write cannot turn an expired execution into success or repopulate a restored output.

Provider-returned tool-call IDs are untrusted transport fields. Persistent events and business records use a bounded platform-generated audit ID; raw upstream IDs are not persisted. Tool arguments and results are represented by bounded summaries and one-way hashes where audit correlation is needed. The reported actual model is also untrusted metadata: it is stored only after bounded and likely-Secret validation, and an invalid value is rejected without being echoed into the Run.

A Provider no-tool response is only an attempted final, not proof that a phase is complete. Every guarded phase must update registered output, so protocols that support forced tool selection begin with `tool_choice: required`; this prevents an initial prose-only “done” from consuming a quality-repair round. If a Provider returns prose once despite a required or named choice, the platform repeats that same bounded requirement once without consuming a tool or repair round and records a safe retry event; a second omission, or a mismatched named tool, is reported as a Provider compatibility failure instead of being disguised as an Artifact error. Ollama Chat remains on native `auto` because its API does not support forced selection. Before accepting a later no-tool response, the runtime applies the same selected-output materialization and update rules used by final Artifact collection plus narrow deterministic quality contracts. Discovery `user-stories` is assessed from trusted filesystem entries rather than reparsing human-authored `## path` text from the aggregate Markdown snapshot, so README prose cannot manufacture a Story file boundary. It must contain at least one reviewable stable Story whose two distinct AC sections each own a complete Gherkin scenario, or one root structured Blocker with one standalone version-sentinel line, exact Blocked/Pending status, substantive Missing facts/open questions/human owner/next-step bullets, and no duplicate required section; an inline-code mention of the sentinel and a non-empty placeholder README are not completion. A Blocker takes precedence over stale Story files and becomes a blocking human-decision item rather than an approvable product handoff. The Story branch deliberately requires one current canonical Story instead of forcing every unchanged historical Story through the latest template during a partial update. If an output is missing, blank, unchanged when an update is required, or structurally unreviewable, the platform returns a bounded `platformFinalizationCheck` message to the same Provider loop with only safe artifact keys, repository-relative paths, stable quality issue codes, and materialization/quality requirements. Four calls inside each phase's total tool ceiling are reserved from ordinary generation for deterministic gate repair. The runtime probes the gate after every repair tool; a failed probe keeps the unused calls in the same repair round, and only an exhausted round advances to the next of at most two rounds, so a premature final cannot strand reserved capacity. On protocols that support forced selection, each correction requires a real tool: invalid Story content uses an ordered named `read_file` then `write_file` repair, while Blocker issues select the scoped structured Blocker tool by name, which renders the sentinel, Status, headings and bullets server-side. Ollama Chat receives the same trusted correction on `auto`. The loop keeps its original Provider snapshot, fixed absolute deadline, monotonic budgets, renewable inactivity lease, and partial workspace writes. Exhaustion preserves `OUTPUT_ARTIFACTS_MISSING` or `OUTPUT_ARTIFACTS_INVALID` and atomically restores every selected output to its pre-execution state. For an invalid `user-stories` result, the public failure says that the Provider attempted a write, that the result failed the reviewable-quality check, and that the rejected selected-output writes were rolled back; it must not imply that no write was attempted or that wider Implementation source changes were rolled back. Public Execution and Session projections expose only safe affected keys and allowlisted human-readable structural issue labels, never repository/server paths, rejected artifact bodies, raw Provider responses, or credentials. The Session shows the newest execution's completed tool-result count, latest safe activity, `quality check rejected → automatic repair`, and required-tool retry progress while running and after failure; it announces asynchronous review/failure states accessibly and refreshes the inline review gate. The shared Run audit derives a running label from the latest persisted execution command and translates tool/finalization events into human activity labels, so Provider-native work is never presented as Codex execution while standalone Codex Runs retain their original label.

Because Ollama Chat cannot force a required or named tool choice, a prose-only correction ends its current bounded repair round instead of renewing an otherwise unreachable tool allowance. A different successful Ollama tool still consumes tool quota but cannot advance an ordered Story repair sequence unless its actual name matches the required step.

Run detail exposes whether the server has a durable `agent_session_runs` owner. That persisted origin, not a browser query parameter, selects the execution path. An incomplete Session-owned Run can still be read and may expose only the review or structured-decision mutations allowed by its current phase state, while generic phase execute and Codex-only E2E author/run endpoints reject it with 409; continuation must use the Session-scoped advance contract so Provider choice, bounded history, optimistic phase identity, and the Session lock cannot be bypassed by removing a URL parameter. Once a Session-owned Run is completed, every mutation surface is closed: human Artifact revisions, Reviews and decision capture, Architecture selection, E2E script review, execution, retry, and advance all reject the request. Artifact, Review, event, Changeset, and Patch reads remain available. This completion lock does not change standalone Run behavior.

Real jobs started through the legacy/standalone remote Run API require an administrator-approved `AI_SDLC_WORKER_IMAGE` **and** an exact match between the imported repository URL and one entry in `AI_SDLC_REAL_EXECUTION_TRUSTED_REPOSITORIES`. Import permission does not grant execution permission; an empty execution list denies every legacy real phase. Missing or invalid Docker/trust configuration fails closed and never falls back to host execution. The Worker has a read-only root filesystem, non-root uid/gid, dropped capabilities, no-new-privileges, PID/CPU/memory limits, bounded tmpfs, a writable repository mount, read-only Git metadata and Control Pack, and no Docker socket or Git/DB/platform credential. Legacy local real jobs still use `AI_SDLC_CODEX_BIN` on the host.

`AI_SDLC_MAX_CONCURRENT_PHASES` is a process-local safety cap and defaults to `1`. An excess real-phase request receives 429; the MVP does not enqueue it. Durable queueing, pause/cancel, restart continuation and coordination across multiple API instances are not supported, so only one API instance may operate a Managed Root.

Before each legacy/standalone Codex phase run, the execution dialog reads the account- and project-scoped Codex model catalog. The user chooses a supported model and reasoning effort for that execution. The resolved values are passed to `codex exec`, stored with the execution, and shown in its timeline. Chat-first continuation instead uses the Session Provider selector and records the actual Provider-returned model only after a successful completion.

Optional Codex compatibility controls are:

- `AI_SDLC_CODEX_MODELS`;
- `AI_SDLC_CODEX_REASONING_EFFORTS`;
- `AI_SDLC_CODEX_DEFAULT_MODEL`;
- `AI_SDLC_CODEX_DEFAULT_REASONING_EFFORT`.

`AI_SDLC_CODEX_FAKE=1` is for tests and deterministic demonstrations. Fake output may exercise state transitions and artifact handling, but it cannot satisfy a real Implementation, Verification, or Release evidence requirement.

## Artifact identity, paths, and selected outputs

Artifact ID is the stable identity. Physical paths are resolved from `ai-native.yaml`, the artifact owner's role config, and the active execution contract. They must stay beneath `paths.outputs`, inside the owner's configured namespace where one exists, outside project-control and native Agent paths, and non-overlapping with other artifacts.

For platform-created Runs, the following physical files are pinned with a safe task title and full Run ID:

- `change-contract`;
- `design-spec`;
- all seven engineering evidence artifacts;
- `test-report`;
- `release-runbook`.

The pin survives failures and reruns even if a configured default basename changes later. A rerun replaces only selected artifact heads and carries forward the latest unselected heads. The runner snapshots other registered artifacts and project controls and rejects or restores unauthorized changes according to the applicable workspace policy.

Older persisted paths are not silently migrated. If two pre-upgrade Runs share one legacy `test-report` path, do not rerun Verification for either Run until an authorized explicit backfill gives each Run a separate pinned report path.

## Human revisions and downstream invalidation

The following human-revision contract remains available to standalone Runs and to an incomplete Session-owned Run only when its current workflow state permits the mutation. A completed Session-owned Run is immutable and cannot be reopened through an Artifact edit, Review, structured decision, Architecture selection, or E2E script approval. An allowed save:

1. checks the expected current content hash;
2. writes the registered project file;
3. appends a new immutable revision;
4. marks the previous head superseded;
5. reopens the phase and invalidates affected downstream approvals.

Directory artifacts are edited through their aggregated relative-path sections while preserving the file list. A stale browser cannot approve an unseen newer head because reviews bind the exact artifact head IDs shown to the reviewer.

The Run-level **Decisions and follow-ups** inbox distinguishes:

- a decision only a human can make;
- incomplete work that stays with the current role;
- a dependency that must return to an upstream phase.

A human answer is stored in review history and reopens the owning phase. The item closes only when the owner updates the formal artifact; a review comment alone does not silently clear a gate. Completed Session-owned Runs expose this history read-only and reject new answers.

## Design outputs and Figma

Desktop Figma MCP is a legacy-local capability. Cloud Run endpoints reject it because the API deployment cannot borrow an operator desktop seat or local connector. A future server-side Figma integration needs its own service credential, file-authorization and audit design.

The remaining Figma rules in this section describe that legacy-local path; they are not Cloud feature claims.

The first Design execution includes the required `design-baseline` and `design-spec`. A user may additionally select a self-contained `design-prototype` HTML file and `figma-handoff`. Later runs may select only outputs that need regeneration.

Prototype preview uses a unique-origin sandbox. Scripts, external resources, forms, popups, embedded frames, objects, and top-level navigation are disabled; the original source remains reviewable.

Figma output is available only when the project-scoped Codex context reports an accessible Codex Desktop Figma connector or official Figma MCP connection. The user must select a writable plan/new private Draft or provide the canonical URL of an existing writable Figma Design file. The platform does not guess a plan or fabricate a URL.

Figma success requires a completed design mutation against the selected file plus matching file/node evidence in `figma-handoff`. Credential presence or an empty created file is not proof of completed work. The browser receives normalized readiness and plan capabilities, not raw connector responses or account credentials.

## Architecture checkpoint

Full Architecture uses separate review moments:

1. Resolve concrete blocking decision cards.
2. Run the bootstrap execution for the index, discovery context, and Options.
3. Let a human select one current option against the exact Options revision.
4. Run the selected-state continuation for C4, ADR, pattern, NFR, and adversarial evidence.
5. Review and accept the completed pack separately.

Selecting an option is not final Architecture approval. A changed rulebook digest, checkpoint revision, or blocking rule invalidates the old selection evidence.

## Implementation review

Software Engineer changes the real repository and emits the seven registered engineering evidence artifacts. Platform approval checks current source and evidence rather than treating Markdown as implementation.

The gate rejects unfinished tasks, missing or failed command evidence, unresolved severe or security findings, incomplete adversarial review, weak provenance, contradictory publication claims, and stale upstream inputs. Tier C or Limited independent-test isolation stays blocked unless the human review contains the complete scoped exception contract and compensating evidence. Artifact prose cannot grant its own exception.

Passing Implementation unlocks Tester. It does not publish or merge a pull request.

## Verification and Linked E2E

Chat-first Provider-native Verification can inspect repository test sources and existing evidence, but the current production tool host cannot execute commands. Any acceptance criterion that requires fresh command or browser evidence therefore remains Pending or Blocked rather than being reported as passed.

Verification started through the legacy/standalone remote Run API runs the normal Tester phase inside the Run Worker and may execute only the tests, scripts and browser harness already present in the imported repository. It records that repository's test evidence; it does not create or bind another local test repository. If acceptance requires durable browser evidence and the repository does not already provide a runnable suite in the Worker, Tester must mark the requirement Blocked rather than claim success.

The complete Linked E2E flow below is a **legacy-local-only** capability. Cloud Run endpoints reject it because it depends on a second operator-local directory and browser installation. A completed Session-owned Run also rejects E2E script review explicitly; a completion-state mutation cannot be smuggled through a legacy-local review route. A future managed browser-worker design is required before Cloud can claim these guarantees.

Tester first maps acceptance criteria, regressions, deferred Design checks, NFRs, and risks to the strongest appropriate evidence. A criterion proven more directly by unit, integration, or contract testing need not become E2E.

When durable E2E is required, the Web contract is:

1. A human explicitly binds a separate, non-nested Linked E2E Workspace. The platform never scans for or adopts a sibling or legacy repository.
2. Structured preflight validates the binding, package manager and script identifiers, Playwright package, configured Chromium executable and real launch probe, product start script, loopback target, evidence paths, and cleanup capability.
3. Playwright MCP may be used for transient exploration. Its transcript, DOM dump, and generated actions do not enter the Test Author context and cannot satisfy the gate.
4. The platform freezes spec-only AC and risk intent.
5. The platform copies the linked workspace to an ephemeral staging workspace and starts a fresh Tier A/B Test Author there.
6. The author sees only approved behavior, frozen intent, and the minimum public harness. It may change only allowlisted test and fixture paths and does not execute the new scripts.
7. The platform validates the staged changes and promotes only the validated allowlisted files back to the unchanged linked root. Product files and control paths remain protected.
8. From the linked root, the platform enumerates and re-hashes the complete promoted executable suite, including unchanged test and fixture files. A human approves that exact baseline and aggregate hash; any relevant byte, file set, binding, product revision, or E2E revision change invalidates approval.
9. After script approval, the platform supervises the product server and runs fixed-argv standalone Playwright from the linked root with the configured real headless Chromium.
10. Tester records product/E2E revisions, trusted command and cwd, exit result, cleanup, and report/trace/screenshot/video/log hashes in the Run-scoped `test-report`.

Script approval authorizes only execution of those exact bytes. It does not approve Verification, CI policy, merge, risk, or Release. A local pass is not a remote CI pass.

Product source, product-repository tests, and testability interfaces remain Software Engineer-owned. A defect in those assets returns through Implementation evidence refresh and reapproval. A linked test-script defect stays in the staging-author, promotion, complete-baseline-review, and standalone-execution loop.

An authorized human or repository/provider system configures credentials, browser provisioning, retention, branch protection, CI policy, and required checks. Tester supplies the command/evidence contract; DevOps may record the expected required-check name and missing provider evidence in the runbook but does not configure it.

## Release readiness

DevOps consumes the current Change Contract, applicable accepted Architecture evidence, `implementation-notes`, `engineering-provenance`, and `test-report`, then prepares only the Run-scoped `release-runbook`.

The Web Release gate requires a real execution and re-resolves current approved input heads. The runbook must bind:

- the exact Run ID;
- every selected artifact ID, project-relative path, and platform-recorded SHA-256;
- source/product revision and build or release identity;
- provenance and supply-chain applicability;
- preconditions and ordered rollout;
- health, smoke, and monitoring signal/threshold/window/owner/action;
- rollback trigger, RTO, data compatibility, recovery, and verification;
- incident escalation, risks, blockers, and the named human release owner.

Fake or legacy runner executions, stale inputs, placeholders, missing evidence, and claims that preparation executed an external action are rejected. Passing means only `Ready for human go/no-go`.

DevOps does not configure CI or required checks, use secrets, change branch policy, commit, push, publish or merge a PR, deploy, roll back, publish a release, accept risk, or decide go/no-go. Those actions require a separately authorized human or external system.

## Workspace retention and pruning

Project sync never changes an old Ask Thread or Run, so any snapshot referenced by one of them remains retained. A successful Run workspace is also retained as the source of artifacts, Changeset and Patch. The MVP does not automatically archive or delete successful Runs.

The operator-only prune endpoint removes only sufficiently old, inactive Workspace records that have no current Project, Ask Thread or Run reference. `olderThanHours` and `limit` bound each pass. Operators must call it with Bearer authentication, inspect a `dryRun:true` result first, then opt into `dryRun:false`. Run one API instance and avoid imports, Run creation, phase execution or parallel maintenance during the pass. This is crash-remnant cleanup, not distributed garbage collection or a replacement for hard filesystem quotas.

## Related documentation

- [Repository overview](../../README.md)
- [Platform operator guide](../README.md)
- [Platform security model](security-model.md)
- [End-to-End Workflow](../../guidelines/workflow/README.md)
- [Configuration and artifact paths](../../guidelines/configuration/README.md)
- [Role and Prompt layers](../../guidelines/roles/README.md)
