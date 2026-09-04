# Architecture Pack: <System or topic>

**Updated:** <YYYY-MM-DD>
**Sources:** <Product, design, repository, operational evidence, or Inline request>

## Problem and scope

<Describe the architecture question, affected systems, and important boundaries.>

## Current direction

<Summarize the current architecture and the selected direction. Link decisions instead of copying them.>

**Technology catalog:** <`./technology-profile.md` or canonical bridged link>

## Constraints

- <Accepted ADR, required pattern, compatibility constraint, or measurable target>

## Concern summary

| Concern | Applies | Current decision or known gap | Evidence |
|---|---|---|---|
| API | <Yes / No / Unknown> | <Contract, versioning, status, envelope, pagination, OpenAPI> | <Pattern, ADR, spec, or source> |
| Data | <Yes / No / Unknown> | <Ownership, transactions, migration, cache, consistency> | <C4, ADR, pattern, or source> |
| Integration | <Yes / No / Unknown> | <Sync or async boundary, timeout, retry, idempotency> | <C4, ADR, pattern, or source> |
| Security | <Yes / No / Unknown> | <Identity, authorization, trust, sensitive data> | <C4, ADR, pattern, or source> |
| Observability | <Yes / No / Unknown> | <Logs, metrics, traces, correlation, failure signals> | <Pattern, NFR, or source> |
| Frontend | <Yes / No / Unknown> | <Framework, rendering, routing, state, server data, design system> | <C4, ADR, pattern, or source> |
| Runtime | <Yes / No / Unknown> | <Deployment, hosting, environment, scaling, resilience> | <C4, profile, NFR, or source> |
| Validation | <Yes / No / Unknown> | <Contract, migration, security, performance, and behavioral evidence> | <Profile, NFR, test strategy, or source> |

## Pack index

List only pack files that exist.

| Artifact | Link | Purpose | Status |
|---|---|---|---|
| Discovery context | <relative link or None> | Business, product, engineering, policy, and current-system context | <Current / Stale / Not needed> |
| Architecture options | <relative link or None> | Genuine alternatives and trade-offs | <Current / Stale / Not needed> |
| C4 system context | <relative link or None> | People, focal system, and external systems | <Current / Stale / Not needed> |
| C4 containers | <relative link or None> | Deployable applications, services, stores, and relationships | <Current / Stale / Not needed> |
| ADRs | <directory or ADR links> | Durable choices, migrations, and exceptions | <Current / Stale / Not needed> |
| Architecture patterns | <relative link or None> | Required baseline and reusable implementation rules | <Current / Stale / Not needed> |
| NFRs | <relative link or None> | Measurable quality targets | <Current / Stale / Not needed> |
| Risk review | <relative link or None> | Material failure scenarios and responses | <Current / Stale / Not needed> |

## Shared cross-scope decisions

Link instead of duplicating details held by the technology catalog, Architecture Patterns, or an ADR.

| Concern | Authoritative source | Current rule or unresolved gap |
|---|---|---|
| API or event contracts | <Catalog, OpenAPI, event schema, or ADR> |  |
| Identity and trust boundaries | <Catalog, C4, or ADR> |  |
| Compatibility and coordinated change | <Catalog or ADR> |  |

## Active ADRs

| ADR | Status | Decision in force | Scope |
|---|---|---|---|
| <Link> | <Proposed / Accepted / Superseded> | <Short decision> | <Affected repositories or boundaries> |

## Decision record and open risks

### Decisions

| Topic | Selected option | Decided by | Source |
|---|---|---|---|
| <Topic or None> | <Selected answer> | <Person> | <Conversation or link> |

### Open risks

- <Risk, owner, needed evidence, or None>
