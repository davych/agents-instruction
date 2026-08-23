import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import YAML from "yaml";

import { loadDefinition } from "../src/services/definition-loader.ts";

const roots: string[] = [];
test.after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

test("adds selectable design outputs to an older project without rewriting its YAML", async () => {
  const root = await oldProject();
  const definition = await loadDefinition(root);
  const design = definition.phases.find((phase) => phase.id === "design");
  assert.deepEqual(design?.outputs, [
    "design-baseline", "design-spec", "design-prototype", "figma-handoff"
  ]);
  assert.equal(
    definition.artifacts.find((artifact) => artifact.id === "design-prototype")?.relativePath,
    "docs/prototype.html"
  );
});

test("injects the Change Contract graph into a legacy definition without rewriting YAML", async () => {
  const root = await oldProject();
  const yamlPath = path.join(root, "ai-native.yaml");
  const yamlBefore = await readFile(yamlPath, "utf8");

  const definition = await loadDefinition(root);
  const changeContract = definition.artifacts.find((artifact) => artifact.id === "change-contract");
  assert.deepEqual(
    [changeContract?.owner, changeContract?.relativePath],
    ["pm-ba", "docs/change-contract.md"],
  );
  assert.deepEqual(
    definition.phases.find((phase) => phase.id === "discovery")?.outputs,
    ["change-contract", "prd", "user-stories"],
  );
  for (const phaseId of ["design", "architecture", "implementation", "verification"] as const) {
    const inputs = definition.phases.find((phase) => phase.id === phaseId)?.inputs ?? [];
    assert.equal(inputs[0], "change-contract", `${phaseId} should read the Change Contract first`);
    assert.equal(inputs.filter((input) => input === "change-contract").length, 1);
  }
  assert.equal(
    definition.phases.find((phase) => phase.id === "release")?.inputs.includes("change-contract"),
    false,
  );
  assert.equal(await readFile(yamlPath, "utf8"), yamlBefore);
});

test("preserves a modern Change Contract registration without duplicating graph entries", async () => {
  const root = await oldProject();
  const config = oldConfig();
  config.artifacts.unshift({ id: "change-contract", owner: "pm-ba", path: "run-contract.md" });
  const discovery = config.workflow.phases.find((phase) => phase.id === "discovery")!;
  discovery.outputs.unshift("change-contract");
  for (const phaseId of ["design", "architecture", "implementation", "verification"]) {
    config.workflow.phases.find((phase) => phase.id === phaseId)!.inputs.unshift("change-contract");
  }
  const yamlPath = path.join(root, "ai-native.yaml");
  await writeFile(yamlPath, YAML.stringify(config), "utf8");
  const yamlBefore = await readFile(yamlPath, "utf8");

  const definition = await loadDefinition(root);
  assert.equal(
    definition.artifacts.filter((artifact) => artifact.id === "change-contract").length,
    1,
  );
  assert.equal(
    definition.artifacts.find((artifact) => artifact.id === "change-contract")?.relativePath,
    "docs/run-contract.md",
  );
  for (const phase of definition.phases) {
    const occurrences = [
      ...(phase.outputs ?? []),
      ...(phase.inputs ?? []),
    ].filter((artifactKey) => artifactKey === "change-contract");
    assert.equal(
      occurrences.length,
      ["discovery", "design", "architecture", "implementation", "verification"]
        .includes(phase.id) ? 1 : 0,
      `${phase.id} should contain the expected number of Change Contract references`,
    );
  }
  assert.equal(await readFile(yamlPath, "utf8"), yamlBefore);
});

test("reloads an older project after its injected prototype output is created without rewriting files", async () => {
  const root = await oldProject();
  const yamlPath = path.join(root, "ai-native.yaml");
  const yamlBefore = await readFile(yamlPath, "utf8");
  const firstDefinition = await loadDefinition(root);
  const prototype = firstDefinition.artifacts.find((artifact) => artifact.id === "design-prototype");
  assert.equal(prototype?.relativePath, "docs/prototype.html");

  await mkdir(path.join(root, "docs"), { recursive: true });
  const existingContent = "<!doctype html><p>existing</p>";
  await writeFile(path.join(root, "docs", "prototype.html"), existingContent, "utf8");

  const reloadedDefinition = await loadDefinition(root);
  assert.equal(
    reloadedDefinition.artifacts.find((artifact) => artifact.id === "design-prototype")?.relativePath,
    "docs/prototype.html"
  );
  assert.equal(await readFile(yamlPath, "utf8"), yamlBefore);
  assert.equal(await readFile(path.join(root, "docs", "prototype.html"), "utf8"), existingContent);
});

test("adds the canonical architecture pack to an older project without rewriting its YAML", async () => {
  const root = await oldProject();
  await mkdir(path.join(root, ".ai-sdlc", "roles", "architect"), { recursive: true });
  await writeFile(
    path.join(root, ".ai-sdlc", "roles", "architect", "config.yaml"),
    YAML.stringify({ output: { subdirectory: "ai-native/architecture" } }),
    "utf8",
  );
  const yamlPath = path.join(root, "ai-native.yaml");
  const yamlBefore = await readFile(yamlPath, "utf8");

  const definition = await loadDefinition(root);
  const architecture = definition.phases.find((phase) => phase.id === "architecture");
  const expected = [
    ["architecture", "docs/ai-native/architecture/architecture.md"],
    ["architecture-discovery-context", "docs/ai-native/architecture/00-discovery-context.md"],
    ["architecture-options", "docs/ai-native/architecture/00-options.md"],
    ["architecture-c4-context", "docs/ai-native/architecture/01-context.mmd"],
    ["architecture-c4-containers", "docs/ai-native/architecture/02-containers.mmd"],
    ["architecture-adrs", "docs/ai-native/architecture/04-adrs"],
    ["architecture-patterns", "docs/ai-native/architecture/05-patterns.md"],
    ["architecture-nfrs", "docs/ai-native/architecture/06-nfrs.md"],
    ["architecture-adversarial", "docs/ai-native/architecture/07-adversarial.md"],
  ];

  assert.deepEqual(architecture?.outputs, expected.map(([id]) => id));
  assert.deepEqual(
    expected.map(([id]) => {
      const artifact = definition.artifacts.find((candidate) => candidate.id === id);
      return [artifact?.id, artifact?.owner, artifact?.relativePath];
    }),
    expected.map(([id, relativePath]) => [id, "architect", relativePath]),
  );
  assert.equal(await readFile(yamlPath, "utf8"), yamlBefore);
});

test("AC-ENG-003/005: extends a legacy implementation phase with the configured engineering evidence pack", async () => {
  const root = await oldProject();
  const engineerRole = path.join(root, ".ai-sdlc", "roles", "software-engineer");
  await mkdir(engineerRole, { recursive: true });
  await writeFile(
    path.join(engineerRole, "config.yaml"),
    YAML.stringify({
      validation: "required",
      output: { subdirectory: "custom/engineering-evidence/" },
    }),
    "utf8",
  );
  const yamlPath = path.join(root, "ai-native.yaml");
  const yamlBefore = await readFile(yamlPath, "utf8");

  const definition = await loadDefinition(root);
  const implementation = definition.phases.find((phase) => phase.id === "implementation");
  const verification = definition.phases.find((phase) => phase.id === "verification");
  assert.equal(verification?.inputs.includes("design-spec"), true,
    "Tester must receive deferred design verification obligations");
  const expected = [
    ["implementation-notes", "docs/custom/engineering-evidence/implementation-notes.md"],
    ["implementation-plan", "docs/custom/engineering-evidence/implementation-plan.md"],
    ["implementation-tasks", "docs/custom/engineering-evidence/implementation-tasks.md"],
    ["engineering-session-log", "docs/custom/engineering-evidence/session-log.md"],
    ["engineering-test-evidence", "docs/custom/engineering-evidence/independent-test-evidence.md"],
    ["engineering-review", "docs/custom/engineering-evidence/review.md"],
    ["engineering-provenance", "docs/custom/engineering-evidence/pr-provenance.md"],
  ] as const;

  assert.deepEqual(implementation?.outputs, expected.map(([id]) => id));
  assert.deepEqual(
    expected.map(([id]) => {
      const artifact = definition.artifacts.find((candidate) => candidate.id === id);
      return [artifact?.id, artifact?.owner, artifact?.relativePath];
    }),
    expected.map(([id, relativePath]) => [id, "software-engineer", relativePath]),
  );
  assert.deepEqual(
    verification?.inputs.slice(-3),
    ["implementation-notes", "engineering-test-evidence", "engineering-review"],
  );
  assert.equal(
    definition.artifacts.filter((artifact) => expected.some(([id]) => id === artifact.id)).length,
    expected.length,
  );
  for (const [, relativePath] of expected) {
    assert.equal(relativePath.includes("//"), false);
    assert.equal(relativePath.includes(".."), false);
  }
  assert.equal(await readFile(yamlPath, "utf8"), yamlBefore);
});

test("AC-ENG-005: a legacy engineer config without output keeps the full canonical evidence directory", async () => {
  const root = await oldProject();
  const config = oldConfig();
  config.artifacts.find((artifact) => artifact.id === "implementation-notes")!.path =
    "ai-native/engineering/implementation-notes.md";
  const yamlPath = path.join(root, "ai-native.yaml");
  await writeFile(yamlPath, YAML.stringify(config), "utf8");
  const engineerRole = path.join(root, ".ai-sdlc", "roles", "software-engineer");
  await mkdir(engineerRole, { recursive: true });
  await writeFile(
    path.join(engineerRole, "config.yaml"),
    YAML.stringify({
      version: 1,
      resources: { role: ".codex/agents/software-engineer.toml" },
      evidence: { registered_artifacts: ["implementation-notes"] },
    }),
    "utf8",
  );
  const yamlBefore = await readFile(yamlPath, "utf8");
  const definition = await loadDefinition(root);
  const expected = [
    ["implementation-notes", "docs/ai-native/engineering/implementation-notes.md"],
    ["implementation-plan", "docs/ai-native/engineering/implementation-plan.md"],
    ["implementation-tasks", "docs/ai-native/engineering/implementation-tasks.md"],
    ["engineering-session-log", "docs/ai-native/engineering/session-log.md"],
    ["engineering-test-evidence", "docs/ai-native/engineering/independent-test-evidence.md"],
    ["engineering-review", "docs/ai-native/engineering/review.md"],
    ["engineering-provenance", "docs/ai-native/engineering/pr-provenance.md"],
  ] as const;

  assert.deepEqual(
    definition.phases.find((phase) => phase.id === "implementation")?.outputs,
    expected.map(([id]) => id),
  );
  assert.deepEqual(
    expected.map(([id]) => {
      const artifact = definition.artifacts.find((candidate) => candidate.id === id);
      return [artifact?.id, artifact?.owner, artifact?.relativePath];
    }),
    expected.map(([id, relativePath]) => [id, "software-engineer", relativePath]),
  );
  for (const [id, relativePath] of expected) {
    assert.notEqual(relativePath, `docs/${path.basename(relativePath)}`, id);
  }
  assert.equal(await readFile(yamlPath, "utf8"), yamlBefore);
});

test("rejects two registered artifacts that resolve to the same path", async () => {
  const root = await oldProject();
  const config = oldConfig();
  config.artifacts.push({ id: "duplicate-prd", owner: "pm-ba", path: "prd.md" });
  await writeFile(path.join(root, "ai-native.yaml"), YAML.stringify(config), "utf8");
  await assert.rejects(() => loadDefinition(root), /指向同一路径/u);
});

test("rejects nested artifact paths that cannot be edited or rerun independently", async () => {
  const root = await oldProject();
  const config = oldConfig();
  config.artifacts.push({ id: "nested-story", owner: "pm-ba", path: "user-stories/US-001.md" });
  await writeFile(path.join(root, "ai-native.yaml"), YAML.stringify(config), "utf8");
  await assert.rejects(() => loadDefinition(root), /路径不能互相嵌套/u);
});

async function oldProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-definition-"));
  roots.push(root);
  await writeFile(path.join(root, "ai-native.yaml"), YAML.stringify(oldConfig()), "utf8");
  return root;
}

function oldConfig() {
  const roles = [
    "pm-ba", "designer", "architect", "software-engineer", "tester", "devops"
  ];
  return {
    version: 1,
    project: { name: "Old project", summary: "Before optional design outputs" },
    agent: { client: "codex" },
    paths: { agents: ".codex/agents", outputs: "docs" },
    roles: roles.map((id) => ({ id, name: id, mission: id, responsibilities: [] })),
    workflow: {
      phases: [
        { id: "discovery", owner: "pm-ba", inputs: [], outputs: ["prd", "user-stories"], gate: "review" },
        { id: "design", owner: "designer", inputs: ["prd", "user-stories"], outputs: ["design-baseline", "design-spec"], gate: "review" },
        { id: "architecture", owner: "architect", inputs: ["design-spec"], outputs: ["architecture"], gate: "review" },
        { id: "implementation", owner: "software-engineer", inputs: ["design-baseline", "architecture"], outputs: ["implementation-notes"], gate: "review" },
        { id: "verification", owner: "tester", inputs: ["implementation-notes"], outputs: ["test-report"], gate: "review" },
        { id: "release", owner: "devops", inputs: ["test-report"], outputs: ["release-runbook"], gate: "review" }
      ]
    },
    artifacts: [
      { id: "prd", owner: "pm-ba", path: "prd.md" },
      { id: "user-stories", owner: "pm-ba", path: "user-stories" },
      { id: "design-baseline", owner: "designer", path: "DESIGN_BASELINE.md" },
      { id: "design-spec", owner: "designer", path: "design-spec.md" },
      { id: "architecture", owner: "architect", path: "architecture.md" },
      { id: "implementation-notes", owner: "software-engineer", path: "implementation-notes.md" },
      { id: "test-report", owner: "tester", path: "test-report.md" },
      { id: "release-runbook", owner: "devops", path: "release-runbook.md" }
    ]
  };
}
