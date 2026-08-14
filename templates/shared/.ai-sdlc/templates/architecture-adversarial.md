# Independent Architecture Premortem: {topic}

**Status:** {Pending independent review / Complete}
**Reviewed pack revision:** {revision or date}
**Reviewer or session:** {independent reviewer or fresh-session reference}
**Independence evidence:** {evidence or Not provided}

## Stressor 1: 10x Confirmed Peak Load

**Confirmed peak baseline:** {value, window, and source or Missing}

| ID | Failing Location | Trigger | Visible Symptom | Mitigation or Risk for Human Acceptance | Owner | Affected Artifact |
|----|------------------|---------|-----------------|-----------------------------|-------|-------------------|
| ADV-L-01 | {C4 alias} | {load condition} | {user or operator symptom} | {mitigation or risk proposed to a human} | {owner} | {ADR, NFR, or diagram} |

## Stressor 2: Malicious Input

| ID | Failing Location | Attack Path | Impact | Mitigation or Risk for Human Acceptance | Owner | Affected Artifact |
|----|------------------|-------------|--------|-----------------------------|-------|-------------------|
| ADV-S-01 | {C4 alias} | {relevant abuse path} | {impact} | {mitigation or risk proposed to a human} | {owner} | {ADR, NFR, or diagram} |

## Stressor 3: External Dependency Down for Two Hours

| ID | Failing Location | Failed Dependency | Visible Symptom | Mitigation or Risk for Human Acceptance | Owner | Affected Artifact |
|----|------------------|-------------------|-----------------|-----------------------------|-------|-------------------|
| ADV-D-01 | {C4 alias} | {dependency} | {user or operator symptom} | {mitigation or risk proposed to a human} | {owner} | {ADR, NFR, or diagram} |

Repeat the finding row in each stressor until it reaches `quality.minimum_findings_per_stressor`.

## Required Pack Changes

- [ ] {change, owner, and affected artifact}

## Human Risk Acceptances

- [ ] {risk, human owner, expiry or review date}

A review from the same session that created the pack is not independent. If independence or the load baseline is missing, record the gap instead of inventing evidence.
