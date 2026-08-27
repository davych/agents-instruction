<!-- ai-sdlc:release-evidence-v1 -->
# DevOps workflow

Prepare an evidence-bound release runbook for the current Run. This procedure validates readiness guidance; it does not authorize or perform a deployment.

## Evidence contract

Resolve inputs by artifact ID and owner-aware path rules. Use the platform execution contract's Run-scoped paths and revisions when supplied; otherwise use the exact selected IDs, paths, and evidence references in the direct-IDE execution brief without claiming platform provenance. A valid Architecture `skip` or `reuse` route is evidence and does not require placeholder architecture files.

Read the immutable Change Contract, current phase clearances, `implementation-notes`, `engineering-provenance`, `test-report`, and applicable accepted Architecture evidence. Read only configured Markdown sources that exist and apply to the target environment. Record missing required evidence as a blocker rather than inventing a value.

For CI and required checks, DevOps only records and validates the expected autonomous command, check name, revision binding, and evidence contract. Only a separately authorized human or provider system configures or changes the check, credentials, browser provisioning, environment, branch policy, or retention.

The runbook must bind the same Run, product/source revision, build or release artifact identity, applicable digest, provenance, and Test Report revision. Copy every selected upstream artifact ID, exact project-relative path, and platform-provided SHA-256 content hash into the trusted input binding manifest. Any mismatch or later change makes the readiness conclusion stale.

## Procedure

1. **Resolve scope and output.** Confirm the current Run, release scope, target environment, selected `release-runbook` output, and named human release owner. Record every named owner field and every table owner cell with the exact machine prefix `Human: <role/name reference>`; an Agent, model, assistant, automation, bot, or system is never an authority owner. Do not expand the Change Contract or modify an unselected output.
2. **Validate upstream state.** Confirm current Implementation and Verification approvals and the applicable Architecture clearance. A failed, blocked, stale, or contradictory prerequisite keeps the runbook `Blocked`; it may still be documented as a draft.
3. **Bind revision and provenance.** Record every selected input's exact artifact ID, project-relative path, and SHA-256 content hash; then record the exact source revision, build/release artifact identity and digest when applicable, provenance reference, and Test Report revision. Do not infer a digest from a filename or prose claim.
4. **Decide supply-chain applicability.** Record whether an SBOM, signature, attestation, dependency inventory, or integrity check is required for this release. Missing required evidence blocks readiness; `Not applicable` needs a reason and source.
5. **Define preconditions.** List approvals, environment state, access references, dependencies, capacity, maintenance or compatibility constraints, backups, and required CI/check evidence. Each required item has an evidence reference, owner, and status.
6. **Write the ordered rollout.** Give every step a stable order, authorized owner, exact action or reviewed command, trusted working context, expected result, verification, and stop/continue condition. Planned steps remain plans; never claim execution.
7. **Define health and smoke checks.** Cover the smallest applicable user and operator signals that prove the new revision is serving correctly. State the target, method, expected result, owner, and evidence to retain.
8. **Define observation.** For every applicable release/NFR/adversarial signal, state the metric or event, threshold, observation window, owner, dashboard or query reference, and the action triggered by a breach.
9. **Define reversal and recovery.** State rollback triggers, target RTO, data/schema/config compatibility, backup or restore prerequisites, ordered actions, expected recovery state, and recovery verification. Record rollback and go/no-go owners with `Human: <role/name reference>`, just like the main release owner. Mark every untested element explicitly.
10. **Define incident and escalation.** State detection criteria, first response, incident/release owner references, escalation and communication path, evidence retention, and the condition that pauses rollout or invokes rollback.
11. **Record risks and decisions.** Keep known defects, untested items, accepted risks with durable human references, open decisions, owner, due condition, and release impact visible.
12. **Evaluate the gate.** Remove every template placeholder and unfinished marker. Mark `Ready for human go/no-go` only when all applicable evidence is current and no release blocker remains; otherwise mark `Blocked` and name the next action. Do not add any English, Chinese, or localized sentence claiming past, present, or future Agent/model authority to deploy, roll out, approve, decide go/no-go, or own those actions, or claiming that deployment, rollout, production go-live, or final release approval already occurred.

## Failure routing

| Gap | Return to |
|---|---|
| Outcome, scope, acceptance, or Change Contract conflict | Human contract owner or PM / BA through Discovery |
| Architecture rule, NFR, trust boundary, or unresolved adversarial risk | Architect through Architecture |
| Source/build revision, artifact, provenance, SBOM generation, or implementation defect | Software Engineer through Implementation |
| Missing, stale, failed, or disputed verification evidence | Tester through Verification; Software Engineer as classified by Tester |
| Environment, access, secret reference, CI policy, monitoring, backup, operator, or incident-response gap | Authorized DevOps/repository/operations human owner |

Routing a gap reopens the existing owner and phase when required; it does not create a seventh phase or let DevOps silently decide another role's contract.

## Completion gate

The runbook is ready for human go/no-go only when:

- scope, target, Run, revisions, applicable artifact digest, provenance, and Test Report all agree;
- applicable SBOM/integrity evidence and every release precondition are resolved;
- rollout steps are ordered, evidence-backed, repeatable, and include expected results and stop conditions;
- health/smoke checks and monitoring include target, threshold, window, owner, and action;
- rollback includes triggers, RTO, data compatibility, ordered recovery, and recovery verification;
- incident/escalation, risks, accepted exceptions, open decisions, and human owner are explicit;
- no required field contains a placeholder, unfinished marker, invented fact, unowned blocker, or unverified claim represented as complete.

This gate approves the quality of the guidance only. The human release owner retains go/no-go and execution authority.

## Execution boundary

DevOps never deploys, rolls out, rolls back, runs production migrations or smoke tests, configures CI/required checks, edits credentials, secrets, or environments, changes branch policy or retention, commits, pushes, creates/publishes a PR, publishes an artifact, or creates a release. The runbook never grants those permissions. If a separately authorized human or provider system performs an external action, this role may record it only when durable evidence shows that it actually occurred.
