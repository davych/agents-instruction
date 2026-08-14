# Architecture Pack: {topic}

**Status:** {Awaiting human selection / Drafting / Blocked / Ready for human acceptance / Accepted for implementation}
**Updated:** {YYYY-MM-DD}
**Selected option:** {option ID or Not selected}
**Selection evidence:** {human decision link or Not provided}
**Accepted by:** {human owner or Not accepted}
**Acceptance evidence:** {decision link or Not provided}

## Problem and Inputs

{State the architecture problem in one short paragraph.}

| Input | Resolved Path | Revision or Date | Status |
|-------|---------------|------------------|--------|
| {artifact or source} | {path} | {revision} | {Confirmed / Assumed / Stale} |

## Selected Direction

{Summarize the human-selected direction and why it fits the confirmed constraints. If no option is selected, link the options document, state that selected-state artifacts are pending, and continue to the Pack Index.}

## Hard Constraints

> Include only rules from accepted ADRs that still apply.

- **Must:** {active constraint}
- **Do not:** {prohibited choice from an accepted ADR}

## Pack Index

> Resolve these links from the artifact paths in `ai-native.yaml`. Do not assume the default directory names.

| Artifact | Relative Link | Status | Last Checked |
|----------|---------------|--------|--------------|
| Discovery context | {relative link} | {status} | {date} |
| Options | {relative link} | {status} | {date} |
| C4 system context | {relative link} | {status} | {date} |
| C4 containers | {relative link} | {status} | {date} |
| ADR directory | {relative link} | {status} | {date} |
| Pattern decisions | {relative link} | {status} | {date} |
| NFR budgets | {relative link} | {status} | {date} |
| Independent adversarial review | {relative link} | {status} | {date} |

## ADR Register

| ADR | Status | Applies Now | Agent-readable Rule |
|-----|--------|-------------|---------------------|
| {link} | {Proposed / Accepted / Rejected / Superseded} | {Yes / No} | Must: {rule}. Do not: {rule}. |

## Open Human Decisions

- [ ] {decision, owner, evidence needed, and impact}

## Handoff

**Complete:** {items}
**Provisional:** {items}
**Blocked:** {items and reason}
**Next owner:** {human or workflow role}
