# Default workflow

Use `ai-native.yaml` as the source of truth and work in this order:

1. PM / BA creates a short PRD and categorized user stories.
2. Designer reads the PRD and stories, updates the design baseline, and creates the design spec.
3. Architect reads the product and design outputs, compares divergent options, waits for human selection, and then completes the indexed architecture pack.
4. Software Engineer implements the confirmed work and records implementation notes.
5. Tester checks the acceptance criteria and creates the test report.
6. DevOps prepares release, monitoring, and rollback guidance.

Start artifacts from `.ai-sdlc/templates/`. Resolve every input and output artifact in this order:

1. Find the artifact in `ai-native.yaml` and read its `owner` and `path`.
2. Start with `paths.outputs` from `ai-native.yaml`.
3. If `.ai-sdlc/roles/<owner>/config.yaml` exists, append that role's `output.subdirectory`.
4. Append the artifact `path`.

Always use the artifact owner's config, not the active role's config. The global output root always comes from `ai-native.yaml` and defaults to `docs/`.

An artifact path may name one file or a directory. When it names a directory, read only the files required by that artifact's role contract. Start architecture work and every downstream architecture handoff at the `architecture` index, then follow its active links instead of scanning the whole output tree. Child architecture artifacts listed as phase inputs declare the exact evidence that role needs; they never override the index status or make a pending item active.

Meet the phase gate in `ai-native.yaml` before moving forward. Record handoff evidence in the active task file.
