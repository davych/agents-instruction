# <US-ID>: <Story title>

**PRD:** [PRD](<relative-path-to-prd.md>)
**Status:** <Draft / Confirmed / Superseded>
**Sources:** <Links, paths, or Inline request>

## User story

As a <user>, I want <capability>, so that <user or business value>.

## Outcome and boundary

- **Expected outcome:** <Observable value>
- **Included:** <Behavior covered by this story>
- **Not included:** <Important boundary or None>

## Business flow

### Core path

1. <Starting situation or user action>
2. <Observable product behavior>
3. <Completed outcome>

### Alternate and failure paths

- **<Situation>:** <Condition> → <Observable response>

## Business rules

- `BR-001`: <Applicable rule>

## Acceptance criteria

### <US-ID>-AC-01: <Core behavior>

```gherkin
Given <starting business context>
When <user action or business event>
Then <observable outcome>
```

### <US-ID>-AC-02: <Relevant alternate or failure behavior>

```gherkin
Given <supported condition>
When <user action or business event>
Then <observable handling or recovery>
```

## Assumptions

- <Assumption or None>

## Decision record

| Topic | Selected option | Decided by | Source |
|---|---|---|---|
| <Topic or None> | <Selected answer> | <Person> | <Conversation or link> |
