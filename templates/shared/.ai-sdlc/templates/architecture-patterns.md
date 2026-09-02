# Architecture Patterns: <System or scope>

**Updated:** <YYYY-MM-DD>
**Authoritative OpenAPI YAML:** <Repository path or canonical URL>

## Required project-wide baseline

These rules apply to project-controlled frontend/backend HTTP APIs. A compatibility exception or change to a rule requires an ADR with scope, trade-offs, and migration impact.

| ID | Area | Required pattern | Project decision or evidence |
|---|---|---|---|
| API-REST-001 | RESTful boundary | Model first-party HTTP APIs as resources with consistent URIs and HTTP methods. Keep frontend/backend communication as an explicit RESTful contract. | <Resource and versioning convention> |
| API-STATUS-001 | Request outcome | HTTP status codes are the authoritative transport outcome. Use suitable `2xx`, `4xx`, and `5xx` codes; do not return `200` for a failed request and rely on a body flag to signal failure. | <Status and error mapping> |
| API-ENVELOPE-001 | JSON body | Use one documented JSON envelope family for project-controlled success and error bodies. Define success data, stable domain error code and message, optional details, metadata, and correlation fields without hiding HTTP status semantics. Document bodyless, file, stream, health, webhook, or third-party exceptions. | <Schema or OpenAPI component links> |
| API-PAGE-001 | Pagination | Every paginated contract names cursor or offset pagination. Prefer an opaque cursor with a stable unique order for mutable, large, or feed-like collections. Use offset only when bounded or administrative random-page access or total counts justify it. Define limit, order, filters, boundaries, and invalid or stale cursor behavior. | <Choice and reason per contract> |
| API-OPENAPI-001 | Contract source | Keep one authoritative OpenAPI YAML contract. Update paths, methods, parameters, request and response schemas, status codes, and examples in the same change as the API behavior, then run the project's OpenAPI lint or contract check. | <YAML path and check command> |

## Active implementation patterns

Record only patterns that are adopted or seriously considered. Do not copy the baseline rows here.

| Pattern | Concern | Location | Why it fits | Trade-off | Evidence or enforcement |
|---|---|---|---|---|---|
| <Pattern> | <API / Data / Integration / Security / Observability / Frontend> | <C4 container or relationship> | <Constraint addressed> | <Cost> | <ADR, source, test, or review> |

## Concern prompts

- **API:** contract ownership, resource and versioning rules, status/error mapping, envelope, pagination, and OpenAPI.
- **Data:** system of record, write and transaction boundaries, migration, consistency, cache, and retention.
- **Integration:** synchronous or asynchronous interaction, timeout, retry, idempotency, failure handling, and contract translation.
- **Security:** identity propagation, server-side authorization, trust boundaries, secrets, and sensitive-data handling.
- **Observability:** structured logs, metrics, traces when useful, correlation, redaction, and visible failure signals.
- **Frontend:** framework and rendering mode, routing, state ownership, server-data caching, design-system boundary, and compatibility.

## Rejected or replaced patterns

| Pattern | Why considered | Why rejected or replaced | Related ADR |
|---|---|---|---|
| <Pattern> | <Reason> | <Project-specific trade-off> | <Link or None> |
