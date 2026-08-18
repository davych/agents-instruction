# Security rule pack

**Status:** Starter project policy. Unknown identity, authorization, or data-classification facts block readiness; they are not filled with generic assumptions.

**Load when:** A user or service identity, protected action, trust boundary, or sensitive field is in scope.

| ID | Level | Deviation | Trigger | Requirement | Required evidence |
|----|-------|-----------|---------|-------------|-------------------|
| `SEC-001` | `MUST` | `N/A` | An authenticated user or service request crosses a process or trust boundary. | Define whether identity is propagated, exchanged, or replaced by a service identity. Validate issuer, audience, expiry, and intended scope at the receiving boundary; do not blindly forward end-user credentials or trust client-supplied identity fields. | Trust relationship in C4, authentication Pattern/ADR, negative tests, and security NFR or gate. |
| `SEC-002` | `MUST` | `N/A` | Data or an action is protected. | Enforce authorization at the server-side owning boundary and at object/action granularity where relevant. Default deny, name the policy owner, and never treat frontend hiding or gateway authentication alone as authorization. | Authorization boundary and owner in C4/ADR, policy Pattern, and denial-path tests. |
| `SEC-003` | `MUST` | `N/A` | The system receives, stores, logs, or transmits fields whose sensitivity is unknown or confirmed. | Classify fields before selecting controls. For sensitive fields define minimization, response allowlists, masking/redaction, encryption boundaries, secret handling, log/trace exclusion, retention/deletion, and authorized consumers. | Classification evidence in Discovery, ownership/C4, Pattern or ADR, security/privacy NFR, and malicious-input review. |

## Placement guidance

- Authentication proves or establishes identity; authorization decides whether that identity may perform this action on this resource. Keep both boundaries explicit.
- A request or trace identifier is correlation metadata, never authorization evidence.
- If field classification lacks an accountable owner, mark `SEC-003` Blocked rather than calling all data public or sensitive by assumption.
