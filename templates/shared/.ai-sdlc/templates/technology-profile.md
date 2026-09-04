# Technology Profile Catalog

**Document status:** Proposed | Confirmed | Superseded

**System or delivery project:**

**Last reviewed:** YYYY-MM-DD

**Replacement:** <Link when Superseded, or None>

This catalog is the stable entry point for application technology. It maps deployable frontend and backend scopes to their child profiles and owns shared contracts and boundaries. Use `Observed`, `Required`, `Proposed`, `Accepted`, `Excluded`, or `Unknown` for entry state. Only `Required` and `Accepted` instruct implementation.

## Decision sources

| Source | What it establishes |
|---|---|
|  |  |

## Shared constraints and quality needs

| ID | Requirement or constraint | State | Priority | Source | Verification approach |
|---|---|---|---|---|---|
| TQ-001 |  | Required |  |  |  |

## Scope catalog

Use one row per deployable application or service. A repository may have several rows, and one scope may be hosted outside the delivery project. A Scope ID is a stable lowercase kebab-case filename segment matching `[a-z0-9]+(?:-[a-z0-9]+)*`; it is never a path or URL. `Repository ID` is the exact ASCII lowercase kebab-case `repositoryId` from the code repository's `.ai-sdlc/installation.json`, or the ID reserved for a repository that will be initialized later. It must be unique among different code sources in this delivery project; multiple checkouts of the same repository may reuse it. `Source host/path` records where the Architect read evidence and is not repository identity; use `Planned / Not created` for a greenfield source that does not exist. A developer first matches Repository ID and Kind, then selects the row or rows for the deployable or Scope ID set affected by the current task. If that set is ambiguous, ask rather than combining potentially conflicting profiles.

| Scope ID | Kind | Repository ID | Source host/path | Deployable | Mode | Child profile | Document status | Owner |
|---|---|---|---|---|---|---|---|---|
| <web-app> | frontend | <exact repositoryId> | <host-id:/path or Planned / Not created> | <application or bundle> | <Existing / Greenfield / Hybrid> | `/docs/ai-sdlc/technology/frontend/<scope-id>.md` | <Proposed / Confirmed> | <Team or person> |
| <api-service> | backend | <exact repositoryId> | <host-id:/path or Planned / Not created> | <service, worker, or function> | <Existing / Greenfield / Hybrid> | `/docs/ai-sdlc/technology/backend/<scope-id>.md` | <Proposed / Confirmed> | <Team or person> |

## Shared contracts and boundaries

Keep decisions shared by several profiles here or in a linked Architecture Pack file. Child profiles link to these decisions instead of redefining them.

| Area | Current evidence or constraint | Target decision | State | Source or ADR |
|---|---|---|---|---|
| API and event contracts |  |  |  |  |
| Identity and authentication |  |  |  |  |
| Authorization and trust boundaries |  |  |  |  |
| Compatibility and versioning |  |  |  |  |
| Cross-scope deployment or migration order |  |  |  |  |
| Unsupported or intentionally excluded approaches |  |  | Excluded |  |

## Open decisions

| Decision | Affected scopes | Why it matters now | Options considered | Recommendation | Decision owner | Needed by |
|---|---|---|---|---|---|---|
|  |  |  |  |  |  |  |

## Related ADRs

- <ADR link and affected scopes, or None yet>
