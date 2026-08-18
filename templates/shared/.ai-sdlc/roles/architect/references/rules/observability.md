# Observability rule pack

**Status:** Starter project policy. Observability requirements must identify the runtime element and measurable operational outcome.

**Load when:** The selected scope has a deployable runtime, inbound request, job, event consumer, or remote call.

| ID | Level | Deviation | Trigger | Requirement | Required evidence |
|----|-------|-----------|---------|-------------|-------------------|
| `OBS-001` | `MUST` | `N/A` | An inbound request, command, job, or message can start or continue a unit of work. | Accept a valid correlation/request ID or generate one, propagate it across in-scope boundaries, and include it in structured diagnostics and documented error responses. Sanitize untrusted values and never use the ID as identity or authorization. | Entry-point and propagation Pattern, API envelope/error contract where applicable, tests, and responsible C4 relationships. |
| `OBS-002` | `MUST` | `N/A` | A production runtime component is designed. | Emit structured logs with consistent timestamp, severity, service/component, environment, version, event/error code, and request/trace correlation fields. Define redaction and prohibit secrets or unapproved sensitive fields. | Logging Pattern, searchable failure signal in NFRs, and security rule link. |
| `OBS-003` | `WHEN` | `N/A` | Work crosses process or asynchronous boundaries, or evidence requires cross-component latency/failure diagnosis. | Use distributed tracing with a documented propagation standard, span ownership/naming, async linkage, sampling, retention, and sensitive-attribute policy. If not triggered, record why request correlation and metrics are sufficient. | C4 relationships, tracing Pattern, latency/diagnostic NFR, and outage review. |

## Placement guidance

- `requestId` and a distributed `traceId` may coexist. Define their relationship instead of assuming they are interchangeable.
- Structured logging is not “serialize arbitrary objects.” The field contract and redaction rules are part of the pattern.
- Do not force tracing into a single-process scope without a diagnostic or operating need.
