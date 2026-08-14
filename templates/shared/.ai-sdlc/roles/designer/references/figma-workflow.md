# Figma workflow

Use this workflow only when the user asks for Figma work or gives you an approved Figma reference. Never assume a Figma tool, file access, or component library is available. Never save passwords, tokens, or private file IDs in role files.

## 1. Preflight

1. Confirm the task: inspect, create, revise, prototype, or compare.
2. Confirm the target file, page, screens, states, and screen sizes. Do not make up a target.
3. Check that the current session can read the file and, when needed, edit it. If it cannot edit, offer a SPEC or a clear change plan. Do not claim that you changed the file.
4. Read the PRD, relevant story files, current design baseline, similar screens, and approved visual references.
5. Check the project component list before naming component APIs. A Figma library is useful evidence, but it does not replace checks in the project.

## 2. Build a component inventory

Before building screens, list the components you need and check them against:

1. Existing project patterns.
2. Shared or local components in the target Figma file.
3. Verified project tokens, styles, and variables.
4. A justified custom component following `component-policy.md` when no suitable component exists.

List unknown components as open questions. Do not quietly replace them with something that only looks similar. A drawn copy or imported SVG is not a component instance.

When a library is available, keep a clear `Components used` list in the working file. Use real component instances. If the active tool exposes a stable component key or ID, record the component name and that key or ID in the list.

## 3. Assemble the design

- Prefer component instances and variants; do not detach or redraw an available component.
- Use auto-layout, or the target file's layout system, for reusable groups.
- Bind color, spacing, typography, and effects to verified styles or variables when they exist.
- Follow the project baseline for shell, density, hierarchy, and interaction patterns.
- Use basic Figma layers only when available components do not fit. Name them clearly as local design work.
- Name frames with the screen, state, and viewport when multiple variants exist.
- Work incrementally and verify each meaningful section before continuing.

## 4. Verify and hand off

1. Capture or inspect each finished frame. Check hierarchy, spacing, overflow, clipping, contrast, and states.
2. When matching an approved reference, compare both at the same screen size and fix visible differences.
3. Record real file and node IDs only after access or creation works.
4. State which elements reuse verified components and which are custom or unresolved. Include verified component keys or IDs when the active tool provides them.
5. Update the design SPEC under the output path derived from `ai-native.yaml`. Add a `figma` field only when real file and node information exists.

Never make up a Figma URL. Never say you changed a file unless you checked the change. Never call a result pixel-perfect without an approved reference and a rendered comparison.

## Request template

```text
Act as the project Designer. Read ai-native.yaml, append /designer.md to paths.agents,
and read that Agent. Then follow .ai-sdlc/roles/designer/SKILL.md and
.ai-sdlc/roles/designer/references/figma-workflow.md.

Task: [inspect/create/revise/compare]
Target Figma file or reference: [URL or attached frame]
PRD, story, or SPEC: [path]
Screens, states, and viewports: [scope]
Expected output: [SPEC handoff, Figma update, or visual comparison]

Use only components and tokens verified in this project or target file. Report missing
access, unknown components, checks you ran, and real node IDs.
```
