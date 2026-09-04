# Project

`create-ai-native-sdlc` is a small Node.js CLI. It adds one simple AI-native delivery workflow to a target project.

# Product rules

- Keep the fixed phase order: discovery, design, architecture, implementation, verification, release.
- Keep the role owners: PM / BA, Designer, Architect, Software Engineer, Tester, DevOps.
- Let the user initialize any subset of role agents. A missing local role is not a missing phase or a hard dependency.
- Keep `software-engineer` as the single Implementation owner. Generate frontend, backend, full-stack, or separate frontend/backend developer agents from its recorded scope.
- Record one stable repository ID at initialization and match technology catalog rows by that exact ID plus frontend/backend area.
- Leave technology choices out of initialization. The Architect creates the technology profile when architecture work first needs it.
- Let an Architect-only delivery repository create scoped frontend and backend technology profiles without initializing developer agents or changing code repositories.
- Generate the repository artifact bridge Skill and host registry every time. Keep the bridge read-only and do not add MCP, cloning, copying, or synchronization to it.
- Keep one main Markdown source for each role in `templates/agents/`.
- Generate files only for the AI tool selected by the user.
- Do not add a web app, server, database, dashboard, or system that runs the workflow.
- Do not add sync, migration, manifest, or upgrade systems without a clear user need.
- Use simple English. State each rule once.

# Code rules

- Use the Node.js standard library when it is enough.
- Initialization is create-only and never overwrites an existing file.
- Update only documented CLI-managed workflow, template, bridge, and selected role files. Require current installation metadata; do not migrate older schemas. Never replace existing project configuration or delivery artifacts.
- Check every destination before writing.
- On failure, restore safely replaced files and remove only unchanged files created by the current command.
- Keep tool-specific rendering in `bin/cli.js`.
- Update tests when output paths or generated content change.

# Checks

Run:

```bash
npm test
npm pack --dry-run
```
