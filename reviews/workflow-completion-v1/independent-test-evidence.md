# Workflow completion V1 — Independent test evidence

## Verdict

The final local snapshot passes the initializer, Contracts, API, Web, typecheck, build, packaging, and repository-diff gates. The platform suites contain 848 passing tests in total. This evidence supports the documented local/trusted V1 boundary; it does not certify an unauthenticated, non-isolated runner for untrusted projects or prove remote provider state.

## Independence and traceability

The workflow-completion acceptance tests were authored in a separate spec-first session from `changes/workflow-completion-v1/delta.md`, before inspecting the corresponding implementation changes. They record Isolation Tier A and cover:

- generic versus authoritative acceptance criteria;
- Release semantic evidence, stale Run/input bindings, monitoring, rollback, authority forgery, and digest claims;
- fake/real Release completion and persistence rollback;
- bounded prompt manifests and explicit preview truncation;
- Release and Verification mutation restoration;
- Web initialization for three clients and all six roles.

Durable test sources:

- `platform/apps/api/checks/engineering-authority.acceptance.check.ts`
- `platform/apps/api/checks/release-evidence-validator.acceptance.check.ts`
- `platform/apps/api/checks/workflow-completion-runner.acceptance.check.ts`
- `platform/apps/api/checks/workflow-completion-service.acceptance.check.ts`

Additional adversarial tests cover definition/path boundaries, DevOps capability impersonation, legacy Release paths, platform-injected output collisions, initializer abort/crash recovery, Web response parsing, review exits, responsive containment, and route context.

## Final command ledger

All commands ran from the final integrated working tree on 2026-08-25.

| Scope | Command | Result |
|---|---|---|
| Initializer syntax | `node --check bin/cli.js` | Pass |
| Initializer and canonical templates | `npm test` | 33/33 pass |
| Contracts | `yarn workspace @ai-sdlc/contracts test` | 24/24 pass |
| Web | `yarn workspace @ai-sdlc/web test` | 90/90 pass |
| API | `yarn workspace @ai-sdlc/api test` | 734/734 pass |
| Platform aggregate, parallel | `yarn test` | 848/848 pass |
| Platform types | `yarn typecheck` | Pass |
| Production builds | `yarn build` | Pass; Vite retains a non-blocking existing chunk-size warning |
| Package contents | `npm pack --dry-run --cache /private/tmp/ai-sdlc-npm-cache-final` | Pass; 85 files in the initializer-only dry-run tarball, including the packaged prompt-eval and SDLC-map reports |
| Patch hygiene | `git diff --check` | Pass |
| Removal audit | `git diff --name-status --diff-filter=D` | No tracked deletions |

An intermediate full API run exposed two old unit fixtures that copied the fresh `ai-native.yaml` capability declaration without installing its DevOps V1 pack. Production correctly failed closed. The fixtures were explicitly made legacy/minimal, the final loader/fake/legacy replay passed 33/33, and the full API and aggregate suites were rerun to the final counts above. No production gate was weakened.

### Clean-checkout CI regression

The failed PR #6 platform job was reproduced from its Actions log: `@ai-sdlc/contracts` exposes runtime JavaScript from `dist/index.js`, while type declarations resolve from `src/index.ts`; therefore `yarn typecheck --noEmit` passed in a clean checkout but could not supply the runtime file required by API tests. The platform test command now builds Contracts before starting the parallel workspace tests.

Positive evidence used two independent clean-state replays:

- The integrated workspace began with `packages/contracts/dist/index.js` absent. `yarn typecheck` passed and left it absent, then `yarn test` built it and passed Contracts 24/24, Web 90/90, and API 734/734 (848/848 total); `yarn build` subsequently passed.
- A separate repository copy excluded `.git`, `node_modules`, and every `dist`, ran `yarn install --immutable`, confirmed the Contracts runtime was absent, then passed `yarn test` 848/848 and `import("@ai-sdlc/contracts")`.

The full replay also exposed a pre-existing test-only scheduling race: an orphan-process cleanup check allowed only 40 × 10 ms for two nested Node processes to become ready. The fixture now writes its own PID only after installing its signal handler and waits on that ready file using the runner-provided timeout and abort signal. Ten concurrent focused invocations passed both forced-cleanup cases (20/20), followed by the green 848/848 aggregate run.

The integrated clean-state replay used Node 24.11.1; the independent clean copy reported Node 25.8.0. A final compatibility reviewer also passed Node 20.19.6 with root 33/33, the full E2E runner file 20/20, Contracts build/test/runtime import, and API typecheck. The failed GitHub runner used Node 20.20.2; at the time of this local evidence snapshot, a positive result on that exact remote environment still required the existing PR branch to be updated and CI rerun.

## Adversarial evidence highlights

| Attack or failure | Expected result | Evidence in final suite |
|---|---|---|
| Artifact `../`, absolute, control-path, nested, Unicode/case collision, symlink, or wrong client directory | Reject before unsafe access or execution | Definition-loader and workspace-boundary checks |
| Partial/malformed DevOps V1 capability, marker-only impersonation, HTML-comment padding, or low-information section filler | Stable `CONFIG_INVALID`, never silent legacy downgrade or false-complete pack | Definition-loader and Release legacy compatibility checks |
| Old full Release path plus incrementally added current pack | Normalize once to the owner-aware path without rewriting YAML | Release legacy compatibility checks |
| Existing project file collides with an in-memory platform backfill | Block before runner overwrite | Fake-runner collision check |
| Abort, SIGINT, or SIGTERM during initialization | Remove only transaction-owned files and empty directories | Root initializer checks |
| SIGKILL after the first published file | Leave a journal; next invocation validates and recovers, then retries | Real child-process root initializer check |
| File replaced or modified in place on the same inode before cooperative rollback/recovery | Preserve external bytes and fail closed; never unlink by ownership identity alone | Hash/inode rollback, recovery, and concurrent-modification checks |
| Release writes `dist`, `build`, cache, `test-results`, source, control, selected sidecars, or Git metadata | Reject and restore; only the selected runbook remains writable | Release workspace-mode and runner acceptance checks |
| Release invokes Git discovery with locks enabled | Runner stub fails; both Release and Verification require `GIT_OPTIONAL_LOCKS=0` | Runner acceptance check |
| Runbook wraps a trusted path/hash as a substring, binds another Run, omits digest, assigns any owner field to an AI/model, or claims past/future deployment/go-no-go authority | Reject before review persistence | Structured Release validator and service acceptance checks |
| Database completion fails after selected-output writes | Restore prior workspace bytes | Workflow completion service acceptance check |
| Web disconnect arrives after the initializer filesystem commit | Complete project registration; if an INSERT response is uncertain, expose refresh-and-reconcile guidance rather than claim distributed rollback | Workflow completion service Tier A commit-boundary check and project-dialog copy |
| Clean checkout has no ignored Contracts build output | Platform `yarn test` builds Contracts before parallel runtime imports; typecheck remains a non-emitting gate | No-dist integrated replay and independent immutable-install copy, both 848/848 |
| Nested Node startup exceeds a fixed scheduler budget under parallel load | Wait for the child-authored PID readiness signal within the runner deadline, or abort explicitly | Ten concurrent focused runs (20/20) plus the full aggregate replay |
| Malformed successful Web API response | Surface `INVALID_API_RESPONSE`, never invent an empty list | Web response-parser checks |
| Review closes while pending/dirty, or approves unseen current heads | Block or require confirmation; bind progress to current ID/hash | Web artifact-review and UI-safety checks |

## Responsive and navigation inspection

The local Web application was inspected in a real in-app browser before final regression:

| Viewport | Result |
|---|---|
| 650 × 900 | Review dialog width 600 px with no page-level horizontal overflow; a 1,261 px Markdown table scrolls inside its 544 px region; approval action remains reachable. |
| 320 × 720 | Dialog width 318 px and content width 318 px; the same table scrolls inside 278 px; approval action is visible at approximately x=21..299 and y=659..699. |
| Route push | Scroll resets to 0, the route heading receives focus, and the document title identifies the current context. |
| Browser Back while review draft is dirty | Cancelling the guard restores the Workflow URL/title/DOM, keeps the dialog open, and preserves the draft. |
| Browser Forward while review draft is dirty | Cancelling the guard restores the Workflow URL/title/DOM rather than leaving Tickets in the address bar, and preserves the dialog/draft. |
| Project creation | Codex, Claude Code, and GitHub Copilot choices are all present; Codex is the explicit default. |

The Back and Forward cases above were re-exercised in the real in-app browser. Mixed, rapid, hash-only, or unknown same-document history entries do not yet have automated behavioral coverage and remain a stated interaction-test gap.

## IDE/Web capability evidence

Static render/discovery tests verify that exactly one native Agent set is installed and all six rendered bodies derive from `templates/agents/`:

- GitHub Copilot: `.github/agents/*.agent.md`
- Claude Code: `.claude/agents/*.md`
- Codex: `.codex/agents/*.toml`

The formats match the official [GitHub Copilot custom-agent](https://docs.github.com/en/copilot/reference/custom-agents-configuration), [Claude Code subagent](https://code.claude.com/docs/en/sub-agents), and [Codex multi-agent](https://developers.openai.com/codex/multi-agent) contracts. Local command discovery confirmed the installed CLIs expose the expected agent surfaces, but no paid, authenticated end-to-end model run was performed in all three external clients. Web execution remains explicitly Codex-backed even when a different native IDE client is selected.

## Evidence boundary

- No production deployment, merge, publication, provider API mutation, secret use, or remote CI rerun was performed. The existing failed Actions job was inspected as diagnostic evidence only.
- Release validates current platform-selected input bytes and the runbook's required evidence shape. It does not cryptographically authenticate a remote CI, artifact registry, signature, SBOM, or deployment provider.
- A Web request can be cancelled before the filesystem commit point. After that point registration completes; an HTTP disconnect racing an already-started database insert has an uncertain response and is reconciled by refreshing the project list, not by a claimed distributed rollback.
- Workspace guards are bounded synchronous detection/rollback controls, not an OS sandbox. Detached processes, parent-directory swap races, authentication, credential isolation, and network policy require a separately approved runner architecture.
