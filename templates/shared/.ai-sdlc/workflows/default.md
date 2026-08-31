# Default workflow

## Change Contract prerequisite

Every Run starts with one immutable, task-scoped `change-contract` created by the platform or a human. It defines the requested outcome, included boundary, observable acceptance criteria, regression obligations, and source evidence. Roles may cite it but must not rewrite it. A materially different outcome or scope requires a new Run and a new impact assessment.

## Six phases

The phase order and owners are fixed:

| Order | Phase | Owner | Phase result |
|---:|---|---|---|
| 1 | Discovery | PM / BA | Product clearance and the selected product evidence |
| 2 | Design | Designer | Design clearance and the selected design evidence |
| 3 | Architecture | Architect | Architecture clearance and the selected architecture pack |
| 4 | Implementation | Software Engineer | Working change and seven-artifact engineering evidence pack |
| 5 | Verification | Tester | Run-scoped `test-report` |
| 6 | Release | DevOps | Run-scoped `release-runbook` ready for a human decision or honestly blocked |

Meet the current phase gate in `ai-native.yaml` before downstream work starts. A clearance may avoid an Agent execution; it never invents missing evidence or changes phase ownership.

Detailed subflows live only in their role procedures:

- Architect selection and selected-state materialization: `.ai-sdlc/roles/architect/workflow.md`
- Tester linked-workspace E2E lifecycle: `.ai-sdlc/roles/tester/workflow.md`
- Release evidence and execution boundary: `.ai-sdlc/roles/devops/workflow.md`

## Impact routing

| Phase | Disposition | Route |
|---|---|---|
| Product | `direct` | The Change Contract and authoritative expected-behavior evidence are sufficient; do not run PM / BA or create placeholder PRD/stories. |
| Product | `reuse` | Import exact approved PRD/story revisions with provenance; do not run PM / BA. |
| Product | `partial` | Run PM / BA for selected affected outputs only; preserve inherited content. |
| Product | `full` | Run PM / BA for a new or materially changed product model. |
| Design | `skip` | Evidence shows no interface, interaction, content, responsive, or accessibility impact; do not run Designer or create placeholders. |
| Design | `reuse` | Import exact approved design revisions; do not run Designer. |
| Design | `partial` | Run Designer for selected affected outputs only. |
| Design | `full` | Run Designer for a new journey or material experience model. |
| Architecture | `skip` | A bounded change has no boundary, API/schema, data, integration, security, NFR, deployment, or operational impact; do not run Architect or create placeholders. |
| Architecture | `reuse` | Import an accepted architecture pack with current-Run provenance; do not run Architect. |
| Architecture | `partial` | Run Architect for declared affected outputs while preserving the accepted direction. |
| Architecture | `full` | Run the Architect discovery, options, selection, selected-state, and acceptance flow. |

Unknown impact never justifies `direct`, `skip`, or `reuse`. If later evidence contradicts a disposition, invalidate affected downstream clearance and return to that impact check. Verification remains required for production-code changes, including the bounded Bug fast path.

## Owner-aware artifact resolution

Resolve every artifact by identity, never by a guessed directory or “latest” filename:

1. Find its `owner` and `path` in `ai-native.yaml`.
2. Start with `paths.outputs`.
3. Append the artifact owner's `output.subdirectory` from `.ai-sdlc/roles/<owner>/config.yaml` when configured.
4. Append the registered artifact `path`.
5. In a platform-managed Run, use the active execution contract's resolved task-scoped path when supplied.

When supplied by the platform, the active execution contract is authoritative for selected inputs, selected outputs, immutable paths, revisions, and write boundaries. Otherwise use the bounded direct-IDE fallback below. Modify only selected outputs; leave every unselected registered artifact byte-for-byte unchanged. Directory artifacts contain only the files required by their role contract. Start architecture reading at the `architecture` index and follow its active links.

### Direct IDE fallback

A direct IDE session has no Web execution contract. Before invoking a role, the human must supply one explicit execution brief in the current request that names the phase, resolved immutable Change Contract path, evidence or durable decision references for upstream gates, selected registered output IDs, and allowed product-source scope. Resolve artifact paths from the registry and owner config above; use the registered basename because no task-and-Run path pin exists. If the phase, selected outputs, required evidence, or write boundary is missing or contradictory, stop and ask the human instead of guessing.

This brief authorizes only the named local work. It is not a platform clearance, revision pin, artifact-head review, mutation guard, trusted runner event, or semantic-gate result, and no Agent may describe it as one. `direct`, `skip`, and `reuse` remain human routing choices supported by durable evidence; those routes omit the corresponding Agent instead of asking it to create a placeholder record.

## Shared evidence and staleness rules

- Within the repository workflow, apply instructions in this order: supplied platform execution contract or direct-IDE execution brief; `ai-native.yaml`; the native Agent's authority boundaries; this shared workflow; the role workflow; focused references; artifact template schema.
- The immutable Change Contract and durable human decisions outrank generated recommendations. Accepted ADRs remain active until a human supersedes them.
- Treat verified repository/runtime behavior as evidence, not as permission to override a higher active contract. Expose contradictions and return them to the owning phase.
- A valid `direct`, `skip`, or `reuse` clearance replaces unnecessary placeholder files, not review evidence.
- A changed upstream artifact, selected revision, clearance, rulebook digest, architecture selection, implementation revision, linked-workspace binding, or relevant content hash makes dependent evidence stale and requires the owning workflow to revalidate it.
- Older initialized projects may be resolved compatibly by the platform, but roles must not rewrite project-owned configuration merely to match a newer template.

## Human and machine language

Use `project.locale` for explanatory prose. Keep artifact IDs, stable requirement/decision IDs, enum values, JSON/YAML keys, exact validator headings, selection markers, sentinels, hashes, and other machine-contract tokens canonical. If localized prose contradicts a machine token, stop and repair the contract instead of guessing.

## Human-readable output contract

Every phase writes for a human reviewer first, while preserving the exact template and machine fields:

1. Start with the conclusion, current status, and the next human action. Do not make the reviewer search through background material to learn whether the work is ready or blocked.
2. Use short paragraphs, concrete verbs, and the project's ordinary words. Explain an unavoidable specialist term in one plain sentence the first time it appears.
3. Separate confirmed facts, recommendations, risks, and unknowns. Never hide an unknown behind confident or abstract language.
4. Prefer a small table only when it makes a comparison or traceability map easier to scan. Do not repeat the same point in several sections merely to make the artifact longer.
5. Keep canonical headings, IDs, hashes, paths, commands, thresholds, and evidence rows exact. Plain language improves the explanation; it never weakens a gate or removes required evidence.
