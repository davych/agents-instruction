# Workflow completion V1 — Delivery provenance

## Identity

- Working branch: `codex/workflow-completion-v1`
- Spec: `changes/workflow-completion-v1/delta.md`
- Canonical role sources: `templates/agents/*.md`
- Platform layers: `platform/packages/contracts`, `platform/apps/api`, `platform/apps/web`
- Session record: `sessions/workflow-completion-v1/session-log.md`

## Change provenance

The change was produced from a recorded local baseline, three parallel read-only audits, bounded implementation tasks, main-agent integration review, real responsive-browser inspection, spec-first independent tests, and a separate seven-lens/adversarial review with final exploit replays. Existing dirty or unrelated user work was not replaced, and no initialized target project was rewritten.

Material change groups:

- initializer and three-client native Agent rendering;
- crash-recoverable, inode/content-bound initializer transactions;
- definition/path/native-Agent safety and legacy capability gating;
- runner prompt, workspace mutation, control-resource, and persistence rollback contracts;
- DevOps V1 and the task-scoped, current-Run/current-input-bound Release evidence gate;
- Web client selection, core response validation, review safety, navigation, and responsive layout;
- CI, prompt/SDLC evaluation, README, role guidance, and Mermaid workflow diagrams.

## Authority and external-side-effect record

- No commit was created.
- No files were staged.
- No branch was pushed.
- No pull request was created or updated.
- No merge, npm publication, artifact publication, deployment, rollback, production smoke test, secret/environment change, branch-policy change, DDL, or risk acceptance was performed.
- The local Web development server used for responsive inspection was stopped after testing.
- The Release runbook contract prepares evidence for a later human go/no-go; this document is not a go/no-go record.

## Evidence

- Prompt evaluation: `reviews/workflow-completion-v1/prompt-eval.md`
- SDLC standards map: `reviews/workflow-completion-v1/sdlc-standards-map.md`
- Independent tests: `reviews/workflow-completion-v1/independent-test-evidence.md`
- Seven-lens/adversarial review: `reviews/workflow-completion-v1/review.md`

## Reproduction

Run the exact verification commands recorded in the independent-test evidence file. The current security boundary and deliberate non-changes must remain visible in any future PR body: local/trusted/disposable only; unauthenticated API and non-isolated real runner are unresolved architecture blockers.
