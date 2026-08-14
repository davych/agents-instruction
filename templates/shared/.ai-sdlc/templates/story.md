# <US-ID>: <Story title>

**Category:** <business-category>
**PRD:** [PRD]({relative-path-from-story-to-prd.md})
**Status:** Draft for human review
**Sources:** <Source paths or Not provided>
**Priority:** See the PRD story index

## User story

As a <user>, I want <capability>, so that <user or business value>.

## Outcome and confirmed boundary

- **Expected outcome:** <Observable value>
- **Included:** <Confirmed behavior this story covers>
- **Not included:** <Confirmed behavior this story does not cover, or None confirmed>

## Business flow

### Core path

1. <User situation or action>
2. <Observable product behavior>
3. <Completed outcome>

### Failure or alternate paths

- **<Named situation>:** <Business condition> → <Observable response>

## Business rules

- `<BR-ID>`: <Rule used by this story>

## Acceptance criteria

### <US-ID>-AC-01: <Core path>

```gherkin
Given <starting business context>
When <user action or business event>
Then <observable outcome>
And <other observable outcome, if needed>
```

### <US-ID>-AC-02: <Relevant failure path>

```gherkin
Given <failure condition supported by the evidence>
When <user action or business event>
Then <observable handling or recovery>
```

### <US-ID>-AC-03: <Real boundary, if needed>

Write a Gherkin scenario only when a confirmed business boundary applies. Otherwise write `Not applicable — no business boundary is defined.`

## Assumptions

- <Assumption or None>

## Open questions for a human

- [ ] <Question or None>
