<!-- ai-sdlc:release-evidence-v1 -->
# Release Runbook: <Run title>

> Replace every placeholder before handoff. A required unknown is a blocker with an owner and next action, not guessed content. `Not applicable` is valid only with an evidence-backed reason.

## Status and immutable bindings

- **Release readiness:** <Draft / Blocked / Ready for human go/no-go>
- **Run / Change Contract:** <Run ID, artifact path or ID, and revision>
- **Release scope:** <exact included scope; cite the Change Contract>
- **Target environment:** <environment or evidence-backed Not applicable>
- **Source/product revision:** <exact Git or workspace revision>
- **Implementation Notes:** <artifact ID/path and current revision>
- **Engineering Provenance:** <artifact ID/path and current revision>
- **Test Report:** <artifact ID/path, current revision, and Verification state>
- **Release artifact:** <immutable artifact identity/version or evidence-backed Not applicable>
- **Artifact digest:** <algorithm:digest from trusted build/artifact evidence or evidence-backed Not applicable>
- **Human release owner:** Human: <role/name reference>
- **Prepared at / by:** <timestamp and Agent execution reference>
- **Deployment execution:** Not executed by preparing this runbook.

Any change to the Run, source, build/artifact bytes or digest, provenance, environment binding, or Test Report makes this readiness conclusion stale and requires review again.

## Trusted upstream input bindings

Copy every selected upstream input from the platform execution manifest without rewriting it. In a direct IDE session without that manifest, use the human-supplied execution brief, compute the exact current project-relative path and SHA-256 locally, and label it as direct-IDE evidence rather than platform-recorded provenance. One current selected input per row is required.

| Artifact ID | Current artifact path | Content hash |
|---|---|---|
| <artifact ID> | <exact project-relative path> | <sha256:exact current content hash> |

## Evidence and supply-chain applicability

| Evidence | Revision, digest, or durable reference | Applicability and conclusion | Blocker / owner / next action |
|---|---|---|---|
| Change Contract and phase clearances | <reference> | <current / stale / conflicting> | <None or action> |
| Accepted Architecture / ADR / NFR / adversarial evidence | <reference or valid skip/reuse clearance> | <applies / not applicable with reason> | <None or action> |
| Implementation and build provenance | <reference> | <current / missing / conflicting> | <None or action> |
| Verification evidence | <reference> | <ready / failed / blocked / stale> | <None or action> |
| SBOM / dependency inventory | <reference> | <required and present / required and missing / not applicable with reason> | <None or action> |
| Signature / attestation / integrity verification | <reference> | <required and present / required and missing / not applicable with reason> | <None or action> |

## Release preconditions

| ID | Required state or approval | Evidence / safe reference | Owner | Status | Release impact |
|---|---|---|---|---|---|
| PRE-01 | <condition> | <durable evidence; secrets by identifier only> | Human: <role/name reference> | <ready / blocked / not applicable with reason> | <impact> |

Include applicable approvals, current required checks, environment/access readiness, dependency and capacity state, compatibility or maintenance constraints, backups, and operator availability. A planned or merely configured check is not passing evidence.

## Ordered rollout

| Order | Authorized owner | Exact action or reviewed command and trusted context | Expected result | Verification and retained evidence | Stop / continue condition |
|---:|---|---|---|---|---|
| 1 | Human: <role/name reference> | <action; no invented command> | <observable result> | <check and durable evidence> | <condition> |

These are instructions for an authorized operator. Mark any unvalidated command or environment assumption as blocked; do not describe a planned action as already executed.

## Health and smoke checks

| Check ID | Target / journey | Method and trusted context | Expected result | Owner | Evidence to retain | Result during authorized execution |
|---|---|---|---|---|---|---|
| HEALTH-01 | <target> | <method> | <observable result> | Human: <role/name reference> | <log/report/query reference> | <not run / pass / fail / blocked> |

## Monitoring and response

| Signal / NFR or risk ID | Threshold | Observation window | Dashboard/query reference | Owner | Action on breach |
|---|---|---|---|---|---|
| <metric or event> | <measurable threshold> | <window> | <safe reference> | Human: <role/name reference> | <pause / investigate / rollback trigger / escalation> |

Monitoring is not ready when a necessary signal lacks a threshold, window, owner, or response action. Do not invent a dashboard, alert, SLO, or contact.

## Rollback and recovery

- **Rollback decision owner:** Human: <authorized role/name reference>
- **Target recovery time (RTO):** <accepted target and source>
- **Rollback triggers:** <measurable triggers tied to health, monitoring, incidents, or accepted risks>
- **Data/schema/config compatibility:** <backward/forward compatibility, irreversible steps, migration ordering, and source evidence>
- **Backup/restore prerequisites:** <backup identity, retention, restore access/reference, validation status, or evidence-backed Not applicable>
- **Expected recovered state:** <revision, data state, and user/operator-visible condition>

| Order | Authorized owner | Recovery action or reviewed command | Expected result | Recovery verification | Status / limitation |
|---:|---|---|---|---|---|
| 1 | Human: <role/name reference> | <action; no invented command> | <state> | <health, data, and evidence check> | <verified / unverified / blocked> |

An untested or partially reversible rollback must remain explicit and cannot be labeled verified.

## Incident and escalation

| Trigger / severity | Immediate response and rollout state | Incident/release owner reference | Escalation and communication path | Evidence to retain |
|---|---|---|---|---|
| <condition> | <pause, contain, investigate, or invoke rollback> | Human: <role/name reference> | <channel/status/customer path without secrets> | <logs, events, decisions, timestamps> |

## Risks, exceptions, and open decisions

| ID | Known defect, untested item, risk, or decision | Evidence | Human owner | Durable acceptance / due condition | Release impact |
|---|---|---|---|---|---|
| RISK-01 | <item> | <reference> | Human: <role/name reference> | <acceptance reference or unresolved next action> | <blocker / residual risk> |

## Human go/no-go and execution boundary

- **Runbook conclusion:** <Blocked with reasons / Ready for human go/no-go>
- **Unresolved blockers:** <IDs or None>
- **Go/no-go owner and decision record location:** Human: <role/name reference>; <durable location; no decision is implied by this document>
- **Required revalidation triggers:** <revision, artifact, environment, test, risk, or plan changes>

Preparing this runbook does not approve or perform deployment, rollout, rollback, production migration, production smoke testing, CI/required-check changes, secret or environment changes, branch-policy changes, commit, push, PR/release/artifact publication, risk acceptance, or incident command. Those actions remain with separately authorized humans and systems.
