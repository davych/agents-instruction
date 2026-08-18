# ADR-{NNN}: {Verb-led decision title}

**Status:** Proposed
**Date:** {YYYY-MM-DD}
**Decision owner:** {human owner}
**Related option:** {option link}
**Related C4 elements:** {L2 aliases}
**Related architecture rules:** {rule IDs or None}
**Related scopes:** {Discovery scope IDs or None}
**Rule effect:** {Implements / Deviates from / Supersedes / Not related}

## Context

{State the project-specific forces and cite the evidence that makes this decision necessary.}

## Decision

{State one clear and actionable decision.}

If this decision deviates from a rule, state the exact rule ID, scope, reason, human approver required, and conditions for removing the exception. A proposed ADR does not silently waive a `MUST` or `FORBIDDEN` rule.

For a machine-gated rule exception or Brownfield migration, a human must create the accepted ADR revision: set `Status: Accepted`, keep the exact rule ID in `Related architecture rules`, set `Rule effect` to the real effect, and replace both Human Approval placeholders. Codex must not manufacture human approval evidence.

## Options Considered

| Option | Why It Could Work | Why It Was Not Chosen |
|--------|-------------------|-----------------------|
| {option} | {project-specific benefit} | {project-specific trade-off} |

## Consequences

### Positive

- {enabled outcome}

### Negative

- {specific cost, risk, operating burden, or lock-in}

## Agent-readable Summary

- **Must:** {rule future agents must preserve}
- **Do not:** {choice future agents must not reintroduce}

## Validation

**Evidence:** {source or measurement}
**How to test this decision:** {repeatable check}
**Revisit when:** {clear trigger}

## Human Approval

**Approved by:** Not approved
**Approval evidence:** Not provided
