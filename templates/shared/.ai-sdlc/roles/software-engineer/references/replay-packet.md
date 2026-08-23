# Engineering replay packet

A replay packet captures enough sanitized evidence to reproduce and triage a failed or materially blocked engineering run without relying on the original author's memory. It is not a dump of the entire conversation, environment, or repository.

## When to create a full packet

- implementation or required verification repeatedly fails;
- the run produces a materially wrong or incomplete result;
- an environment/tool failure prevents the evidence gate;
- a contract ambiguity or stale clearance blocks safe progress;
- an unsafe or policy-relevant Agent action needs investigation.

The replay packet is conditional support, not a registered Run artifact and not part of the Web phase gate. Create it manually only when a failed or disputed run needs triage. A successful run produces no replay packet; never fabricate failure data to fill the template.

## Required full-packet content

1. Sensitivity classification, redactions, allowed audience, and handling limits.
2. Run/task identity and a sanitized original request or exact authoritative contract reference.
3. Exact input artifact revisions and a bounded context snapshot.
4. Model/tool metadata and relevant reproducible configuration, when known.
5. Ordered action and command log with results.
6. Expected output, actual output, and evidence of the mismatch or blocker.
7. Failure classification and first known divergence.
8. Minimal reproduction steps and prerequisites.
9. Triage recommendation, responsible owner, and next safe action.

## Failure classes

- `implementation bug`
- `test bug`
- `spec ambiguity`
- `stale or invalid clearance`
- `environment or tooling failure`
- `security or policy blocker`
- `unknown`

## Safety and fidelity

- Redact credentials, tokens, personal data, production payloads, and unrelated proprietary content before saving.
- Prefer hashes, revision IDs, bounded excerpts, and links over copying entire artifacts or logs.
- Record omitted or redacted material and why it was removed.
- Do not access production data to improve a replay packet.
- Do not alter the original Change Contract or evidence to make replay easier.
- Mark a hypothesis as a hypothesis. Do not rewrite uncertain history as fact.
- A replay packet proposes triage; it does not approve a security exception, risk acceptance, merge, deployment, or release.
