# Software Engineer evidence pack — seven-lens review

## Verdict

Ready for human review with no unresolved implementation blocker. One known platform limitation remains documented: failed real executions do not transactionally roll back source/test changes.

## 1. Correctness

Finding: none found after fresh initialization, legacy loading, deterministic path pinning, semantic approval, Web selection, and full platform regression checks passed.

## 2. Security

Finding: none found in the delivered boundary. The runner rejects and restores mutations to all client Agents, role packs, workflows, evidence templates, root controls, environment variants, symlink topology, and permission modes. Security findings and risk acceptance remain human-owned.

## 3. Error handling

- ID: ENG-REV-001
- Severity: medium
- Finding: a failed real Codex execution can leave confirmed-scope source/test edits because implementation writes are not isolated in a transactional Git worktree.
- Evidence: `platform/apps/api/src/services/codex-runner.ts`, `platform/apps/api/checks/engineering-evidence-runner.check.ts`, and `context/cold/gap-log.md`.
- Impact: a human may need to inspect or revert partial implementation edits after a runner/control failure.
- Required action: evaluate worktree-based implementation transactions as a separately approved architecture change; Owner: Platform maintainers.
- Status: known residual limitation, outside this role-evidence delta; protected evidence/control resources do roll back and the limitation is disclosed.

## 4. Edge cases

- ID: ENG-REV-002
- Severity: medium
- Finding: legacy configs with a Software Engineer config file but no `output.subdirectory`, existing notes-only Runs, large custom role resources, permission-only mutations, and environment symlinks were initially under-specified.
- Evidence: loader, path, runner, and Web frozen cases in `platform/apps/api/checks` and `platform/apps/web/checks`.
- Impact: without the fixes, old Runs could resolve to the wrong directory, fail execution, or bypass resource protection.
- Required action: preserve the new regression cases; Owner: Platform maintainers.
- Status: resolved by implementation and 238/238 focused regression evidence.

## 5. Performance

Finding: none found. The role pack adds Markdown loading and approval-time parsing only; no runtime dependency or schema migration was introduced. Protected resources use per-file limits so unrelated role/template trees above 2 MiB remain executable.

## 6. Maintainability

Finding: none found. The design reuses the canonical Agent, ordinary role pack, global registry, generic artifact contracts, shared task-path resolver, and existing Web review UI. The optional replay packet is not a hidden eighth phase output.

## 7. Spec drift

Finding: none found. The fixed six phases, role ownership, upstream clearances, Tester independence, human decision boundaries, and existing `implementation-notes` ID remain intact. FE-cc was patched incrementally rather than reinitialized.

## Adversarial pass

### Pre-mortem

- ID: ENG-ADV-001
- Severity: high
- Plausible failure: canonical templates and the FE-cc copy drift, making normal evidence fail the semantic approval gate.
- Trigger: the validator contract changes without updating templates/references or the initialized target.
- Evidence/detection: canonical table compatibility tests plus byte comparisons of the target role pack and templates.
- Impact: users cannot approve a correctly completed implementation Run.
- Required action: keep canonical-template positive tests and target sync evidence; Owner: Platform maintainers.
- Status: resolved; validator 176/176 and final target comparisons pass.

### Edge-case-hunter

- ID: ENG-ADV-002
- Severity: high
- Edge condition: an old project has only `implementation-notes`, or has a role config without an output block, while a rerun requests only an existing subset.
- Expected behavior: the loader injects all seven outputs in memory, every path stays under one Run-scoped engineering directory, and Web requires missing outputs before allowing a local rerun.
- Evidence/result: definition-loader, task-path, workflow, and Web legacy-selection tests.
- Impact: without the behavior, approval becomes impossible or writes escape the intended artifact directory.
- Required action: retain compatibility tests and basename-plus-owner-subdirectory rules; Owner: Platform maintainers.
- Status: resolved; focused and full regression suites pass.

## Human decision boundary

This review recommends readiness only. It does not approve architecture or security exceptions, accept the residual runner risk, publish a PR, merge, deploy, or authorize release.
