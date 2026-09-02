# Project

`create-ai-native-sdlc` is a small Node.js CLI. It adds one simple AI-native delivery workflow to a target project.

# Product rules

- Keep the fixed phase order: discovery, design, architecture, implementation, verification, release.
- Keep the role owners: PM / BA, Designer, Architect, Software Engineer, Tester, DevOps.
- Let the user initialize any subset of role agents. A missing local role is not a missing phase or a hard dependency.
- Leave technology choices out of initialization. The Architect creates the technology profile when architecture work first needs it.
- Generate the repository artifact bridge Skill and host registry every time. Keep the bridge read-only and do not add MCP, cloning, copying, or synchronization to it.
- Keep one main Markdown source for each role in `templates/agents/`.
- Generate files only for the AI tool selected by the user.
- Do not add a web app, server, database, dashboard, or system that runs the workflow.
- Do not add sync, migration, manifest, or upgrade systems without a clear user need.
- Use simple English. State each rule once.

# Code rules

- Use the Node.js standard library when it is enough.
- Initialization is create-only. Never overwrite an existing file.
- Check every destination before writing.
- On failure, remove only unchanged files created by the current command.
- Keep tool-specific rendering in `bin/cli.js`.
- Update tests when output paths or generated content change.

# Checks

Run:

```bash
npm test
npm pack --dry-run
```
