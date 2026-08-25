# Workflow completion v1 — SDLC standards map

## Decision

Keep the fixed six phases and existing owners. Security, supply-chain, operations, vulnerability response, feedback, and retirement are obligations inside those phases or inputs to a new Run; they are not reasons to add a seventh phase.

The comparison baseline is [NIST SP 800-218 SSDF v1.1](https://csrc.nist.gov/pubs/sp/800/218/final), the [OWASP SAMM model](https://owaspsamm.org/model/), and [SLSA v1.2](https://slsa.dev/spec/v1.2/). These sources are used as control families, not as a claim of certification or full compliance.

## Coverage map

| Existing phase or lifecycle routing | Primary owner | SSDF / SAMM / SLSA obligation | V1 evidence | Coverage |
|---|---|---|---|---|
| Discovery | PM / BA | Prepare/govern; stakeholder, risk, security/privacy/compliance and operational requirements | Immutable Change Contract, PRD, Stories, risk flags, measurable AC/regression scope | Partial: Web contract has risk flags, but the local template and risk applicability need alignment. |
| Design | Designer | Requirements-driven design, accessibility, privacy/user-harm considerations | Design baseline/spec, explicit states, deferred runtime validations | Good for UX/accessibility; abuse/privacy triggers are not systematic. |
| Architecture | Architect | Threat-aware design, trust boundaries, secure design, NFRs, dependency/operational risks | Options, C4, ADRs, NFRs, adversarial review | Partial: strong premortem and rule packs, but not a complete risk-adaptive threat model. |
| Implementation | Software Engineer | Protect/produce well-secured software; secure build, dependency and source integrity | Change plan, source/tests, independent evidence, seven-lens/adversarial review, provenance | Partial: provenance exists; SAST/SCA/secret/license/SBOM applicability is not a uniform machine contract. |
| Verification | Tester | Requirements-driven positive/negative/risk testing and independent evidence | Run-scoped report, regression evidence, deferred design checks, supervised real-browser E2E | Strong functional/browser chain; explicit abuse/security-test routing remains incomplete. |
| Release | DevOps + human release owner | Secure deployment, build identity/integrity, observability, rollback, incident readiness | Run-scoped release runbook, source/artifact digest, provenance/SBOM applicability, rollout, health, monitoring, rollback/RTO/recovery, incident/escalation | Implemented in V1 as preparation and semantic review; no deployment authority is granted. |
| Lifecycle routing only: feedback / vulnerability / retirement (not a seventh phase) | Existing owner and one of the six phases, selected by impact | SSDF Respond; SAMM Incident/Operational Management; decommission and dependency response | Incident/escalation and revalidation triggers in runbook; a new or reopened Run routes to the affected existing phase | Partial: lifecycle routing is defined, but no provider integration, SLA, patch automation, or retirement evidence type is claimed. |

## V1 improvements

- Release now consumes the Change Contract, implementation notes, engineering provenance, architecture evidence, and Test Report directly.
- Release evidence is task-scoped so simultaneous Runs cannot overwrite one global runbook.
- The approval gate binds the exact current Run plus every selected upstream artifact ID, project-relative path, and platform-recorded content hash; only a real runner execution can reach Release readiness approval. The runbook separately records source revision, release artifact/digest, provenance, Test Report, SBOM/integrity applicability, and human owner.
- Monitoring requires a signal, measurable threshold, observation window, owner, reference, and breach action.
- Rollback requires measurable triggers, RTO, data/schema/config compatibility, prerequisites, ordered actions, and recovery verification.
- Incident detection, first response, escalation, communication, and retained evidence are explicit.
- Operational feedback routes to the existing phase or a new Run, preserving the six-phase model.
- CI now runs initializer tests/package verification and platform typecheck/tests/build as separate jobs.

## Confirmed gaps and ownership

| Gap | Why it is not silently changed | Required owner/decision |
|---|---|---|
| API has no authentication while the runner can be configured beyond loopback and invokes an unsandboxed Codex process. | Authentication, credential isolation, network policy, and execution sandbox/worktree/container selection are security architecture choices. | Security/architecture owner must choose the supported deployment boundary. Until then, platform support is local, trusted, disposable use only. |
| Repository, issue, DOM, and log content has no shared untrusted-instruction policy. | A policy without runner isolation can create false confidence; the exact trust/connector model is security-sensitive. | Security owner approves a shared policy and adversarial canary suite together with isolation. |
| Architecture and engineering evidence floors are risk-insensitive. | Changing them affects architecture approval and Verification responsibility. | Architecture/workflow owner chooses applicability profiles and AC verification classifications. |
| Legacy projects receive platform-only in-memory graph backfills. | A real migration/upgrader changes project-owned prompts/templates and needs a versioning/checksum design. | Architecture/scope decision for an incremental `upgrade` command and frozen effective-definition snapshot. |
| Remote CI/SBOM/signature/provider evidence is not authenticated by a connector. | Prose and URLs cannot prove provider state. | DevOps/security owner selects providers, trust roots, retention, and credential handling. |
| Retirement/decommission has no dedicated artifact. | Adding an artifact changes the public workflow contract, even if phase order stays fixed. | Product/architecture/release owners decide whether a conditional Release appendix is sufficient. |

## Release boundary

The V1 Release phase answers “is an evidence-bound runbook ready for a human go/no-go decision?” It does not answer “was production deployed?” and cannot approve risk, use credentials, change required checks, merge, publish, deploy, roll back, or command an incident without separate explicit authority.
