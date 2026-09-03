import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { run } from "../bin/cli.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories = [];
const toolCases = [
  {
    key: "copilot",
    label: "GitHub Copilot",
    instructions: ".github/copilot-instructions.md",
    agentsDirectory: ".github/agents",
    roles: ["pm-ba", "tester"],
    roleFileName: (roleId) => `${roleId}.agent.md`,
  },
  {
    key: "claude",
    label: "Claude Code",
    instructions: "CLAUDE.md",
    agentsDirectory: ".claude/agents",
    roles: ["designer", "architect"],
    roleFileName: (roleId) => `${roleId}.md`,
  },
  {
    key: "codex",
    label: "Codex",
    instructions: "AGENTS.md",
    agentsDirectory: ".codex/agents",
    roles: ["software-engineer", "devops"],
    roleFileName: (roleId) => `${roleId}.toml`,
  },
];

test.after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("update auto-detects each AI tool and restores only the recorded roles", async () => {
  for (const item of toolCases) {
    const target = await initializedProject(item.key, item.roles.join(","));
    const firstRole = path.join(
      target,
      item.agentsDirectory,
      item.roleFileName(item.roles[0]),
    );
    const secondRole = path.join(
      target,
      item.agentsDirectory,
      item.roleFileName(item.roles[1]),
    );
    const instructions = path.join(target, item.instructions);
    const originalInstructions = await readFile(instructions, "utf8");
    const output = [];

    await writeFile(firstRole, "Outdated managed role.\n", "utf8");
    await rm(secondRole);

    assert.equal(await run(["update", target], {
      output: (value) => output.push(value),
      prompt: async () => {
        throw new Error("update must not prompt for initialization values");
      },
    }), 0);

    assert.equal(
      await readFile(firstRole, "utf8"),
      await expectedRole(item.key, item.roles[0]),
    );
    assert.equal(
      await readFile(secondRole, "utf8"),
      await expectedRole(item.key, item.roles[1]),
    );
    assert.deepEqual(
      (await readdir(path.join(target, item.agentsDirectory))).sort(),
      item.roles.map(item.roleFileName).sort(),
    );
    assert.equal(await readFile(instructions, "utf8"), originalInstructions);
    assert.match(output.join(""), /Updated/u);
    assert.match(output.join(""), new RegExp(escapeRegex(item.label), "u"));
  }
});

test("update keeps a no-role installation without creating an agents directory", async () => {
  const target = await initializedProject("codex", "none");
  const workflow = path.join(target, ".ai-sdlc/workflow.md");

  await writeFile(workflow, "Outdated workflow.\n", "utf8");

  assert.equal(await run(["update", target], { output: () => {} }), 0);
  assert.equal(
    await readFile(workflow, "utf8"),
    await expectedSharedFile(".ai-sdlc/workflow.md"),
  );
  assert.equal(existsSync(path.join(target, ".codex/agents")), false);
});

test("AC-09 update preserves a rapid installation choice and project-owned state", async () => {
  const target = await initializedProject("claude", "architect", "rapid");
  const installationPath = path.join(target, ".ai-sdlc/installation.json");
  const profilePath = path.join(target, ".ai-sdlc/project-profile.md");
  const registryPath = path.join(target, ".ai-sdlc/artifact-hosts.json");
  const deliveryArtifactPath = path.join(target, "docs/ai-sdlc/architecture.md");
  const rolePath = path.join(target, ".claude/agents/architect.md");
  const workflowPath = path.join(target, ".ai-sdlc/workflow.md");
  const installation = await readFile(installationPath, "utf8");
  const profile = await readFile(profilePath, "utf8");
  const registry = await readFile(registryPath, "utf8");
  const deliveryArtifact = "# Current architecture\n\nProject-owned decision.\n";
  const output = [];

  await writeFile(deliveryArtifactPath, deliveryArtifact, "utf8");
  await writeFile(rolePath, "Outdated managed role.\n", "utf8");
  await writeFile(workflowPath, "Outdated workflow.\n", "utf8");

  assert.equal(await run(["update", target], { output: (value) => output.push(value) }), 0);
  assert.equal(await readFile(installationPath, "utf8"), installation);
  assert.equal(
    JSON.parse(await readFile(installationPath, "utf8")).deliveryMode,
    "rapid",
  );
  assert.equal(await readFile(profilePath, "utf8"), profile);
  assert.equal(await readFile(registryPath, "utf8"), registry);
  assert.equal(await readFile(deliveryArtifactPath, "utf8"), deliveryArtifact);
  assert.equal(await readFile(rolePath, "utf8"), await expectedRole("claude", "architect"));
  assert.match(output.join(""), /Delivery mode: rapid/iu);
});

test("AC-09 schemaVersion 1 metadata without deliveryMode remains compatible as formal", async () => {
  const target = await initializedProject("claude", "tester");
  const installationPath = path.join(target, ".ai-sdlc/installation.json");
  const workflowPath = path.join(target, ".ai-sdlc/workflow.md");
  const installation = JSON.parse(await readFile(installationPath, "utf8"));
  const output = [];
  delete installation.deliveryMode;

  await writeFile(installationPath, `${JSON.stringify(installation, null, 2)}\n`, "utf8");
  await writeFile(workflowPath, "Outdated workflow.\n", "utf8");

  assert.equal(await run(["update", target], { output: (value) => output.push(value) }), 0);
  assert.equal(
    await readFile(workflowPath, "utf8"),
    await expectedSharedFile(".ai-sdlc/workflow.md"),
  );
  assert.match(output.join(""), /Delivery mode: formal/iu);
});

test("AC-09 legacy update imports only a canonical profile mode and otherwise defaults to formal", async () => {
  const cases = [
    {
      initializedMode: "rapid",
      change: (profile) => profile,
      expectedMode: "rapid",
      source: /canonical legacy project profile/iu,
    },
    {
      initializedMode: "formal",
      change: (profile) => profile.replace(/^\| Delivery mode \| formal \|\r?\n/mu, ""),
      expectedMode: "formal",
      source: /legacy default/iu,
    },
    {
      initializedMode: "rapid",
      change: (profile) => profile.replace(
        "| Delivery mode | rapid |",
        "| **Delivery mode** | rapid |",
      ),
      expectedMode: "formal",
      source: /legacy default/iu,
    },
    ...[
      "```md\n| Setting | Choice |\n|---|---|\n| Delivery mode | rapid |\n```\n",
      "<!-- example\n| Setting | Choice |\n|---|---|\n| Delivery mode | rapid |\n-->\n",
      "Example only:\n| Setting | Choice |\n|---|---|\n| Delivery mode | rapid |\n",
    ].map((example) => ({
      initializedMode: "formal",
      change: (profile) => profile.replace(
        "## Configuration\n",
        `## Configuration\n\n${example}`,
      ),
      expectedMode: "formal",
      source: /legacy default/iu,
    })),
    ...[
      "```md\n## Configuration\n\n| Setting | Choice |\n|---|---|\n| Delivery mode | rapid |\n```\n",
      "<!-- example\n## Configuration\n\n| Setting | Choice |\n|---|---|\n| Delivery mode | rapid |\n-->\n",
    ].map((example) => ({
      initializedMode: "formal",
      change: (profile) => profile.replace(
        "# Project Profile\n",
        `# Project Profile\n\n${example}`,
      ),
      expectedMode: "formal",
      source: /legacy default/iu,
    })),
  ];

  for (const item of cases) {
    const target = await initializedProject("claude", "architect", item.initializedMode);
    const installationPath = path.join(target, ".ai-sdlc/installation.json");
    const profilePath = path.join(target, ".ai-sdlc/project-profile.md");
    const registryPath = path.join(target, ".ai-sdlc/artifact-hosts.json");
    const profile = item.change(await readFile(profilePath, "utf8"));
    const registry = await readFile(registryPath, "utf8");
    const output = [];

    await writeFile(profilePath, profile, "utf8");
    await rm(installationPath);
    assert.equal(
      await run(["update", target], { output: (value) => output.push(value) }),
      0,
    );

    const createdInstallation = JSON.parse(await readFile(installationPath, "utf8"));
    assert.equal(createdInstallation.deliveryMode, item.expectedMode);
    assert.equal(await readFile(profilePath, "utf8"), profile);
    assert.equal(await readFile(registryPath, "utf8"), registry);
    assert.match(output.join(""), new RegExp(`Delivery mode: ${item.expectedMode}`, "iu"));
    assert.match(output.join(""), item.source);
  }
});

test("AC-09 legacy update rejects an invalid or duplicate canonical delivery mode", async () => {
  const changes = [
    (profile) => profile.replace(
      "| Delivery mode | formal |",
      "| Delivery mode | warp-speed |",
    ),
    (profile) => profile.replace(
      "| Delivery mode | formal |",
      "| Delivery mode | formal |\n| Delivery mode | rapid |",
    ),
  ];

  for (const change of changes) {
    const target = await initializedProject("claude", "architect", "formal");
    const installationPath = path.join(target, ".ai-sdlc/installation.json");
    const profilePath = path.join(target, ".ai-sdlc/project-profile.md");
    const workflowPath = path.join(target, ".ai-sdlc/workflow.md");

    await rm(installationPath);
    await writeFile(profilePath, change(await readFile(profilePath, "utf8")), "utf8");
    await writeFile(workflowPath, "Outdated workflow.\n", "utf8");

    await assert.rejects(
      run(["update", target], { output: () => {} }),
      /legacy project profile.*delivery[- ]mode/iu,
    );
    assert.equal(await readFile(workflowPath, "utf8"), "Outdated workflow.\n");
    assert.equal(existsSync(installationPath), false);
  }
});

test("AC-09 installation metadata is authoritative over the profile snapshot", async () => {
  const target = await initializedProject("claude", "architect", "rapid");
  const installationPath = path.join(target, ".ai-sdlc/installation.json");
  const profilePath = path.join(target, ".ai-sdlc/project-profile.md");
  const workflowPath = path.join(target, ".ai-sdlc/workflow.md");
  const output = [];
  const changedProfile = (await readFile(profilePath, "utf8"))
    .replace("| Delivery mode | rapid |", "| Delivery mode | formal |")
    .concat("\nUnrelated note: Delivery mode is not a configuration row.\n");

  await writeFile(profilePath, changedProfile, "utf8");
  await writeFile(workflowPath, "Outdated workflow.\n", "utf8");

  assert.equal(
    await run(["update", target], { output: (value) => output.push(value) }),
    0,
  );
  assert.equal(
    JSON.parse(await readFile(installationPath, "utf8")).deliveryMode,
    "rapid",
  );
  assert.equal(await readFile(profilePath, "utf8"), changedProfile);
  assert.equal(
    await readFile(workflowPath, "utf8"),
    await expectedSharedFile(".ai-sdlc/workflow.md"),
  );
  assert.match(output.join(""), /Delivery mode: rapid/iu);
  assert.match(output.join(""), /Delivery mode source: \.ai-sdlc\/installation\.json/iu);
});

test("AC-09 update rechecks authoritative metadata after planning hooks", async () => {
  const target = await initializedProject("claude", "architect", "formal");
  const installationPath = path.join(target, ".ai-sdlc/installation.json");
  const workflowPath = path.join(target, ".ai-sdlc/workflow.md");
  await writeFile(workflowPath, "Outdated workflow.\n", "utf8");

  await assert.rejects(
    run(["update", target], {
      output: () => {},
      beforePlan: async () => {
        const installation = JSON.parse(await readFile(installationPath, "utf8"));
        installation.deliveryMode = "rapid";
        await writeFile(
          installationPath,
          `${JSON.stringify(installation, null, 2)}\n`,
          "utf8",
        );
      },
    }),
    /configuration source changed|installation configuration changed/iu,
  );
  assert.equal(await readFile(workflowPath, "utf8"), "Outdated workflow.\n");
});

test("AC-09 update rechecks authoritative metadata immediately before each write", async () => {
  const target = await initializedProject("claude", "architect", "formal");
  const installationPath = path.join(target, ".ai-sdlc/installation.json");
  const workflowPath = path.join(target, ".ai-sdlc/workflow.md");
  await writeFile(workflowPath, "Outdated workflow.\n", "utf8");

  await assert.rejects(
    run(["update", target], {
      output: () => {},
      beforeWrite: async ({ index }) => {
        if (index !== 0) return;
        const installation = JSON.parse(await readFile(installationPath, "utf8"));
        installation.deliveryMode = "rapid";
        await writeFile(
          installationPath,
          `${JSON.stringify(installation, null, 2)}\n`,
          "utf8",
        );
      },
    }),
    /configuration source changed|installation configuration changed/iu,
  );
  assert.equal(await readFile(workflowPath, "utf8"), "Outdated workflow.\n");
});

test("AC-09 modern profile changes during update do not switch the active mode", async () => {
  const target = await initializedProject("claude", "architect", "formal");
  const profilePath = path.join(target, ".ai-sdlc/project-profile.md");
  const workflowPath = path.join(target, ".ai-sdlc/workflow.md");
  const output = [];
  await writeFile(workflowPath, "Outdated workflow.\n", "utf8");

  assert.equal(
    await run(["update", target], {
      output: (value) => output.push(value),
      beforeWrite: async ({ index }) => {
        if (index !== 0) return;
        const profile = await readFile(profilePath, "utf8");
        await writeFile(
          profilePath,
          profile.replace("| Delivery mode | formal |", "| Delivery mode | rapid |"),
          "utf8",
        );
      },
    }),
    0,
  );
  assert.match(await readFile(profilePath, "utf8"), /\| Delivery mode \| rapid \|/u);
  assert.match(output.join(""), /Delivery mode: formal/iu);
  assert.match(output.join(""), /Delivery mode source: \.ai-sdlc\/installation\.json/iu);
});

test("AC-09 legacy profile source is protected until installation metadata is created", async () => {
  const target = await initializedProject("claude", "architect", "rapid");
  const installationPath = path.join(target, ".ai-sdlc/installation.json");
  const profilePath = path.join(target, ".ai-sdlc/project-profile.md");
  const workflowPath = path.join(target, ".ai-sdlc/workflow.md");

  await rm(installationPath);
  await writeFile(workflowPath, "Outdated workflow.\n", "utf8");

  await assert.rejects(
    run(["update", target], {
      output: () => {},
      beforePlan: async () => {
        const profile = await readFile(profilePath, "utf8");
        await writeFile(
          profilePath,
          profile.replace("| Delivery mode | rapid |", "| Delivery mode | formal |"),
          "utf8",
        );
      },
    }),
    /configuration source changed/iu,
  );
  assert.equal(await readFile(workflowPath, "utf8"), "Outdated workflow.\n");
  assert.equal(existsSync(installationPath), false);
});

test("AC-09 legacy profile remains protected across installation metadata creation", async () => {
  const contextFactories = [
    (mutateProfile) => ({
      beforeCreateOpen: async ({ path: entryPath }) => {
        if (entryPath === ".ai-sdlc/installation.json") await mutateProfile();
      },
    }),
    (mutateProfile) => ({
      writeCreatedFile: async ({ handle, content, path: entryPath }) => {
        await handle.writeFile(content, "utf8");
        if (entryPath === ".ai-sdlc/installation.json") await mutateProfile();
      },
    }),
  ];

  for (const contextFactory of contextFactories) {
    const target = await initializedProject("claude", "architect", "rapid");
    const installationPath = path.join(target, ".ai-sdlc/installation.json");
    const profilePath = path.join(target, ".ai-sdlc/project-profile.md");
    const workflowPath = path.join(target, ".ai-sdlc/workflow.md");
    const mutateProfile = async () => {
      const profile = await readFile(profilePath, "utf8");
      await writeFile(
        profilePath,
        profile.replace("| Delivery mode | rapid |", "| Delivery mode | formal |"),
        "utf8",
      );
    };

    await rm(installationPath);
    await writeFile(workflowPath, "Outdated workflow.\n", "utf8");

    await assert.rejects(
      run(["update", target], {
        output: () => {},
        ...contextFactory(mutateProfile),
      }),
      /configuration source changed/iu,
    );
    assert.equal(existsSync(installationPath), false);
    assert.equal(await readFile(workflowPath, "utf8"), "Outdated workflow.\n");
    assert.match(await readFile(profilePath, "utf8"), /\| Delivery mode \| formal \|/u);
  }
});

test("update replaces every managed shared file and creates newly added managed files", async () => {
  const target = await initializedProject("claude", "tester");
  const managedFiles = (await listTemplateFiles(path.join(repositoryRoot, "templates/shared")))
    .filter((relativePath) => relativePath !== "docs/ai-sdlc/index.md");
  const filesToRecreate = [
    ".agents/skills/sdlc-artifact-bridge/SKILL.md",
    ".ai-sdlc/technology-planning.md",
    ".ai-sdlc/templates/test-report.md",
  ];

  for (const relativePath of managedFiles) {
    await writeFile(
      path.join(target, relativePath),
      `Outdated managed content: ${relativePath}\n`,
      "utf8",
    );
  }
  for (const relativePath of filesToRecreate) {
    await rm(path.join(target, relativePath));
  }

  assert.equal(await run(["update", target, "--tool", "claude"], { output: () => {} }), 0);

  for (const relativePath of managedFiles) {
    assert.equal(
      await readFile(path.join(target, relativePath), "utf8"),
      await expectedSharedFile(relativePath),
      relativePath,
    );
  }
});

test("update upgrades a legacy installation that predates profile and routing files", async () => {
  const target = await initializedProject("claude", "all");
  const index = path.join(target, "docs/ai-sdlc/index.md");
  const indexContent = "# Existing delivery index\n\n| Artifact | Description |\n|---|---|\n";

  await rm(path.join(target, ".ai-sdlc/installation.json"));
  await rm(path.join(target, ".ai-sdlc/project-profile.md"));
  await rm(path.join(target, ".ai-sdlc/artifact-hosts.json"));
  await rm(path.join(target, ".agents/skills/sdlc-artifact-bridge/SKILL.md"));
  await rm(path.join(target, ".ai-sdlc/technology-planning.md"));
  await writeFile(index, indexContent, "utf8");

  assert.equal(await run(["update", target], { output: () => {} }), 0);

  assert.deepEqual(
    JSON.parse(await readFile(path.join(target, ".ai-sdlc/installation.json"), "utf8")),
    {
      schemaVersion: 1,
      tool: "claude",
      roles: ["pm-ba", "designer", "architect", "software-engineer", "tester", "devops"],
      deliveryMode: "formal",
    },
  );
  assert.match(
    await readFile(path.join(target, ".ai-sdlc/project-profile.md"), "utf8"),
    /\| Local role agents \| pm-ba, designer, architect, software-engineer, tester, devops \|/u,
  );
  assert.equal(
    JSON.parse(await readFile(path.join(target, ".ai-sdlc/artifact-hosts.json"), "utf8"))
      .routes.architecture.host,
    "local",
  );
  assert.equal(await readFile(index, "utf8"), indexContent);
  assert.equal(
    await readFile(path.join(target, ".ai-sdlc/technology-planning.md"), "utf8"),
    await expectedSharedFile(".ai-sdlc/technology-planning.md"),
  );
});

test("legacy Dedicated agents metadata restores a missing configured role", async () => {
  const target = await initializedProject("claude", "pm-ba,designer,architect");
  const designerAgent = path.join(target, ".claude/agents/designer.md");
  const legacyProfile = [
    "# Project Profile",
    "",
    "This file records choices made during initialization. It guides the role agents, but it does not authorize dependency installation, application scaffolding, framework migration, or replacement of existing project conventions.",
    "",
    "## Configuration",
    "",
    "| Setting | Choice |",
    "|---|---|",
    "| Development work | yes |",
    "| Development area | full-stack |",
    "| Stack preference | existing |",
    "| UI system | existing |",
    "| UI MCP | none |",
    "| Validation preference | project commands |",
    "| Active phases | Discovery, Design, Architecture |",
    "| Dedicated agents | pm-ba, designer, architect |",
    "",
    "## Validation guidance",
    "",
    "Use commands confirmed by project files, wrappers, CI, or project instructions.",
    "",
  ].join("\n");

  await rm(path.join(target, ".ai-sdlc/installation.json"));
  await rm(designerAgent);
  await writeFile(path.join(target, ".ai-sdlc/project-profile.md"), legacyProfile, "utf8");

  assert.equal(await run(["update", target], { output: () => {} }), 0);

  assert.equal(await readFile(designerAgent, "utf8"), await expectedRole("claude", "designer"));
  assert.deepEqual(
    JSON.parse(await readFile(path.join(target, ".ai-sdlc/installation.json"), "utf8")),
    {
      schemaVersion: 1,
      tool: "claude",
      roles: ["pm-ba", "designer", "architect"],
      deliveryMode: "formal",
    },
  );
});

test("legacy configuration that appears during planning is preserved", async () => {
  const target = await initializedProject("claude", "tester");
  const installation = path.join(target, ".ai-sdlc/installation.json");
  const registry = path.join(target, ".ai-sdlc/artifact-hosts.json");
  const workflow = path.join(target, ".ai-sdlc/workflow.md");
  const customRegistry = "{\"createdBy\":\"another process\"}\n";

  await rm(installation);
  await rm(registry);
  await writeFile(workflow, "Outdated workflow.\n", "utf8");

  await assert.rejects(
    run(["update", target], {
      output: () => {},
      beforePlan: async () => writeFile(registry, customRegistry, "utf8"),
    }),
    /legacy configuration paths appeared during the update/iu,
  );

  assert.equal(await readFile(registry, "utf8"), customRegistry);
  assert.equal(await readFile(workflow, "utf8"), "Outdated workflow.\n");
  assert.equal(existsSync(installation), false);
});

test("update preserves project state, working artifacts, root instructions, and unknown files", async () => {
  const target = await initializedProject("claude", "pm-ba,architect");
  const preserved = new Map();
  const instructionsPath = "CLAUDE.md";
  const profilePath = ".ai-sdlc/project-profile.md";
  const registryPath = ".ai-sdlc/artifact-hosts.json";
  const indexPath = "docs/ai-sdlc/index.md";

  preserved.set(
    instructionsPath,
    `${await readFile(path.join(target, instructionsPath), "utf8")}\n# Project-specific rule\nKeep this rule.\n`,
  );
  preserved.set(
    profilePath,
    `${await readFile(path.join(target, profilePath), "utf8")}\nProject-specific profile note.\n`,
  );
  preserved.set(registryPath, `${JSON.stringify({
    version: 1,
    defaultHost: "product-docs",
    hosts: {
      local: { kind: "filesystem", root: ".", artifactIndex: indexPath },
      "product-docs": {
        kind: "url",
        baseUrl: "https://example.com/product/",
        artifactIndex: indexPath,
      },
    },
    routes: {
      discovery: {
        phase: "Discovery",
        role: "pm-ba",
        host: "product-docs",
        paths: ["/docs/ai-sdlc/prd.md"],
      },
    },
  }, null, 2)}\n`);
  preserved.set(
    indexPath,
    "# Delivery artifact index\n\n| Artifact | Description |\n|---|---|\n| [PRD](./prd.md) | Current requirements |\n",
  );
  preserved.set("docs/ai-sdlc/prd.md", "# Current PRD\n\nDo not replace working documents.\n");
  preserved.set(".ai-sdlc/templates/team-specific.md", "# Team template\n");
  preserved.set(".ai-sdlc/retired-managed-file.md", "Keep old files; update does not delete.\n");
  preserved.set(".claude/agents/team-reviewer.md", "# Team reviewer\n");
  preserved.set(".mcp.json", "{\"keep\":true}\n");

  for (const [relativePath, content] of preserved) {
    const destination = path.join(target, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content, "utf8");
  }
  await writeFile(path.join(target, ".ai-sdlc/workflow.md"), "Outdated workflow.\n", "utf8");

  assert.equal(await run(["update", target], { output: () => {} }), 0);

  for (const [relativePath, content] of preserved) {
    assert.equal(await readFile(path.join(target, relativePath), "utf8"), content, relativePath);
  }
  assert.equal(
    await readFile(path.join(target, ".ai-sdlc/workflow.md"), "utf8"),
    await expectedSharedFile(".ai-sdlc/workflow.md"),
  );
});

test("update rejects an uninitialized target without turning it into an installation", async () => {
  for (const args of [[], ["--tool", "claude"]]) {
    const target = await temporaryDirectory();
    const existing = path.join(target, "README.md");
    await writeFile(existing, "Existing project.\n", "utf8");

    await assert.rejects(
      run(["update", target, ...args], { output: () => {} }),
      /not initialized|no (?:supported )?(?:AI-native )?SDLC installation/iu,
    );

    assert.deepEqual(await readdir(target), ["README.md"]);
    assert.equal(await readFile(existing, "utf8"), "Existing project.\n");
  }
});

test("legacy update requires --tool for more than one generated tool instruction", async () => {
  const target = await initializedProject("claude", "tester");
  const codexSource = await initializedProject("codex", "tester");
  const workflow = path.join(target, ".ai-sdlc/workflow.md");
  const claudeRole = path.join(target, ".claude/agents/tester.md");
  const codexRole = path.join(target, ".codex/agents/tester.toml");

  await rm(path.join(target, ".ai-sdlc/installation.json"));
  await writeFile(path.join(target, "AGENTS.md"), await readFile(path.join(codexSource, "AGENTS.md")));
  await mkdir(path.dirname(codexRole), { recursive: true });
  await writeFile(codexRole, await readFile(path.join(codexSource, ".codex/agents/tester.toml")));
  const originalCodexRole = await readFile(codexRole, "utf8");
  await writeFile(workflow, "Outdated workflow.\n", "utf8");
  await writeFile(claudeRole, "Outdated Claude role.\n", "utf8");

  await assert.rejects(
    run(["update", target], { output: () => {} }),
    /multiple|more than one|--tool/iu,
  );
  assert.equal(await readFile(workflow, "utf8"), "Outdated workflow.\n");
  assert.equal(await readFile(claudeRole, "utf8"), "Outdated Claude role.\n");

  assert.equal(
    await run(["update", target, "--tool", "claude"], { output: () => {} }),
    0,
  );
  assert.equal(await readFile(claudeRole, "utf8"), await expectedRole("claude", "tester"));
  assert.equal(await readFile(codexRole, "utf8"), originalCodexRole);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(target, ".ai-sdlc/installation.json"), "utf8")),
    { schemaVersion: 1, tool: "claude", roles: ["tester"], deliveryMode: "formal" },
  );
});

test("installation metadata prevents unrelated tool files from being overwritten", async () => {
  const target = await initializedProject("codex", "tester");
  const codexRole = path.join(target, ".codex/agents/tester.toml");
  const unrelatedInstructions = path.join(target, "CLAUDE.md");
  const unrelatedRole = path.join(target, ".claude/agents/tester.md");

  await rm(path.join(target, "AGENTS.md"));
  await mkdir(path.dirname(unrelatedRole), { recursive: true });
  await writeFile(unrelatedInstructions, "# Project-specific Claude instructions\n", "utf8");
  await writeFile(unrelatedRole, "# Custom tester\n", "utf8");
  await writeFile(codexRole, "Outdated Codex role.\n", "utf8");

  assert.equal(await run(["update", target], { output: () => {} }), 0);
  assert.equal(await readFile(codexRole, "utf8"), await expectedRole("codex", "tester"));
  assert.equal(await readFile(unrelatedInstructions, "utf8"), "# Project-specific Claude instructions\n");
  assert.equal(await readFile(unrelatedRole, "utf8"), "# Custom tester\n");
  await assert.rejects(
    run(["update", target, "--tool", "claude"], { output: () => {} }),
    /uses codex, not claude/u,
  );
});

test("legacy detection does not treat ordinary tool files as an SDLC installation", async () => {
  const target = await initializedProject("codex", "tester");
  const unrelatedInstructions = path.join(target, "CLAUDE.md");
  const unrelatedRole = path.join(target, ".claude/agents/tester.md");
  const workflow = path.join(target, ".ai-sdlc/workflow.md");

  await rm(path.join(target, ".ai-sdlc/installation.json"));
  await rm(path.join(target, "AGENTS.md"));
  await mkdir(path.dirname(unrelatedRole), { recursive: true });
  await writeFile(unrelatedInstructions, "# Project-specific Claude instructions\n", "utf8");
  await writeFile(unrelatedRole, "# Custom tester\n", "utf8");
  await writeFile(workflow, "Outdated workflow.\n", "utf8");

  await assert.rejects(
    run(["update", target], { output: () => {} }),
    /No generated AI tool instructions were recognized/u,
  );
  assert.equal(await readFile(unrelatedRole, "utf8"), "# Custom tester\n");
  assert.equal(await readFile(workflow, "utf8"), "Outdated workflow.\n");
});

test("invalid installation metadata fails closed before managed files change", async () => {
  const invalidRecords = [
    { schemaVersion: 1, tool: "unknown", roles: [] },
    { schemaVersion: 1, tool: "claude", roles: [null] },
    { schemaVersion: 1, tool: "claude", roles: ["tester"], deliveryMode: "fast" },
    { schemaVersion: 1, tool: "claude", roles: ["tester"], deliveryMode: null },
    { schemaVersion: 1, tool: "claude", roles: ["tester"], deliveryMode: ["formal"] },
  ];

  for (const record of invalidRecords) {
    const target = await initializedProject("claude", "tester");
    const installation = path.join(target, ".ai-sdlc/installation.json");
    const workflow = path.join(target, ".ai-sdlc/workflow.md");

    await writeFile(installation, `${JSON.stringify(record)}\n`, "utf8");
    await writeFile(workflow, "Outdated workflow.\n", "utf8");

    await assert.rejects(
      run(["update", target], { output: () => {} }),
      /installation\.json.*(?:unsupported|invalid)/iu,
    );
    assert.equal(await readFile(workflow, "utf8"), "Outdated workflow.\n");
  }
});

test("duplicate top-level installation keys fail closed before managed files change", async () => {
  const duplicateRecords = [
    '{"schemaVersion":1,"tool":"claude","roles":["tester"],"deliveryMode":"formal","deliveryMode":"rapid"}\n',
    '{"schemaVersion":1,"tool":"claude","roles":["tester"],"deliveryMode":"formal","deliveryMode":"formal"}\n',
    '{"schemaVersion":1,"tool":"claude","roles":["tester"],"deliveryMode":"formal","delivery\\u004dode":"rapid"}\n',
  ];

  for (const source of duplicateRecords) {
    const target = await initializedProject("claude", "tester");
    const installation = path.join(target, ".ai-sdlc/installation.json");
    const workflow = path.join(target, ".ai-sdlc/workflow.md");

    await writeFile(installation, source, "utf8");
    await writeFile(workflow, "Outdated workflow.\n", "utf8");

    await assert.rejects(
      run(["update", target], { output: () => {} }),
      /installation\.json.*duplicate top-level key/iu,
    );
    assert.equal(await readFile(workflow, "utf8"), "Outdated workflow.\n");
  }
});

test("legacy profile role parsing rejects empty role values", async () => {
  for (const malformedRoles of ["tester, ", ""]) {
    const target = await initializedProject("claude", "tester");
    const profile = path.join(target, ".ai-sdlc/project-profile.md");
    const role = path.join(target, ".claude/agents/tester.md");
    const malformed = (await readFile(profile, "utf8")).replace(
      "| Local role agents | tester |",
      `| Local role agents | ${malformedRoles} |`,
    );

    await rm(path.join(target, ".ai-sdlc/installation.json"));
    await writeFile(profile, malformed, "utf8");
    await writeFile(role, "Outdated role.\n", "utf8");

    await assert.rejects(
      run(["update", target], { output: () => {} }),
      /profile contains invalid local roles/u,
    );
    assert.equal(await readFile(role, "utf8"), "Outdated role.\n");
  }
});

test("update rejects symbolic-link destinations before changing any managed file", {
  skip: process.platform === "win32",
}, async () => {
  const target = await initializedProject("copilot", "designer");
  const outside = await temporaryDirectory();
  const outsideFile = path.join(outside, "outside-prd.md");
  const linkedDestination = path.join(target, ".ai-sdlc/templates/prd.md");
  const workflow = path.join(target, ".ai-sdlc/workflow.md");

  await writeFile(outsideFile, "Outside content.\n", "utf8");
  await rm(linkedDestination);
  await symlink(outsideFile, linkedDestination);
  await writeFile(workflow, "Outdated workflow.\n", "utf8");

  await assert.rejects(
    run(["update", target], { output: () => {} }),
    /symbolic link|symlink|unsafe|real file/iu,
  );

  assert.equal(await readFile(outsideFile, "utf8"), "Outside content.\n");
  assert.equal(await readFile(workflow, "utf8"), "Outdated workflow.\n");
});

test("update refuses a destination changed to a symbolic link after preflight", {
  skip: process.platform === "win32",
}, async () => {
  const target = await initializedProject("claude", "tester");
  const outside = await temporaryDirectory();
  const workflow = path.join(target, ".ai-sdlc/workflow.md");
  const movedWorkflow = path.join(outside, "workflow.md");
  const outdated = "Outdated workflow before the race.\n";

  await writeFile(workflow, outdated, "utf8");
  await assert.rejects(
    run(["update", target], {
      output: () => {},
      beforeWrite: async ({ path: entryPath }) => {
        if (entryPath !== ".ai-sdlc/workflow.md") return;
        await rename(workflow, movedWorkflow);
        await symlink(movedWorkflow, workflow);
      },
    }),
    /ELOOP|symbolic link|unsafe|changed/iu,
  );

  assert.equal(await readFile(movedWorkflow, "utf8"), outdated);
});

test("update cleans an empty file created through a parent symlink race", {
  skip: process.platform === "win32",
}, async () => {
  const target = await initializedProject("claude", "tester");
  const outside = await temporaryDirectory();
  const bridgeDirectory = path.join(target, ".agents/skills/sdlc-artifact-bridge");
  const movedBridgeDirectory = path.join(target, ".agents/skills/original-artifact-bridge");
  const bridgePath = ".agents/skills/sdlc-artifact-bridge/SKILL.md";
  const outsideFile = path.join(outside, "SKILL.md");

  await rm(path.join(target, bridgePath));

  await assert.rejects(
    run(["update", target], {
      output: () => {},
      beforeCreateOpen: async ({ path: entryPath }) => {
        if (entryPath !== bridgePath) return;
        await rename(bridgeDirectory, movedBridgeDirectory);
        await symlink(outside, bridgeDirectory, "dir");
      },
    }),
    /outside the target/iu,
  );

  assert.equal(existsSync(outsideFile), false);
  assert.equal(existsSync(path.join(movedBridgeDirectory, "SKILL.md")), false);
});

test("update cleans an empty directory created through an ancestor symlink race", {
  skip: process.platform === "win32",
}, async () => {
  const target = await initializedProject("claude", "tester");
  const outside = await temporaryDirectory();
  const skillsDirectory = path.join(target, ".agents/skills");
  const movedSkillsDirectory = path.join(target, ".agents/original-skills");
  const bridgeDirectory = path.join(target, ".agents/skills/sdlc-artifact-bridge");
  const relativeBridgeDirectory = ".agents/skills/sdlc-artifact-bridge";

  await rm(bridgeDirectory, { recursive: true });

  await assert.rejects(
    run(["update", target], {
      output: () => {},
      beforeDirectoryCreate: async ({ path: directoryPath }) => {
        if (directoryPath !== relativeBridgeDirectory) return;
        await rename(skillsDirectory, movedSkillsDirectory);
        await symlink(outside, skillsDirectory, "dir");
      },
    }),
    /outside the target/iu,
  );

  assert.equal(existsSync(path.join(outside, "sdlc-artifact-bridge")), false);
  assert.equal(existsSync(path.join(movedSkillsDirectory, "sdlc-artifact-bridge")), false);
});

test("update refuses a target directory replaced after preflight", {
  skip: process.platform === "win32",
}, async () => {
  const target = await initializedProject("claude", "tester");
  const movedContainer = await temporaryDirectory();
  const movedTarget = path.join(movedContainer, "original-project");
  const unrelated = await temporaryDirectory();
  const missingPath = ".ai-sdlc/technology-planning.md";

  await rm(path.join(target, missingPath));
  await assert.rejects(
    run(["update", target], {
      output: () => {},
      beforeWrite: async ({ path: entryPath }) => {
        if (entryPath !== missingPath) return;
        await rename(target, movedTarget);
        await symlink(unrelated, target, "dir");
      },
    }),
    /target.*(?:changed|real directory)/iu,
  );

  assert.equal(existsSync(path.join(unrelated, missingPath)), false);
  assert.equal(existsSync(path.join(movedTarget, missingPath)), false);
});

test("update rejects managed files with another hard link", {
  skip: process.platform === "win32",
}, async () => {
  const target = await initializedProject("codex", "tester");
  const outside = await temporaryDirectory();
  const workflow = path.join(target, ".ai-sdlc/workflow.md");
  const outsideFile = path.join(outside, "shared-workflow.md");
  const outsideContent = "Content shared through a hard link.\n";

  await writeFile(outsideFile, outsideContent, "utf8");
  await rm(workflow);
  await link(outsideFile, workflow);

  await assert.rejects(
    run(["update", target], { output: () => {} }),
    /unsafe/iu,
  );
  assert.equal(await readFile(outsideFile, "utf8"), outsideContent);
});

test("update restores replaced files and removes newly created files when a later write fails", async () => {
  const target = await initializedProject("claude", "pm-ba,designer");
  const managedFiles = (await listTemplateFiles(path.join(repositoryRoot, "templates/shared")))
    .filter((relativePath) => relativePath !== "docs/ai-sdlc/index.md");

  for (const relativePath of managedFiles) {
    await writeFile(path.join(target, relativePath), `Before update: ${relativePath}\n`, "utf8");
  }
  await writeFile(path.join(target, ".claude/agents/pm-ba.md"), "Before update: PM.\n", "utf8");
  await writeFile(path.join(target, ".claude/agents/designer.md"), "Before update: Designer.\n", "utf8");
  await rm(path.join(target, ".agents/skills/sdlc-artifact-bridge/SKILL.md"));
  const before = await snapshotFiles(target);
  let writes = 0;

  await assert.rejects(
    run(["update", target], {
      output: () => {},
      beforeWrite: () => {
        writes += 1;
        if (writes === 4) throw new Error("Planned update failure");
      },
    }),
    /Planned update failure/u,
  );

  assert.deepEqual(await snapshotFiles(target), before);
});

test("update removes a newly created file after a partial write fails", async () => {
  const target = await initializedProject("claude", "tester");
  const bridge = path.join(target, ".agents/skills/sdlc-artifact-bridge/SKILL.md");

  await rm(bridge);

  await assert.rejects(
    run(["update", target], {
      output: () => {},
      writeCreatedFile: async ({ handle, content }) => {
        await handle.writeFile(content.slice(0, 16), "utf8");
        throw new Error("Injected partial write failure");
      },
    }),
    /Injected partial write failure/u,
  );

  assert.equal(existsSync(bridge), false);
});

test("update rollback preserves a concurrently replaced newly created file", async () => {
  const target = await initializedProject("claude", "tester");
  const bridge = path.join(target, ".agents/skills/sdlc-artifact-bridge/SKILL.md");
  const workflow = path.join(target, ".ai-sdlc/workflow.md");
  const displaced = path.join(target, ".agents/skills/sdlc-artifact-bridge/displaced.md");
  const concurrentContent = "Created concurrently while update was rolling back.\n";
  let writes = 0;

  await rm(bridge);
  await writeFile(workflow, "Outdated workflow.\n", "utf8");

  await assert.rejects(
    run(["update", target], {
      output: () => {},
      beforeWrite: () => {
        writes += 1;
        if (writes === 2) throw new Error("Trigger rollback after bridge creation");
      },
      beforeCreatedRollbackClaim: async ({ path: createdPath }) => {
        await rename(createdPath, displaced);
        await writeFile(createdPath, concurrentContent, "utf8");
        await rm(displaced);
      },
    }),
    (error) => error instanceof AggregateError
      && /Trigger rollback after bridge creation/u.test(error.message)
      && /replaced during rollback/iu.test(error.message),
  );

  assert.equal(await readFile(bridge, "utf8"), concurrentContent);
  assert.equal(await readFile(workflow, "utf8"), "Outdated workflow.\n");
});

test("update rollback keeps a managed file changed concurrently after it was written", async () => {
  const target = await initializedProject("claude", "tester");
  const managedFiles = (await listTemplateFiles(path.join(repositoryRoot, "templates/shared")))
    .filter((relativePath) => relativePath !== "docs/ai-sdlc/index.md");
  const concurrentContent = "Changed by another process during update.\n";

  for (const relativePath of managedFiles) {
    await writeFile(path.join(target, relativePath), `Before update: ${relativePath}\n`, "utf8");
  }
  await writeFile(path.join(target, ".claude/agents/tester.md"), "Before update: Tester.\n", "utf8");
  const before = await snapshotFiles(target);
  let firstPath;
  let writes = 0;

  await assert.rejects(
    run(["update", target], {
      output: () => {},
      beforeWrite: async ({ path: entryPath }) => {
        writes += 1;
        if (writes === 1) {
          firstPath = entryPath;
          return;
        }
        if (writes === 2) {
          await writeFile(path.join(target, firstPath), concurrentContent, "utf8");
          throw new Error("Planned failure after concurrent change");
        }
      },
    }),
    (error) => error instanceof AggregateError
      && /Planned failure after concurrent change/u.test(error.message)
      && /changed during rollback|could not be restored safely/iu.test(error.message),
  );

  const expected = before.map(([relativePath, content]) => (
    relativePath === firstPath ? [relativePath, concurrentContent] : [relativePath, content]
  ));
  assert.deepEqual(await snapshotFiles(target), expected);
});

test("AC-10 update rejects the initialization-only delivery-mode option", async () => {
  const cliPath = path.join(repositoryRoot, "bin/cli.js");
  const helpResult = spawnSync(process.execPath, [cliPath, "--help"], {
    encoding: "utf8",
  });

  assert.equal(helpResult.status, 0, helpResult.stderr);
  assert.match(helpResult.stdout, /create-ai-native-sdlc update \[target\] \[--tool <tool>\]/u);

  await assert.rejects(run(["update", ".", "--tool", "unknown"]), /Unknown AI tool/u);
  await assert.rejects(run(["update", ".", "--tool"]), /--tool needs a value/u);
  await assert.rejects(
    run(["update", ".", "--roles", "all"]),
    /--roles is only available with init/u,
  );
  await assert.rejects(
    run(["update", ".", "--delivery-mode", "rapid"]),
    /--delivery-mode is only available with init/u,
  );
  await assert.rejects(run(["update", ".", "extra"]), /Unexpected argument/u);

  const target = await initializedProject("claude", "architect");
  await writeFile(path.join(target, ".ai-sdlc/workflow.md"), "Outdated workflow.\n", "utf8");
  assert.equal(await run(["update", "--tool", "claude"], {
    cwd: target,
    output: () => {},
  }), 0);
});

async function initializedProject(tool, roles, deliveryMode) {
  const target = await temporaryDirectory();
  const args = [
    "init",
    target,
    "--name",
    "Existing Project",
    "--summary",
    "Already uses the delivery workflow",
    "--tool",
    tool,
    "--roles",
    roles,
  ];
  if (deliveryMode) args.push("--delivery-mode", deliveryMode);
  await run(args, { output: () => {} });
  return target;
}

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-native-update-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function expectedRole(tool, roleId) {
  const source = await readFile(
    path.join(repositoryRoot, "templates/agents", `${roleId}.md`),
    "utf8",
  );
  const description = source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#"));
  assert.ok(description);

  if (tool === "codex") {
    return ensureNewline([
      `name = ${JSON.stringify(roleId)}`,
      `description = ${JSON.stringify(description)}`,
      `developer_instructions = ${JSON.stringify(source.trim())}`,
    ].join("\n"));
  }

  return ensureNewline([
    "---",
    `name: ${JSON.stringify(roleId)}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    source.trim(),
  ].join("\n"));
}

async function expectedSharedFile(relativePath) {
  return ensureNewline(await readFile(path.join(repositoryRoot, "templates/shared", relativePath), "utf8"));
}

async function listTemplateFiles(directory, root = directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...await listTemplateFiles(entryPath, root));
    } else if (entry.isFile()) {
      result.push(path.relative(root, entryPath).split(path.sep).join("/"));
    }
  }
  return result.sort();
}

async function snapshotFiles(directory, root = directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...await snapshotFiles(entryPath, root));
    } else if (entry.isFile()) {
      result.push([
        path.relative(root, entryPath).split(path.sep).join("/"),
        await readFile(entryPath, "utf8"),
      ]);
    }
  }
  return result.sort(([left], [right]) => left.localeCompare(right));
}

function ensureNewline(value) {
  return `${value.trimEnd()}\n`;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
