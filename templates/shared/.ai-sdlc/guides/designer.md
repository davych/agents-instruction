# How to use the Designer

The project has one Designer Agent file. Read `paths.agents` in `ai-native.yaml`, then add `/designer.md` to find it. The Designer config, rules, and workflows are in `.ai-sdlc/roles/designer/`.

Before starting:

1. Configure role inputs in `.ai-sdlc/roles/designer/config.yaml`.
2. Set up the component query if the task needs real project components.
3. Give your AI tool access to the project. Tell it to read the Designer Agent and Skill.
4. For Figma work, provide the real reference or target file. Make sure the current session can access Figma.

Use this common task prompt in any client:

```text
Read ai-native.yaml, append /designer.md to paths.agents, and read that single
Designer Agent. Then read .ai-sdlc/roles/designer/config.yaml and
.ai-sdlc/roles/designer/SKILL.md.

Act as the Designer for this task: [describe the result you want].
Inputs: [requirements, Markdown paths, screenshots, or references].
Expected output: [design baseline, design SPEC, Figma work, or build guidance].

Use the output root and file name from ai-native.yaml. The role config may only add its
output.subdirectory. Check project components before naming APIs. For Figma work, read
.ai-sdlc/roles/designer/references/figma-workflow.md first. Report evidence,
assumptions, checks, risks, and the next step.
```

## GitHub Copilot

1. Open the project in Copilot Chat and make sure it can read project files.
2. If needed, open or attach `ai-native.yaml` and the Designer Agent file.
3. Send the common prompt above. Keep later questions in the same chat and project.
4. Before asking Copilot to edit Figma, make sure the current Copilot session has a Figma tool.

Reference: [GitHub Copilot Chat prompting](https://docs.github.com/en/copilot/how-tos/copilot-on-github/chat-with-copilot/get-started-with-chat).

## Claude Code

1. Start Claude Code from the initialized project root.
2. Send the common prompt with the exact task and input paths.
3. Tell Claude Code to read the Designer path from `ai-native.yaml`. This keeps the setup independent of special startup files.
4. For Figma work, make Figma available in the current session and provide the target URL or reference.

Reference: [Claude Code quickstart](https://code.claude.com/docs/en/quickstart).

## Codex

1. Open the project as the Codex workspace, or start Codex from the project root.
2. Send the common prompt and clearly name the design output you want.
3. This initializer does not create a second `AGENTS.md` copy. Tell Codex to read the one Designer Agent path from `ai-native.yaml`.
4. For Figma work, make a Figma tool available. Ask for real screenshots or node IDs before accepting the result.

Reference: [OpenAI Codex project instruction discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md).
