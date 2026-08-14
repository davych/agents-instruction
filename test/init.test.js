import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { run } from "../bin/cli.js";

const temporaryDirectories = [];
const roleIds = ["pm-ba", "designer", "architect", "software-engineer", "tester", "devops"];

test.after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("interactive init writes one generic agent set to the default directory", async () => {
  const target = await temporaryDirectory();
  const questions = [];
  const prompt = answers([
    "Solo Product",
    "A small product",
    "",
    "docs/context.md, docs/brand.md",
    "tools/component-catalog.mjs"
  ], questions);

  assert.equal(await run(["init", target], { prompt, output: () => {} }), 0);
  assert.equal(questions.length, 5);

  const config = await readFile(path.join(target, "ai-native.yaml"), "utf8");
  assert.match(config, /name: "Solo Product"/u);
  assert.match(config, /summary: "A small product"/u);
  assert.match(config, /agents: "\.ai-sdlc\/agents"/u);
  assert.doesNotMatch(config, /clients:/u);
  assert.match(config, /outputs: docs/u);
  assert.match(config, /id: prd, owner: pm-ba, path: prd\.md/u);
  assert.match(config, /id: user-stories, owner: pm-ba, path: user-stories/u);
  assert.match(config, /outputs: \[prd, user-stories\]/u);
  assert.match(config, /owner: designer\n      inputs: \[prd, user-stories\]/u);
  assert.match(config, /owner: architect\n      inputs: \[prd, user-stories, design-spec\]/u);
  assert.match(config, /outputs: \[architecture, architecture-discovery-context, architecture-options, architecture-c4-context, architecture-c4-containers, architecture-adrs, architecture-patterns, architecture-nfrs, architecture-adversarial\]/u);
  assert.match(config, /owner: software-engineer\n      inputs: \[prd, user-stories, design-baseline, design-spec, architecture, architecture-c4-containers, architecture-adrs, architecture-patterns, architecture-nfrs\]/u);
  assert.match(config, /owner: tester\n      inputs: \[prd, user-stories, architecture, architecture-nfrs, implementation-notes\]/u);
  assert.match(config, /owner: devops\n      inputs: \[architecture, architecture-adrs, architecture-nfrs, architecture-adversarial, test-report\]/u);
  assert.match(config, /id: design-baseline, owner: designer, path: DESIGN_BASELINE\.md/u);
  assert.match(config, /id: design-spec, owner: designer, path: design-spec\.md/u);
  assert.match(config, /id: architecture, owner: architect, path: architecture\.md/u);
  assert.match(config, /id: architecture-adrs, owner: architect, path: 04-adrs/u);

  for (const roleId of roleIds) {
    await readFile(path.join(target, `.ai-sdlc/agents/${roleId}.md`), "utf8");
  }
  assert.deepEqual(
    (await readdir(path.join(target, ".ai-sdlc/agents"))).sort(),
    roleIds.map((roleId) => `${roleId}.md`).sort()
  );
  const workflow = await readFile(path.join(target, ".ai-sdlc/workflows/default.md"), "utf8");
  assert.match(workflow, /artifact owner/u);
  assert.match(workflow, /\.ai-sdlc\/roles\/<owner>\/config\.yaml/u);
  await readFile(path.join(target, ".ai-sdlc/tasks/README.md"), "utf8");
  const prdTemplate = await readFile(path.join(target, ".ai-sdlc/templates/prd.md"), "utf8");
  const storyTemplate = await readFile(path.join(target, ".ai-sdlc/templates/story.md"), "utf8");
  assert.match(prdTemplate, /\{relative-path-from-prd-to-story\.md\}/u);
  assert.match(storyTemplate, /\{relative-path-from-story-to-prd\.md\}/u);
  assert.deepEqual(
    (await readdir(path.join(target, ".ai-sdlc/templates"))).sort(),
    [
      "architecture-adr.md",
      "architecture-adversarial.md",
      "architecture-c4-containers.mmd",
      "architecture-c4-context.mmd",
      "architecture-discovery-context.md",
      "architecture-nfrs.md",
      "architecture-options.md",
      "architecture-patterns.md",
      "architecture.md",
      "design-baseline.md",
      "design-spec.md",
      "implementation-notes.md",
      "prd.md",
      "release-runbook.md",
      "story.md",
      "test-report.md"
    ]
  );
  const pmBaConfig = await readFile(path.join(target, ".ai-sdlc/roles/pm-ba/config.yaml"), "utf8");
  assert.match(pmBaConfig, /role: "\.ai-sdlc\/agents\/pm-ba\.md"/u);
  assert.match(pmBaConfig, /inputs:\n  markdown: \[\]/u);
  assert.match(pmBaConfig, /output:\n  subdirectory: ai-native\/product/u);
  const pmBaWorkflow = await readFile(path.join(target, ".ai-sdlc/roles/pm-ba/workflow.md"), "utf8");
  assert.match(pmBaWorkflow, /one `story\.md` per story/u);
  assert.doesNotMatch(pmBaWorkflow, /^---/u);
  assert.equal(existsSync(path.join(target, ".ai-sdlc/roles/pm-ba/SKILL.md")), false);
  const architectConfig = await readFile(path.join(target, ".ai-sdlc/roles/architect/config.yaml"), "utf8");
  assert.match(architectConfig, /role: "\.ai-sdlc\/agents\/architect\.md"/u);
  assert.match(architectConfig, /artifacts: \[prd, user-stories, design-spec\]/u);
  assert.match(architectConfig, /domain: null[\s\S]*regulations: \[\][\s\S]*confirmed_peak_load: null/u);
  assert.match(architectConfig, /output:\n  subdirectory: ai-native\/architecture/u);
  assert.match(architectConfig, /minimum_options: 3[\s\S]*minimum_nfrs: 7[\s\S]*minimum_findings_per_stressor: 3/u);
  const architectWorkflow = await readFile(path.join(target, ".ai-sdlc/roles/architect/workflow.md"), "utf8");
  assert.match(architectWorkflow, /Create or update the resolved `architecture` artifact[\s\S]*Check for human selection evidence[\s\S]*`Awaiting human selection` and stop/u);
  assert.match(architectWorkflow, /explicit `Must` and `Do not` rules/u);
  assert.match(architectWorkflow, /fresh session or independent reviewer/u);
  assert.doesNotMatch(architectWorkflow, /^---/u);
  assert.equal(existsSync(path.join(target, ".ai-sdlc/roles/architect/SKILL.md")), false);
  const architectureIndex = await readFile(path.join(target, ".ai-sdlc/templates/architecture.md"), "utf8");
  assert.match(architectureIndex, /Acceptance evidence:[\s\S]*## Pack Index[\s\S]*## ADR Register[\s\S]*## Open Human Decisions/u);
  const designerGuidance = await readFile(path.join(target, ".ai-sdlc/guides/designer.md"), "utf8");
  assert.match(designerGuidance, /## GitHub Copilot[\s\S]*## Claude Code[\s\S]*## Codex/u);
  assert.match(designerGuidance, /ready-for-engineering[\s\S]*empty `blockers` list/u);
  await readFile(
    path.join(target, ".ai-sdlc/roles/designer/references/figma-workflow.md"),
    "utf8"
  );
  const designerConfig = await readFile(path.join(target, ".ai-sdlc/roles/designer/config.yaml"), "utf8");
  assert.match(designerConfig, /role: "\.ai-sdlc\/agents\/designer\.md"/u);
  assert.match(designerConfig, /- "docs\/context\.md"/u);
  assert.match(designerConfig, /output:\n  subdirectory: ai-native\/design\n\ncomponents:/u);
  const designerAgent = await readFile(path.join(target, ".ai-sdlc/agents/designer.md"), "utf8");
  assert.match(designerAgent, /## Start here[\s\S]*## Evidence order[\s\S]*## Working rules[\s\S]*## Output contract[\s\S]*## Boundaries[\s\S]*## Handoff/u);
  assert.match(designerAgent, /Software Engineer[\s\S]*ready-for-engineering/u);
  const designerWorkflow = await readFile(path.join(target, ".ai-sdlc/roles/designer/workflow.md"), "utf8");
  assert.match(designerWorkflow, /Handoff to Software Engineer[\s\S]*ready-for-engineering/u);
  assert.doesNotMatch(designerWorkflow, /^---/u);
  assert.equal(existsSync(path.join(target, ".ai-sdlc/roles/designer/SKILL.md")), false);
  const designSpecTemplate = await readFile(path.join(target, ".ai-sdlc/templates/design-spec.md"), "utf8");
  assert.match(designSpecTemplate, /"blockers": \[\][\s\S]*## Handoff to Software Engineer/u);
  const componentQuery = await readFile(
    path.join(target, ".ai-sdlc/roles/designer/scripts/component-query.mjs"),
    "utf8"
  );
  assert.match(componentQuery, /tools\/component-catalog\.mjs/u);
  assert.doesNotMatch(componentQuery, /VDS|@verso/iu);

  await mkdir(path.join(target, "tools"), { recursive: true });
  await writeFile(path.join(target, "tools/component-catalog.mjs"), `
export async function loadComponentCatalog() {
  return {
    components: [{
      name: "Action",
      aliases: ["Button"],
      frameworks: ["web"],
      props: [{ name: "tone", values: ["primary", "secondary"] }]
    }],
    tokens: [],
    icons: []
  };
}
`, "utf8");

  const queryResult = spawnSync(process.execPath, [
    path.join(target, ".ai-sdlc/roles/designer/scripts/component-query.mjs"),
    "component",
    "Action",
    "--json"
  ], { cwd: target, encoding: "utf8" });
  assert.equal(queryResult.status, 0, queryResult.stderr);
  assert.equal(JSON.parse(queryResult.stdout).matched, true);

  const specPath = path.join(target, "design-spec.md");
  await writeFile(specPath, validSpec(), "utf8");
  const validation = spawnSync(process.execPath, [
    path.join(target, ".ai-sdlc/roles/designer/scripts/validate-spec.mjs"),
    specPath
  ], { cwd: target, encoding: "utf8" });
  assert.equal(validation.status, 0, validation.stdout + validation.stderr);

  const invalidSpecPath = path.join(target, "invalid-design-spec.md");
  await writeFile(invalidSpecPath, "```json\n{\"spec_version\":\"1.0\",\"screens\":{},\"components\":[null]}\n```\n", "utf8");
  const invalidValidation = spawnSync(process.execPath, [
    path.join(target, ".ai-sdlc/roles/designer/scripts/validate-spec.mjs"),
    "--json",
    invalidSpecPath
  ], { cwd: target, encoding: "utf8" });
  assert.equal(invalidValidation.status, 1, invalidValidation.stderr);
  assert.ok(JSON.parse(invalidValidation.stdout).failures > 0);

  const blockedHandoffPath = path.join(target, "blocked-handoff-design-spec.md");
  await writeFile(
    blockedHandoffPath,
    validSpec().replace('"blockers": []', '"blockers": ["Needs a human decision"]'),
    "utf8"
  );
  const blockedHandoffValidation = spawnSync(process.execPath, [
    path.join(target, ".ai-sdlc/roles/designer/scripts/validate-spec.mjs"),
    "--json",
    blockedHandoffPath
  ], { cwd: target, encoding: "utf8" });
  assert.equal(blockedHandoffValidation.status, 1, blockedHandoffValidation.stderr);
  assert.match(blockedHandoffValidation.stdout, /ready-for-engineering requires an empty blockers array/u);

  const emptyHandoffPath = path.join(target, "empty-handoff-design-spec.md");
  await writeFile(
    emptyHandoffPath,
    validSpec().replace(/## Handoff to Software Engineer[\s\S]*$/u, ""),
    "utf8"
  );
  const emptyHandoffValidation = spawnSync(process.execPath, [
    path.join(target, ".ai-sdlc/roles/designer/scripts/validate-spec.mjs"),
    "--json",
    emptyHandoffPath
  ], { cwd: target, encoding: "utf8" });
  assert.equal(emptyHandoffValidation.status, 1, emptyHandoffValidation.stderr);
  assert.match(emptyHandoffValidation.stdout, /A ready-for-engineering SPEC needs ## Handoff to Software Engineer/u);
});

test("interactive init writes the same agents only to a chosen directory", async () => {
  const target = await temporaryDirectory();
  const prompt = answers(["Custom Product", "Custom agent directory", "tooling/agents", "", ""]);

  assert.equal(await run(["init", target], { prompt, output: () => {} }), 0);

  for (const roleId of roleIds) {
    await readFile(path.join(target, `tooling/agents/${roleId}.md`), "utf8");
  }
  assert.equal(existsSync(path.join(target, ".ai-sdlc/agents")), false);
  assert.equal(existsSync(path.join(target, ".ai-sdlc/roles/designer/config.yaml")), true);
  assert.equal(existsSync(path.join(target, ".ai-sdlc/workflows/default.md")), true);
  assert.match(await readFile(path.join(target, "ai-native.yaml"), "utf8"), /agents: "tooling\/agents"/u);
  assert.match(
    await readFile(path.join(target, ".ai-sdlc/roles/designer/config.yaml"), "utf8"),
    /role: "tooling\/agents\/designer\.md"/u
  );
  assert.match(
    await readFile(path.join(target, ".ai-sdlc/roles/pm-ba/config.yaml"), "utf8"),
    /role: "tooling\/agents\/pm-ba\.md"/u
  );
  assert.match(
    await readFile(path.join(target, ".ai-sdlc/roles/architect/config.yaml"), "utf8"),
    /role: "tooling\/agents\/architect\.md"/u
  );
});

test("init rejects unsafe output paths before writing anything", async () => {
  const target = await temporaryDirectory();
  const outside = await temporaryDirectory();
  await symlink(outside, path.join(target, ".external-link"));

  await assert.rejects(
    run(["init", target], {
      prompt: answers(["Safe Product", "Do not escape the project", ".external-link/agents", "", ""]),
      output: () => {}
    }),
    /\.external-link\//u
  );

  assert.equal(existsSync(path.join(target, "ai-native.yaml")), false);
  assert.equal(existsSync(path.join(target, ".ai-sdlc")), false);
  assert.deepEqual(await readdir(outside), []);

  const danglingTarget = await temporaryDirectory();
  const danglingOutside = await temporaryDirectory();
  const danglingAgents = path.join(danglingTarget, "custom-agents");
  const danglingOutsideFile = path.join(danglingOutside, "pm-ba.md");
  await mkdir(danglingAgents);
  await symlink(danglingOutsideFile, path.join(danglingAgents, "pm-ba.md"));

  await assert.rejects(
    run(["init", danglingTarget], {
      prompt: answers(["Safe Product", "Reject dangling links", "custom-agents", "", ""]),
      output: () => {}
    }),
    /custom-agents\/pm-ba\.md/u
  );
  assert.equal(existsSync(danglingOutsideFile), false);
  assert.equal(existsSync(path.join(danglingTarget, "ai-native.yaml")), false);

  const collisionTarget = await temporaryDirectory();
  await assert.rejects(
    run(["init", collisionTarget], {
      prompt: answers([
        "Safe Product",
        "Reject planned collisions",
        ".ai-sdlc/roles/designer/config.yaml",
        "",
        ""
      ]),
      output: () => {}
    }),
    /\.ai-sdlc\/roles\/designer\/config\.yaml/u
  );
  assert.equal(existsSync(path.join(collisionTarget, "ai-native.yaml")), false);
  assert.equal(existsSync(path.join(collisionTarget, ".ai-sdlc")), false);
});

function answers(values, questions) {
  const queue = [...values];
  return async (question) => {
    questions?.push(question);
    return queue.shift() ?? "";
  };
}

function validSpec() {
  return `\`\`\`json
{
  "spec_version": "1.0",
  "title": "Generic design",
  "mode": "new",
  "status": "ready-for-engineering",
  "framework": "web",
  "source": ["artifact:prd", "artifact:user-stories"],
  "screens": [{ "id": "main", "layout": "project pattern", "states": ["default"] }],
  "components": [{ "name": "Action", "source": "project", "props": { "tone": "primary" } }],
  "acceptance_criteria": [{
    "id": "US-001-AC-01",
    "requirement": "A clear action",
    "design_response": "The main action is identifiable"
  }],
  "blockers": []
}
\`\`\`

# Generic design

US-001-AC-01 is addressed by the verified project component.

## Handoff to Software Engineer

The design is ready for the Software Engineer. The required behavior is covered by US-001-AC-01 and there are no blockers.

**Next owner:** Software Engineer

### Build scope

- US-001 and US-001-AC-01.

### Behavior to preserve

- Keep the main action identifiable.

### Do not infer

- None.

### Allowed design flexibility

- None.

### Validation evidence

- The configured project component matched and the SPEC validator passed.

### Open decisions and blockers

- None.
`;
}

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-native-interactive-"));
  temporaryDirectories.push(directory);
  return directory;
}
