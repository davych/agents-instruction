# Integration rule pack

**Status:** Starter project policy. Apply resilience patterns only at evidenced remote or asynchronous boundaries.

**Load when:** A process calls another process or external system, uses messaging, or translates between bounded contexts.

| ID | Level | Deviation | Trigger | Requirement | Required evidence |
|----|-------|-----------|---------|-------------|-------------------|
| `INT-001` | `WHEN` | `N/A` | A remote operation can fail transiently and is safe to repeat. | Use bounded retries with backoff, jitter, a retry budget, and observable exhaustion. Prove idempotency or replay safety, avoid multiplied retries across layers, and do not retry permanent failures. | Relationship Pattern, timeout/retry budget NFR, and failure-path test. |
| `INT-002` | `MUST` | `N/A` | Any synchronous remote call is made. | Set explicit connect and request or overall deadlines within the caller’s end-to-end budget. Define cancellation and the user-visible or asynchronous outcome after timeout; never use an unbounded remote call. | C4 relationship, Pattern, latency NFR, and dependency-outage review. |
| `INT-003` | `WHEN` | `N/A` | Repeated dependency failures can exhaust resources or cascade. | Use a circuit breaker or evidence-backed equivalent with thresholds, open-state behavior, recovery probes, fallback semantics, and telemetry. Do not add one when timeout and bounded concurrency already contain the failure. | Pattern, NFR/failure signal, and premortem evidence. |
| `INT-004` | `WHEN` | `N/A` | An external or legacy model has different terminology, invariants, lifecycle, or error semantics. | Put an anti-corruption layer at the boundary. Translate contracts and failures there so partner models do not become the internal domain model. | Boundary in C4, mapping responsibility in Patterns, and ADR when translation ownership is material. |
| `INT-005` | `WHEN` | `N/A` | Evidence favors asynchronous decoupling, fan-out, audit history, workload smoothing, or a long-running workflow. | Evaluate event-driven integration against a synchronous alternative. If adopted, define event owner, schema/version policy, delivery semantics, ordering scope, idempotency, replay, poison-message handling, and observability. | ADR for the interaction choice, C4 queue/event relationship, Patterns, NFRs, and outage review. |

## Placement guidance

- Retry, timeout, and circuit breaker are a coordinated policy, not three independent checkboxes.
- Event-driven architecture is not a global default. Adopt it only when the trigger and operational cost are visible in the option comparison.
- An anti-corruption layer can be a module or adapter; it does not require a separately deployed service.
