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
  const prompt = answers([
    "Solo Product",
    "A small product",
    "",
    "docs/context.md, docs/brand.md",
    "tools/component-catalog.mjs"
  ]);

  assert.equal(await run(["init", target], { prompt, output: () => {} }), 0);

  const config = await readFile(path.join(target, "ai-native.yaml"), "utf8");
  assert.match(config, /name: "Solo Product"/u);
  assert.match(config, /summary: "A small product"/u);
  assert.match(config, /agents: "\.ai-sdlc\/agents"/u);
  assert.doesNotMatch(config, /clients:/u);
  assert.match(config, /outputs: docs/u);
  assert.match(config, /path: ai-native\/product\/product-brief\.md/u);
  assert.match(config, /id: design-baseline, owner: designer, path: DESIGN_BASELINE\.md/u);
  assert.match(config, /id: design-spec, owner: designer, path: design-spec\.md/u);

  for (const roleId of roleIds) {
    await readFile(path.join(target, `.ai-sdlc/agents/${roleId}.md`), "utf8");
  }
  assert.deepEqual(
    (await readdir(path.join(target, ".ai-sdlc/agents"))).sort(),
    roleIds.map((roleId) => `${roleId}.md`).sort()
  );
  await readFile(path.join(target, ".ai-sdlc/workflows/default.md"), "utf8");
  await readFile(path.join(target, ".ai-sdlc/tasks/README.md"), "utf8");
  await readFile(path.join(target, ".ai-sdlc/templates/requirements.md"), "utf8");
  const designerGuidance = await readFile(path.join(target, ".ai-sdlc/guides/designer.md"), "utf8");
  assert.match(designerGuidance, /## GitHub Copilot[\s\S]*## Claude Code[\s\S]*## Codex/u);
  await readFile(
    path.join(target, ".ai-sdlc/roles/designer/references/figma-workflow.md"),
    "utf8"
  );
  const designerConfig = await readFile(path.join(target, ".ai-sdlc/roles/designer/config.yaml"), "utf8");
  assert.match(designerConfig, /role: "\.ai-sdlc\/agents\/designer\.md"/u);
  assert.match(designerConfig, /- "docs\/context\.md"/u);
  assert.match(designerConfig, /output:\n  subdirectory: ai-native\/design\n\ncomponents:/u);
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

function answers(values) {
  const queue = [...values];
  return async () => queue.shift() ?? "";
}

function validSpec() {
  return `\`\`\`json
{
  "spec_version": "1.0",
  "title": "Generic design",
  "mode": "new",
  "status": "draft",
  "framework": "web",
  "source": ["artifact:requirements"],
  "screens": [{ "id": "main", "layout": "project pattern", "states": ["default"] }],
  "components": [{ "name": "Action", "source": "project", "props": { "tone": "primary" } }],
  "acceptance_criteria": [{
    "id": "AC-1",
    "requirement": "A clear action",
    "design_response": "The main action is identifiable"
  }]
}
\`\`\`

# Generic design

AC-1 is addressed by the verified project component.
`;
}

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-native-interactive-"));
  temporaryDirectories.push(directory);
  return directory;
}
