# Data rule pack

**Status:** Starter project policy. These rules define decision triggers; they do not require a database, repository, outbox, or cache when the trigger is absent.

**Load when:** The scope persists business data, owns a data store, publishes a state-change event, or proposes a cache.

| ID | Level | Deviation | Trigger | Requirement | Required evidence |
|----|-------|-----------|---------|-------------|-------------------|
| `DATA-001` | `WHEN` | `N/A` | Non-trivial domain or application logic needs persistence access. | Put persistence behind a repository or equivalent domain-facing boundary with explicit transaction ownership. Do not create one wrapper per table or leak ORM queries through the boundary merely to claim the pattern. | Repository responsibility and transaction boundary in Patterns; C4 owner; tests at the boundary. |
| `DATA-002` | `WHEN` | `N/A` | A durable event or message must be published consistently with a local database commit. | Use a transactional outbox or an evidence-backed equivalent. Define relay ownership, delivery semantics, deduplication or idempotency, retry, ordering needs, monitoring, and retention. | C4 database and relay/worker, Pattern, relevant ADR, NFR, and outage premortem finding. |
| `DATA-003` | `MUST` | `N/A` | Persistent business data exists. | Give every dataset one authoritative owning container or system of record and an explicit write boundary. Other containers use an API, event, or governed read model; they do not perform undocumented shared writes. | Ownership in C4 L2 and the architecture index; ADR for ownership changes or shared-database exceptions. |
| `DATA-004` | `WHEN` | `N/A` | A cache is introduced or retained. | Name the source of truth, key and tenant scope, TTL, invalidation path, consistency tolerance, stampede protection, sensitive-data policy, observability, and failure fallback. A cache is never the unrecorded system of record. | Pattern, responsible C4 element, NFR where measurable, and ADR if consistency semantics are material. |

## Placement guidance

- A simple persistence adapter can satisfy `DATA-001`; the rule does not require ceremony or a class named `Repository`.
- `DATA-002` is for an atomic database-and-message requirement. In-memory domain events or best-effort notifications do not automatically trigger an Outbox.
- Do not add a cache as a default architecture component. Add it only when evidence identifies the latency, capacity, cost, or availability problem it solves.
