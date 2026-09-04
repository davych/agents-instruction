## Summary

- generate frontend, backend, full-stack, or separate frontend/backend developer
  identities from one canonical Software Engineer role
- defer stack choices to Architect first use and add a technology catalog plus
  scoped frontend/backend profiles
- connect code repositories to delivery-owned Architecture artifacts through
  the existing read-only bridge
- add stable repository identity, scoped Implementation paths, shared Clean
  Code guidance, and strict schema-v2 update validation

## Behavior

- Architect-only initialization asks no engineering-scope or technology-stack
  questions.
- `--engineer-scope frontend,backend` directly creates two specialists;
  `fullstack` creates one full-stack agent.
- `--repository-id` provides the exact catalog identity and defaults to a safe
  value derived from the target directory.
- Existing, greenfield, and hybrid architecture first-use paths keep observed
  state separate from human-accepted implementation rules.
- Schema-v1 metadata is rejected without migration, as explicitly authorized
  for this exploratory project.

## Verification

- `npm test`
- `npm pack --dry-run`
- `git diff --check`
- independent Tier A acceptance tests plus two adversarial review passes and a
  five-pattern user-flow exercise

## Provenance

- Specification: `changes/scoped-engineering-profiles/delta.md`
- Hot context: `AGENTS.md`
- Warm context: `docs/context/stack.md`, `docs/context/architecture.md`,
  `docs/context/testing.md`
- Cold gap record: `context/cold/gap-log.md`
- Session log: `sessions/scoped-engineering-profiles/session-log.md`
- Independent tests: `test/scoped-engineering.test.js`
- Review: `reviews/scoped-engineering-profiles/review.md`
