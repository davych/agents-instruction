import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import YAML from "yaml";

import { run } from "../../../../bin/cli.js";
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
  const releaseInputs = definition.phases.find((phase) => phase.id === "release")?.inputs ?? [];
  for (const artifactKey of ["change-contract", "implementation-notes", "engineering-provenance"]) {
    assert.equal(releaseInputs.includes(artifactKey), true, `release must inherit ${artifactKey}`);
    assert.equal(releaseInputs.filter((key) => key === artifactKey).length, 1);
  }
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
      ["discovery", "design", "architecture", "implementation", "verification", "release"]
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

test("AC1/Tier A: rejects artifacts that escape their owner output directory or use unsafe raw segments", async () => {
  const unsafePaths = [
    "../outside.md",
    "./current.md",
    "nested//empty.md",
    "control\u0000name.md",
    "ai-native/other-owner/escape.md",
  ];
  for (const unsafePath of unsafePaths) {
    const root = await oldProject();
    const config = oldConfig();
    config.artifacts.push({ id: `unsafe-${unsafePaths.indexOf(unsafePath)}`, owner: "pm-ba", path: unsafePath });
    await writeFile(path.join(root, "ai-native.yaml"), YAML.stringify(config), "utf8");
    await assertConfigInvalid(root, unsafePath);
  }
});

test("AC1/Tier A: detects NFC and lowercase artifact-path collisions before filesystem access", async () => {
  const root = await oldProject();
  const config = oldConfig();
  config.artifacts.push(
    { id: "unicode-composed", owner: "pm-ba", path: "R\u00e9sum\u00e9.md" },
    { id: "unicode-decomposed", owner: "pm-ba", path: "re\u0301sume\u0301.md" },
  );
  await writeFile(path.join(root, "ai-native.yaml"), YAML.stringify(config), "utf8");
  await assertConfigInvalid(root, "NFC/lowercase collision");
});

test("AC1/Tier A: artifact registrations cannot overlap project control paths", async () => {
  for (const controlPath of [
    "ai-native.yaml",
    ".ai-sdlc/owned.md",
    ".codex/agents/pm-ba.toml",
    ".git/evidence.md",
  ]) {
    const root = await oldProject();
    const config = oldConfig();
    config.paths.outputs = ".";
    config.artifacts.find((artifact) => artifact.id === "prd")!.path = controlPath;
    await writeFile(path.join(root, "ai-native.yaml"), YAML.stringify(config), "utf8");
    await assertConfigInvalid(root, controlPath);
  }
});

test("AC1/Tier A: malformed, symlinked, and non-regular role config files fail closed as CONFIG_INVALID", async () => {
  const cases: Array<{ name: string; configure: (root: string) => Promise<void> }> = [
    {
      name: "malformed YAML",
      configure: async (root) => {
        const roleRoot = path.join(root, ".ai-sdlc", "roles", "pm-ba");
        await mkdir(roleRoot, { recursive: true });
        await writeFile(path.join(roleRoot, "config.yaml"), "output: [broken", "utf8");
      },
    },
    {
      name: "symlink",
      configure: async (root) => {
        const roleRoot = path.join(root, ".ai-sdlc", "roles", "pm-ba");
        const outside = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-definition-outside-"));
        roots.push(outside);
        await mkdir(roleRoot, { recursive: true });
        await writeFile(path.join(outside, "config.yaml"), "version: 1\n", "utf8");
        await symlink(path.join(outside, "config.yaml"), path.join(roleRoot, "config.yaml"));
      },
    },
    {
      name: "directory",
      configure: async (root) => {
        await mkdir(path.join(root, ".ai-sdlc", "roles", "pm-ba", "config.yaml"), { recursive: true });
      },
    },
  ];
  for (const scenario of cases) {
    const root = await oldProject();
    await scenario.configure(root);
    await assertConfigInvalid(root, scenario.name);
  }
});

test("AC1/Tier A: normal legacy definitions remain readable without native-agent files", async () => {
  const root = await oldProject();
  const definition = await loadDefinition(root);
  assert.equal(definition.agentClient, "codex");
  assert.equal(definition.artifacts.some((artifact) => artifact.id === "prd"), true);
  assert.equal(definition.releaseEvidenceValidationRequired, false);
});

test("AC1/Tier A: fresh Codex, Claude, and Copilot projects expose exactly their six native role files", async () => {
  const clients = [
    { promptChoice: "1", client: "github-copilot", directory: ".github/agents", extension: ".agent.md" },
    { promptChoice: "2", client: "claude-code", directory: ".claude/agents", extension: ".md" },
    { promptChoice: "3", client: "codex", directory: ".codex/agents", extension: ".toml" },
  ] as const;
  const roleIds = ["pm-ba", "designer", "architect", "software-engineer", "tester", "devops"];
  for (const client of clients) {
    const root = await freshProject();
    await run(["init", root], {
      prompt: answers(["Agent contract", "Fresh native client", client.promptChoice, "", ""]),
      output: () => undefined,
    });
    const definition = await loadDefinition(root);
    assert.equal(definition.agentClient, client.client);
    assert.equal(definition.releaseEvidenceValidationRequired, true);
    await Promise.all(
      roleIds.map((roleId) =>
        readFile(path.join(root, client.directory, `${roleId}${client.extension}`), "utf8"),
      ),
    );
  }
});

test("AC1/Tier A: a declared Release evidence capability fails closed when its pack is incomplete", async () => {
  const root = await freshProject();
  await run(["init", root, "--client", "codex"], {
    prompt: answers(["Release capability", "Complete DevOps pack", "", ""]),
    output: () => undefined,
  });
  assert.equal((await loadDefinition(root)).releaseEvidenceValidationRequired, true);

  const workflowPath = path.join(root, ".ai-sdlc", "roles", "devops", "workflow.md");
  const outside = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-release-capability-"));
  roots.push(outside);
  const outsideWorkflow = path.join(outside, "workflow.md");
  await writeFile(outsideWorkflow, "external workflow", "utf8");
  await rm(workflowPath);
  await symlink(outsideWorkflow, workflowPath);
  await assert.rejects(
    () => loadDefinition(root),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "CONFIG_INVALID");
      assert.match((error as Error).message, /Release evidence v1|DevOps/u);
      return true;
    },
  );
});

test("AC1/Tier A: legacy full Release paths are normalized beneath the DevOps owner directory", async () => {
  const root = await freshProject();
  await run(["init", root, "--client", "codex"], {
    prompt: answers(["Release legacy path", "Owner-aware compatibility", "", ""]),
    output: () => undefined,
  });
  const configPath = path.join(root, "ai-native.yaml");
  const parsed = YAML.parse(await readFile(configPath, "utf8")) as {
    capabilities?: unknown;
    artifacts: Array<{ id: string; path: string }>;
  };
  delete parsed.capabilities;
  const releaseRunbook = parsed.artifacts.find(({ id }) => id === "release-runbook");
  assert.ok(releaseRunbook);
  releaseRunbook.path = "ai-native/operations/release-runbook.md";
  const legacyYaml = YAML.stringify(parsed);
  await writeFile(configPath, legacyYaml, "utf8");

  const definition = await loadDefinition(root);
  const resolved = definition.artifacts.find(({ id }) => id === "release-runbook");
  assert.equal(resolved?.relativePath, "docs/ai-native/operations/release-runbook.md");
  assert.equal(definition.releaseEvidenceValidationRequired, true);
  assert.equal(await readFile(configPath, "utf8"), legacyYaml);
});

test("AC1/Tier A: a marker-only or wrong-version DevOps pack cannot impersonate Release v1", async () => {
  const root = await freshProject();
  await run(["init", root, "--client", "codex"], {
    prompt: answers(["Release marker", "Semantic capability", "", ""]),
    output: () => undefined,
  });
  await writeFile(
    path.join(root, ".ai-sdlc", "roles", "devops", "config.yaml"),
    [
      "# ai-sdlc:release-evidence-v1",
      "version: 0",
      "output:",
      "  subdirectory: ai-native/operations",
      "",
    ].join("\n"),
    "utf8",
  );
  await assert.rejects(
    () => loadDefinition(root),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "CONFIG_INVALID");
      return true;
    },
  );
});

test("AC1/Tier A: marker-bearing empty DevOps sections cannot impersonate Release v1", async () => {
  const root = await freshProject();
  await run(["init", root, "--client", "codex"], {
    prompt: answers(["Release empty pack", "Semantic capability", "", ""]),
    output: () => undefined,
  });
  await writeFile(
    path.join(root, ".ai-sdlc", "roles", "devops", "workflow.md"),
    [
      "<!-- ai-sdlc:release-evidence-v1 -->",
      "# DevOps workflow",
      "## Evidence contract",
      "## Completion gate",
      "## Execution boundary",
      "",
    ].join("\n"),
    "utf8",
  );
  await assertConfigInvalid(root, "empty marker-bearing DevOps workflow");
});

test("AC1/Tier A: HTML comments and low-information filler cannot impersonate Release v1", async () => {
  const root = await freshProject();
  await run(["init", root, "--client", "codex"], {
    prompt: answers(["Release comment padding", "Semantic capability", "", ""]),
    output: () => undefined,
  });
  await writeFile(
    path.join(root, ".ai-sdlc", "roles", "devops", "workflow.md"),
    [
      "<!-- ai-sdlc:release-evidence-v1 -->",
      "# DevOps workflow",
      "## Evidence contract",
      "xxxxxxxxxxxxxxxxxxxxxxxx",
      "## Completion gate",
      "xxxxxxxxxxxxxxxxxxxxxxxx",
      "## Execution boundary",
      "xxxxxxxxxxxxxxxxxxxxxxxx",
      `<!-- Human: <role/name reference> SHA-256 Ready for human go/no-go ${"padding ".repeat(220)} -->`,
      "",
    ].join("\n"),
    "utf8",
  );
  await assertConfigInvalid(root, "comment-padded DevOps workflow");
});

test("AC1/Tier A: an output-root symlink is rejected while loading the definition", async () => {
  const root = await freshProject();
  await run(["init", root, "--client", "codex"], {
    prompt: answers(["Output root link", "Physical output boundary", "", ""]),
    output: () => undefined,
  });
  const outside = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-output-root-"));
  roots.push(outside);
  await rm(path.join(root, "docs"), { recursive: true, force: true });
  await symlink(outside, path.join(root, "docs"));
  await assertConfigInvalid(root, "output-root symlink");
});

test("AC1/Tier A: agent client and configured agent directory must agree", async () => {
  const root = await oldProject();
  const config = oldConfig();
  config.paths.agents = ".claude/agents";
  await writeFile(path.join(root, "ai-native.yaml"), YAML.stringify(config), "utf8");
  await assertConfigInvalid(root, "agent client/directory mismatch");
});

test("AC1/Tier A: a non-directory parent returns stable CONFIG_INVALID", async () => {
  const root = await oldProject();
  await writeFile(path.join(root, ".codex"), "not a directory\n", "utf8");
  await assert.rejects(
    () => loadDefinition(root),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "CONFIG_INVALID");
      assert.match((error as Error).message, /父节点不是目录/u);
      return true;
    },
  );
});

test("AC1/Tier A: when an agent directory exists, missing, symlinked, and non-regular role files fail closed", async () => {
  const scenarios: Array<{ name: string; configure: (root: string) => Promise<void> }> = [
    {
      name: "missing role file",
      configure: async (root) => {
        await mkdir(path.join(root, ".codex", "agents"), { recursive: true });
      },
    },
    {
      name: "symlinked role file",
      configure: async (root) => {
        await writeCodexAgentFiles(root);
        const agentPath = path.join(root, ".codex", "agents", "pm-ba.toml");
        await rm(agentPath);
        const outside = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-agent-outside-"));
        roots.push(outside);
        const outsideAgent = path.join(outside, "pm-ba.toml");
        await writeFile(outsideAgent, "placeholder", "utf8");
        await symlink(outsideAgent, agentPath);
      },
    },
    {
      name: "non-regular role file",
      configure: async (root) => {
        await writeCodexAgentFiles(root);
        const agentPath = path.join(root, ".codex", "agents", "pm-ba.toml");
        await rm(agentPath);
        await mkdir(agentPath);
      },
    },
  ];
  for (const scenario of scenarios) {
    const root = await oldProject();
    await scenario.configure(root);
    await assertConfigInvalid(root, scenario.name);
  }
});

async function assertConfigInvalid(root: string, label: string): Promise<void> {
  await assert.rejects(
    () => loadDefinition(root),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "CONFIG_INVALID", label);
      return true;
    },
  );
}

async function oldProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-definition-"));
  roots.push(root);
  await writeFile(path.join(root, "ai-native.yaml"), YAML.stringify(oldConfig()), "utf8");
  return root;
}

async function freshProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-agent-contract-"));
  roots.push(root);
  return root;
}

async function writeCodexAgentFiles(root: string): Promise<void> {
  const agentsRoot = path.join(root, ".codex", "agents");
  await mkdir(agentsRoot, { recursive: true });
  await Promise.all(
    ["pm-ba", "designer", "architect", "software-engineer", "tester", "devops"].map((roleId) =>
      writeFile(path.join(agentsRoot, `${roleId}.toml`), "placeholder", "utf8"),
    ),
  );
}

function answers(values: string[]): (question: string) => Promise<string> {
  const queue = [...values];
  return async () => queue.shift() ?? "";
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
