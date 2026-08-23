# Engineering approval recovery

## Outcome

Implementation approval failures now produce one concrete recovery path. The UI groups machine diagnostics by evidence document, explains them in Chinese, recommends either upstream repair, full implementation rerun, or evidence-only repair, and opens Software Engineer with exactly the affected outputs selected. Partial evidence repair is no longer labelled as starting code work.

## Verification

- Root initializer: 3/3 passed; package dry run passed.
- Platform: typecheck passed; 547/547 tests passed; production build passed.
- FE-cc: 11/11 tests, lint, and build passed.
- Live Web inspection confirmed the five-document/32-issue recovery and the `检查并修复工程证据` dialog.

## Provenance

- Spec: `changes/engineering-approval-recovery/delta.md`
- Plan/tasks: `changes/engineering-approval-recovery/plan.md`, `changes/engineering-approval-recovery/tasks.md`
- Session log: `sessions/engineering-approval-recovery/session-log.md`
- Tests: `changes/engineering-approval-recovery/test-evidence.md`
- Review: `reviews/engineering-approval-recovery/review.md`
- PR publication performed by this session: No.
- Merge, deployment, or release performed by this session: No.
- Final approval remains human-owned.
