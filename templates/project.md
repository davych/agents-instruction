# AI-native delivery workflow

**Project:** {{PROJECT_NAME}}

**Goal:** {{PROJECT_SUMMARY}}

Read `.ai-sdlc/project-profile.md` for the local role agents, generated developer identities, engineering areas, phase coverage, Architecture source, and detected project evidence.

Read `.ai-sdlc/workflow.md` for the process.

Read `.ai-sdlc/installation.json` for the repository ID, active delivery mode, and authoritative role configuration.

Read `docs/ai-sdlc/index.md` to find the delivery documents that exist.

When a required delivery document is not local, read `.ai-sdlc/artifact-hosts.json` and use the `sdlc-artifact-bridge` skill in `.agents/skills/sdlc-artifact-bridge/` to resolve its configured host. Resolve technology from the catalog path first, match its Repository ID exactly to this installation's `repositoryId` plus the engineering area, select the deployable or Scope ID set affected by the request and code paths, and then read only those child profiles. Ask if that set remains ambiguous. The bridge reads artifacts; it does not clone, copy, synchronize, or write across repositories.

Available dedicated role agents are in `{{AGENTS_DIRECTORY}}`; their exact list and coverage are in the project profile. A missing role agent is not a dependency on another role and does not imply that its artifacts do not exist elsewhere.
