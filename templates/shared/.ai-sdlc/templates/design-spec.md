```json
{
  "spec_version": "1.0",
  "title": "<Feature or change>",
  "mode": "new",
  "status": "draft",
  "framework": "<verified project framework or unknown>",
  "source": ["artifact:change-contract", "artifact:prd-or-user-stories-when-applicable", "artifact:design-baseline"],
  "screens": [
    {
      "id": "<screen-id>",
      "layout": "<verified project pattern>",
      "states": ["default"]
    }
  ],
  "components": [],
  "acceptance_criteria": [
    {
      "id": "US-001-AC-01",
      "requirement": "<Supplied acceptance criterion>",
      "design_response": "<Observable design response>"
    }
  ],
  "assumptions": [],
  "open_questions": [],
  "blockers": [],
  "deferred_validations": []
}
```

# <Feature or change>

## Intent

State the user outcome and design boundary.

## Coverage

List the relevant story and acceptance-criteria IDs. State any confirmed exclusion.

## Experience and layout

Describe hierarchy and verified project patterns. Reference relevant acceptance criteria such as US-001-AC-01.

## States and behavior

Describe only states and transitions that can occur.

## Responsive behavior

Describe what changes at each verified viewport. Write `Not applicable` when the surface has no responsive variation.

## Components and assets

List verified components, custom-component reasons, content status, assets, and real reference links.

## Accessibility and content

Describe keyboard and focus behavior, labels, error feedback, reading order, contrast needs, and final or draft copy when applicable.

## Validation

Record component-query evidence, tested viewports, accessibility checks, and any approved reference comparison.

## Handoff to Software Engineer

The JSON `status` is the handoff status. Use `ready-for-engineering` only when `blockers` is empty. This status means the design is complete enough to implement; it is not product, legal, accessibility, or architecture approval. The architecture phase gate must also pass before implementation starts.

**Next owner:** Software Engineer

### Build scope

- <Story and acceptance-criteria IDs covered by this design>

### Behavior to preserve

- <Required flow, state, responsive, accessibility, content, or visual constraint>

### Do not infer

- <Missing decision or behavior the developer must return to the named owner, or None>

### Allowed design flexibility

- <Detail the developer may adapt without changing the intended experience, or None>

### Validation evidence

- <Validator result, component evidence, viewport check, screenshot, Figma node, or other real evidence>

### Deferred verification

- <Obligation ID, runnable prerequisite, targets, checks, pass criteria, supported evidence types, and the explicit on-fail/on-missing Verification block, or None>

### Open decisions and blockers

- <Blocker, owner, impact, and next action, or None>
