# Implementation plan

## Strategy

Keep the seven-document evidence model in the API and artifact registry, but present it in the Web as one four-step implementation journey with three evidence groups. Add a pure acceptance resolver and a fail-closed implementation-readiness preflight at the service boundary, plus pure error-guidance mappers at the Web boundary, so the behavior is directly testable.

## Vertical slice

1. Open a legacy Implementation phase and understand exactly when code is written.
2. Open Implementation without choosing individual upstream files or Markdown outputs; the platform forms one approved-input bundle and one seven-document evidence pack.
3. Click “检查条件并开始写代码”. If an input document is internally Blocked, stop before creating a Codex execution and route the user to its owning role.
4. After preflight passes, start Codex, modify code/tests, and receive the automatically generated evidence pack with plain-language explanations.
5. Approve a complete legacy evidence pack using stable ACs from the selected approved User Stories.
6. If approval fails, see ordered recovery actions and the original diagnostics instead of one opaque mixed-language sentence.
7. At Product, Design, and Architecture review, see unresolved decisions before the approval controls, record answers in a structured decision form, and rerun the owning role before downstream unlock.

## Constraints

- Do not remove or combine registered artifacts.
- Do not synthesize acceptance criteria from a Run objective, implementation plan, notes, tests, or review.
- Do not let Web guidance bypass API validation.
- Do not show a running/code-writing state until the API readiness preflight passes.
- Do not change architecture, phase ownership, or database schema.
- Store decision capture through the existing append-only review history and require the owning role to materialize it into formal artifacts; do not create a parallel source of truth.

## Verification

- Pure API tests for User Story AC extraction and fail-closed behavior.
- Pure API tests for implementable and internally blocked Product/Design/Architecture inputs.
- Workflow-service approval integration for a legacy Run.
- Pure Web tests for artifact explanations, automatic bundles, readiness routing, and the reported error mapping.
- Existing engineering evidence, Web selection, root initialization, and full platform suites.
- Pure decision extraction/gate tests plus service and Web integration for capture, downstream invalidation, legacy inconsistency, and rerun routing.
