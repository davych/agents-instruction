# How to use the Designer

The initializer installs one native Designer Agent for the selected AI client. `ai-native.yaml` records the client and native Agent directory. The shared Designer config, rules, and workflow are in `.ai-sdlc/roles/designer/`.

Before starting:

1. Read the immutable Change Contract and record Design Impact as `skip`, `reuse`, `partial`, or `full`.
2. Invoke Designer only for `partial` or `full`; the platform handles `skip` and `reuse` without a Codex execution.
3. Configure role inputs in `.ai-sdlc/roles/designer/config.yaml`.
4. Set up the component query if the task needs real project components.
5. Give your AI tool access to the project. Tell it to read the Designer Agent and role workflow.
6. For Figma work, provide the real reference or target file. Make sure the current session can access Figma.

When the platform opens the design execution dialog for `partial` or `full`, the execution contract's selected output list controls what Designer may create or update. Select `design-baseline` only for missing or changed project-wide evidence and `design-spec` for task behavior. Select `design-prototype` when a self-contained HTML interaction prototype will help validation, and `figma-handoff` only when the Figma integration is configured and authorized. `skip` creates no placeholder; `reuse` imports approved current-Run heads.

Use this common task prompt in any client:

```text
Use the project Designer Agent. Read ai-native.yaml,
.ai-sdlc/roles/designer/config.yaml, and
.ai-sdlc/roles/designer/workflow.md.

Act as the Designer for this task: [describe the result you want].
Immutable Change Contract: [resolved task-scoped path].
Design disposition: [partial or full].
Inputs: [Product clearance, relevant PRD/story evidence, screenshots, or references].
Expected output: [the selected registered outputs: design-baseline, design-spec, design-prototype, and/or figma-handoff].

Use the exact resolved output path from the active execution contract. For a task-scoped
design-spec this includes the current task name and run ID; do not replace it with the
default basename from ai-native.yaml. The role config may only add its output.subdirectory.
Check project components before naming component props, events, slots, or tokens. For Figma work, read
.ai-sdlc/roles/designer/references/figma-workflow.md first. Report evidence,
assumptions, checks, risks, and the next step.
```

For a generated Software Engineer handoff, require the design SPEC to use status `ready-for-engineering` with an empty `blockers` list. The handoff must name the covered Change Contract/story criteria, required behavior, verified components and assets, responsive and accessibility constraints, validation evidence, and any design detail the developer must not infer. For `skip` or `reuse`, hand off the structured clearance and provenance instead of running this prompt.

## GitHub Copilot

1. Open the initialized project with GitHub Copilot.
2. Select the Designer custom agent, or ask Copilot to use the Designer Agent.
3. Send the common prompt above. Keep later questions in the same chat and project.
4. Before asking Copilot to edit Figma, make sure the current Copilot session has a Figma tool.

Reference: [GitHub Copilot Chat prompting](https://docs.github.com/en/copilot/how-tos/copilot-on-github/chat-with-copilot/get-started-with-chat).

## Claude Code

1. Start Claude Code from the initialized project root.
2. Ask Claude Code to use the Designer subagent installed for this project.
3. Send the common prompt with the exact task and input paths.
4. For Figma work, make Figma available in the current session and provide the target URL or reference.

Reference: [Claude Code quickstart](https://code.claude.com/docs/en/quickstart).

## Codex

1. Open the project as the Codex workspace, or start Codex from the project root.
2. The initializer generated `.codex/agents/designer.toml` from the canonical Designer Markdown source. Ask Codex to use the Designer custom agent.
3. Send the common prompt and clearly name the design output you want.
4. For Figma work, make a Figma tool available. Ask for real screenshots or node IDs before accepting the result.

Reference: [OpenAI Codex custom agents](https://learn.chatgpt.com/docs/agent-configuration/subagents).
