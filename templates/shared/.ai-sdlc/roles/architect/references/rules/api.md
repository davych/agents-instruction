# API rule pack

**Status:** Starter project policy. Tune it with evidence; do not silently strengthen a `DEFAULT` into a universal mandate.

**Load when:** A first-party HTTP/JSON API, webhook, or frontend/backend contract is in scope.

| ID | Level | Deviation | Trigger | Requirement | Required evidence |
|----|-------|-----------|---------|-------------|-------------------|
| `API-001` | `DEFAULT` | `ADR required` | A new first-party request/response HTTP boundary is designed. | Model the contract as RESTful resources using HTTP methods, status codes, identifiers, and resource relationships consistently. Do not turn every outcome into HTTP 200. For brownfield APIs, preserve verified compatibility unless a migration ADR is accepted. | C4 relationship plus the resource, versioning, and error conventions in Patterns; ADR when the choice or migration is material. |
| `API-002` | `DEFAULT` | `ADR required` | A project-controlled JSON application API returns success or error bodies. | Use one documented response-envelope family without erasing HTTP status semantics. Define success data, error code/message/details, metadata, and correlation fields before readiness. Record explicit non-body or externally controlled cases such as `204`, streams, files, health endpoints, and third-party callbacks as `Not triggered`; a JSON-body deviation requires an accepted ADR. | Concrete schemas and exceptions in Patterns; contract tests; ADR for any triggered deviation or compatibility break. |
| `API-003` | `WHEN` | `N/A` | A mutable, unbounded, or growing ordered collection needs pagination. | Use cursor pagination with an opaque cursor and a stable total order including a unique tie-breaker. Define limit bounds, direction semantics, invalid or stale cursor behavior, and filter/sort binding. | Pattern and API contract; NFR for page limits or latency; ADR for a material offset-pagination exception. |

## Placement guidance

- REST, an envelope, and cursor pagination are not automatically three ADRs. Put the repeatable mechanics in `05-patterns.md`.
- Create an ADR when the decision changes compatibility, spans multiple systems or teams, rejects a serious alternative, or creates a costly migration.
- Do not invent the exact envelope field names here. The selected architecture must define them once and make all in-scope API contracts follow that definition.
