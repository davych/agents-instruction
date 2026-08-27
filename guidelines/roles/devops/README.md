# DevOps Role Guide

This is the human-facing overview for the Release phase. The executable runbook procedure remains in the canonical role workflow linked below.

## Purpose and non-goals

DevOps turns the current Run's confirmed scope, accepted architecture, implementation provenance, and Verification result into an evidence-bound release runbook for a human go/no-go decision.

DevOps prepares and validates guidance only. It does not configure CI or required checks, use secrets, change branch policy, commit, push, publish or merge a PR, build or publish a release, deploy, run production migration/smoke/rollback actions, accept risk, command an incident, or decide go/no-go.

## When it runs

Release preparation follows current Verification evidence. Missing, failed, blocked, stale, or contradictory prerequisites allow only a Draft/Blocked runbook with a named evidence owner and next action.

Release remains the sixth phase. A missing provider, environment, or authorization record routes to an existing owner; it does not create a seventh role or transfer external authority to DevOps.

## Inputs and outputs

| Direction | Artifact or evidence | Release use |
|---|---|---|
| Input | `change-contract` and current clearances | Exact Run, included scope, non-goals, and applicable routes |
| Input | Accepted `architecture`, ADRs, NFRs, adversarial evidence | Deployment/data/security constraints, quality targets, and risks |
| Input | `implementation-notes`, `engineering-provenance` | Actual change, source/build identity, checks, limitations, and non-actions |
| Input | `test-report` | Current Verification conclusion, defects, untested scope, command evidence, and residual risk |
| Input | Verified repository/provider/operations evidence | Real scripts, artifact/digest records, dashboards, environment references, and external status |
| Output | `release-runbook` | Run-scoped preparation guidance and readiness evidence |

Chat claims, example commands, pending architecture scaffolds, stale runbooks, and prose saying something is configured are not current release evidence.

## What the human reviews

Confirm that the runbook:

- binds the exact Run and every selected upstream artifact ID, project-relative path, and current content hash;
- agrees on source/product revision, build or release identity, applicable digest, provenance, and Test Report revision;
- records evidence-backed applicability for SBOM, signature, attestation, dependency inventory, and integrity controls;
- lists approvals, environment/access references, dependencies, capacity, compatibility, backups, checks, owners, evidence, and status without secret values;
- gives every rollout step an authorized owner, reviewed action/context, expected result, retained evidence, and stop/continue condition;
- defines health and smoke checks plus monitoring signal, threshold, window, owner, and action;
- defines rollback trigger, accepted RTO source, data/schema/config compatibility, ordered recovery, expected recovered state, and verification;
- defines incident detection, response, escalation, communication, responsibility, and retained evidence;
- keeps defects, untested scope, residual risk, accepted exceptions, open decisions, and revalidation triggers visible;
- names a real human go/no-go owner;
- contains no placeholder, invented completion, unowned blocker, or claim that preparing the runbook executed release work.

`Ready for human go/no-go` means the guidance passed its evidence contract. It does not mean deployment, merge, publication, rollback, required-check configuration, or release approval occurred.

An authorized human or repository/provider system configures CI policy and required checks. DevOps may document the expected check name, trigger, command/evidence contract, and current provider gap; it does not make the check required.

## Handoff and escalation

The runbook goes to the named human release owner and authorized operators with evidence locations, blockers, residual risks, action owners, and revalidation triggers. The runbook grants no permission.

Return outcome/scope conflicts to the contract owner or PM / BA; architecture/NFR/trust/risk gaps to Architect or the human owner; implementation identity/provenance/build gaps to Software Engineer; Verification gaps to Tester; and environment, access, credential, CI/provider, monitoring, backup, deployment, rollback, or incident-operation evidence to an authorized external owner.

## Canonical sources

- [Canonical DevOps Agent](../../../templates/agents/devops.md)
- [Global workflow definition](../../../templates/ai-native.yaml)
- [Shared workflow](../../../templates/shared/.ai-sdlc/workflows/default.md)
- [DevOps workflow](../../../templates/shared/.ai-sdlc/roles/devops/workflow.md)
- [DevOps config](../../../templates/shared/.ai-sdlc/roles/devops/config.yaml)
- [Release runbook template](../../../templates/shared/.ai-sdlc/templates/release-runbook.md)
- [Platform runtime contract](../../../platform/docs/runtime-contract.md)

Return to [Role Relationships](../README.md).
