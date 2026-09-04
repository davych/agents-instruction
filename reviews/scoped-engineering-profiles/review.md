# Review: scoped engineering profiles

## Verdict

Ready to ship. No open P0, P1, or P2 findings remain. The implementation keeps
the six canonical phases and owners while making engineering identity,
technology planning, and cross-repository consumption explicit.

## Seven-lens review

### Correctness

- Initialization distinguishes frontend, backend, full-stack, and separate
  frontend/backend agents while retaining `software-engineer` as the single
  Implementation owner (`bin/cli.js:318`, `bin/cli.js:351`, `bin/cli.js:520`).
- Every installation records an authoritative repository ID and role profile;
  update rebuilds the same managed outputs from that record
  (`bin/cli.js:688`, `bin/cli.js:941`, `bin/cli.js:1105`).
- The catalog first matches repository ID and engineering area, then the
  affected deployable/Scope ID set, so a multi-deployable monorepo does not
  combine unrelated profiles
  (`templates/shared/.ai-sdlc/templates/technology-profile.md:27`).

### Security and trust boundaries

- Repository IDs are validated as ASCII lowercase kebab-case, so confusable
  Unicode and path-like values are rejected before CLI writes. Architect rules
  apply the same safe shape to scope IDs before creating profile artifacts
  (`bin/cli.js:2097`, `templates/agents/architect.md:22`).
- External Architecture sources accept only safe filesystem roots or HTTPS
  bases without credentials. The bridge remains read-only and performs no
  cloning, copying, synchronization, or cross-repository writes.
- Update rejects symlinks, multi-link files, target replacement, duplicate JSON
  keys, unknown schema fields, and conflicting generated developer identities.

### Error handling and atomicity

- Initialization checks every destination and removes only unchanged files
  created by the failed command.
- Update snapshots authoritative metadata, rechecks it before and during
  writes, verifies every managed result, and safely rolls back applied changes
  when a failure or controlled race occurs (`bin/cli.js:1105`,
  `bin/cli.js:1441`, `bin/cli.js:1578`, `bin/cli.js:1612`).
- Schema v1 and legacy installations fail clearly before writes; no implicit
  migration or scope inference remains.

### Edge cases

- Covered paths include Architect-only, no-role, frontend-only, backend-only,
  full-stack, separate specialists, reversed frontend/backend input, all three
  AI tools, filesystem/HTTPS Architecture sources, greenfield sources that do
  not exist yet, and missing or conflicting managed files.
- Existing technology retained unchanged still requires one human acceptance;
  hybrid profiles apply existing/greenfield treatment per concern
  (`templates/shared/.ai-sdlc/technology-planning.md:14`).
- Separate specialists must name one lead and record shared-file ownership and
  ordering in the lead's scoped plan before parallel work
  (`templates/agents/software-engineer.md:12`).

### Performance

- The CLI remains standard-library-only and performs bounded work proportional
  to the small generated file set. The final safety read is intentionally
  linear in managed outputs.
- No server, database, synchronizer, manifest lifecycle, or runtime
  orchestration was added.

### Maintainability

- There is still one main Markdown source per canonical role. Developer agents
  compose the Software Engineer source with one small scope fragment instead of
  duplicating the full workflow (`bin/cli.js:520`).
- `frontend,backend` directly implies separate specialists; the redundant
  single-value `--engineer-mode` option was removed.
- Technology concerns live in one catalog plus focused frontend/backend child
  templates, with shared contracts kept at catalog/Architecture Pack level.

### Specification alignment

- Technology choices are absent from CLI initialization. The Architect creates
  profiles only on first relevant application-architecture work.
- An Architect-only delivery repository can plan both frontend and backend
  without initializing developer agents or touching application repositories.
- Code repositories consume the delivery repository through the generated
  read-only bridge using `--architecture-source` and exact repository identity.
- Clean Code and general engineering guidance is shared by all three developer
  identities without becoming a separate process artifact.

## Adversarial pass and resolved findings

Repeated independent passes found and drove fixes for:

- unknown schema fields, non-canonical role order, duplicate roles, and nested
  or Unicode-escaped duplicate JSON keys;
- object-key-order sensitivity in `architectureSource`;
- unsafe scope IDs and bridge-incompatible relative child paths;
- update success after concurrent changes to written or preflight-unchanged
  managed files;
- unexpected scoped developer files when a different scope, or no Software
  Engineer, is configured;
- missing code-host registration for Architect-only existing/hybrid work;
- ambiguous repository matching, normalized-name collisions, Unicode
  confusables, multi-deployable monorepos, and stale profile snapshots;
- greenfield profiles being forced to invent a source path;
- two separate specialists independently claiming shared files;
- missing frontend client-security/privacy concerns.

## Residual low risks

- Cross-repository uniqueness of host, repository, and scope IDs is enforced by
  the Architect workflow because a single-repository initializer cannot inspect
  the full delivery graph.
- Filesystem and HTTPS bridge behavior is covered through generated registry and
  instruction contracts, not a live multi-repository remote integration test;
  the bridge is an instruction Skill rather than a runtime synchronizer.
- A hostile external process can always modify a file after its final check and
  before process exit. The implementation closes the controllable race windows
  and preserves unexpected concurrent content during rollback.

## Evidence

- Independent acceptance suite: `test/scoped-engineering.test.js` (isolation
  Tier A: authored from the delta and public interface without reading the CLI
  implementation).
- Regression suites: `test/init.test.js`, `test/update.test.js`.
- Required checks: `npm test`, `npm pack --dry-run`, and `git diff --check`.
