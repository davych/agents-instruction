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
    roleFileName: (roleId) => `${generatedRoleId(roleId)}.agent.md`,
  },
  {
    key: "claude",
    label: "Claude Code",
    instructions: "CLAUDE.md",
    agentsDirectory: ".claude/agents",
    roles: ["designer", "architect"],
    roleFileName: (roleId) => `${generatedRoleId(roleId)}.md`,
  },
  {
    key: "codex",
    label: "Codex",
    instructions: "AGENTS.md",
    agentsDirectory: ".codex/agents",
    roles: ["software-engineer", "devops"],
    roleFileName: (roleId) => `${generatedRoleId(roleId)}.toml`,
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
    const originalFirstRole = await readFile(firstRole, "utf8");
    const originalSecondRole = await readFile(secondRole, "utf8");
    const output = [];

    await writeFile(firstRole, "Outdated managed role.\n", "utf8");
    await rm(secondRole);

    assert.equal(await run(["update", target], {
      output: (value) => output.push(value),
      prompt: async () => {
        throw new Error("update must not prompt for initialization values");
      },
    }), 0);

    assert.equal(await readFile(firstRole, "utf8"), originalFirstRole);
    assert.equal(await readFile(secondRole, "utf8"), originalSecondRole);
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

test("AC-11 schema-v2 metadata records and restores the full-stack developer profile", async () => {
  const target = await initializedProject("codex", "software-engineer");
  const installationPath = path.join(target, ".ai-sdlc/installation.json");
  const developerPath = path.join(target, ".codex/agents/fullstack-developer.toml");
  const originalDeveloper = await readFile(developerPath, "utf8");

  assert.deepEqual(JSON.parse(await readFile(installationPath, "utf8")), {
    schemaVersion: 2,
    repositoryId: path.basename(target).toLowerCase(),
    tool: "codex",
    roles: ["software-engineer"],
    deliveryMode: "formal",
    roleProfiles: {
      "software-engineer": {
        areas: ["frontend", "backend"],
        agentMode: "fullstack",
      },
    },
  });

  await writeFile(developerPath, "Outdated full-stack developer.\n", "utf8");
  assert.equal(await run(["update", target], { output: () => {} }), 0);
  assert.equal(await readFile(developerPath, "utf8"), originalDeveloper);
  assert.equal(existsSync(path.join(target, ".codex/agents/software-engineer.toml")), false);
});

test("AC-11 architecture source object member order is not significant", async () => {
  const target = await initializedProject("claude", "software-engineer", "formal", {
    engineerScope: "backend",
    architectureSource: "https://example.com/delivery/",
  });
  const installationPath = path.join(target, ".ai-sdlc/installation.json");
  const workflowPath = path.join(target, ".ai-sdlc/workflow.md");
  const installation = JSON.parse(await readFile(installationPath, "utf8"));
  installation.architectureSource = {
    baseUrl: installation.architectureSource.baseUrl,
    kind: installation.architectureSource.kind,
  };

  await writeFile(installationPath, `${JSON.stringify(installation, null, 2)}\n`, "utf8");
  await writeFile(workflowPath, "Outdated workflow.\n", "utf8");

  assert.equal(await run(["update", target], { output: () => {} }), 0);
  assert.notEqual(await readFile(workflowPath, "utf8"), "Outdated workflow.\n");
});

test("AC-11 update preserves a rapid installation choice and project-owned state", async () => {
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

test("AC-11 update rejects a conflicting known scoped developer identity", async () => {
  const target = await initializedProject("claude", "software-engineer", "formal", {
    engineerScope: "frontend",
  });
  const unexpectedAgent = path.join(target, ".claude/agents/backend-developer.md");
  const workflowPath = path.join(target, ".ai-sdlc/workflow.md");
  await writeFile(unexpectedAgent, "# Project-owned conflicting identity\n", "utf8");
  await writeFile(workflowPath, "Stale workflow.\n", "utf8");

  await assert.rejects(
    run(["update", target], { output: () => {} }),
    /conflicting scoped developer agent.*backend-developer/iu,
  );
  assert.equal(
    await readFile(unexpectedAgent, "utf8"),
    "# Project-owned conflicting identity\n",
  );
  assert.equal(await readFile(workflowPath, "utf8"), "Stale workflow.\n");
});

test("AC-11 update rejects a known developer identity when no engineer role is configured", async () => {
  const target = await initializedProject("claude", "architect");
  const unexpectedAgent = path.join(target, ".claude/agents/frontend-developer.md");
  const workflowPath = path.join(target, ".ai-sdlc/workflow.md");
  await writeFile(unexpectedAgent, "# Unexpected developer identity\n", "utf8");
  await writeFile(workflowPath, "Stale workflow.\n", "utf8");

  await assert.rejects(
    run(["update", target], { output: () => {} }),
    /conflicting scoped developer agent.*frontend-developer/iu,
  );
  assert.equal(
    await readFile(unexpectedAgent, "utf8"),
    "# Unexpected developer identity\n",
  );
  assert.equal(await readFile(workflowPath, "utf8"), "Stale workflow.\n");
});

test("AC-11 update clearly rejects schemaVersion 1 without changing managed files", async () => {
  const target = await initializedProject("claude", "tester");
  const installationPath = path.join(target, ".ai-sdlc/installation.json");
  const workflowPath = path.join(target, ".ai-sdlc/workflow.md");
  const installation = JSON.parse(await readFile(installationPath, "utf8"));
  installation.schemaVersion = 1;

  await writeFile(installationPath, `${JSON.stringify(installation, null, 2)}\n`, "utf8");
  await writeFile(workflowPath, "Outdated workflow.\n", "utf8");

  await assert.rejects(
    run(["update", target], { output: () => {} }),
    /installation\.json.*(?:schema|version|unsupported)|schema.*version.*1/iu,
  );
  assert.equal(await readFile(workflowPath, "utf8"), "Outdated workflow.\n");
});

test("AC-11 installation metadata is authoritative over the profile snapshot", async () => {
  const target = await initializedProject("claude", "architect", "rapid");
  const installationPath = path.join(target, ".ai-sdlc/installation.json");
  const profilePath = path.join(target, ".ai-sdlc/project-profile.md");
  const workflowPath = path.join(target, ".ai-sdlc/workflow.md");
  const output = [];
  const installation = JSON.parse(await readFile(installationPath, "utf8"));
  const changedProfile = (await readFile(profilePath, "utf8"))
    .replace("| Delivery mode | rapid |", "| Delivery mode | formal |")
    .replace(
      `| Repository ID | ${installation.repositoryId} |`,
      "| Repository ID | profile-snapshot-only |",
    )
    .concat("\nUnrelated note: Delivery mode is not a configuration row.\n");

  await writeFile(profilePath, changedProfile, "utf8");
  await writeFile(workflowPath, "Outdated workflow.\n", "utf8");

  assert.equal(
    await run(["update", target], { output: (value) => output.push(value) }),
    0,
  );
  assert.equal(JSON.parse(await readFile(installationPath, "utf8")).deliveryMode, "rapid");
  assert.equal(
    JSON.parse(await readFile(installationPath, "utf8")).repositoryId,
    installation.repositoryId,
  );
  assert.equal(await readFile(profilePath, "utf8"), changedProfile);
  assert.equal(
    await readFile(workflowPath, "utf8"),
    await expectedSharedFile(".ai-sdlc/workflow.md"),
  );
  assert.match(output.join(""), /Delivery mode: rapid/iu);
  assert.match(output.join(""), new RegExp(`Repository ID: ${installation.repositoryId}`, "u"));
  assert.match(output.join(""), /Delivery mode source: \.ai-sdlc\/installation\.json/iu);
});

test("AC-11 update rechecks authoritative metadata after planning hooks", async () => {
  const target = await initializedProject("claude", "architect", "formal");
  const installationPath = path.join(target, ".ai-sdlc/installation.json");
  const workflowPath = path.join(target, ".ai-sdlc/workflow.md");
  await writeFile(workflowPath, "Outdated workflow.\n", "utf8");

  await assert.rejects(
    run(["update", target], {
      output: () => {},
      beforePlan: async () => {
        const installation = JSON.parse(await readFile(installationPath, "utf8"));
        installation.repositoryId = "changed-during-update";
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

test("AC-11 update rechecks authoritative metadata immediately before each write", async () => {
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

test("AC-11 project profile changes during update do not switch identity or mode", async () => {
  const target = await initializedProject("claude", "architect", "formal");
  const installation = JSON.parse(
    await readFile(path.join(target, ".ai-sdlc/installation.json"), "utf8"),
  );
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
          profile
            .replace("| Delivery mode | formal |", "| Delivery mode | rapid |")
            .replace(
              `| Repository ID | ${installation.repositoryId} |`,
              "| Repository ID | profile-only-id |",
            ),
          "utf8",
        );
      },
    }),
    0,
  );
  assert.match(await readFile(profilePath, "utf8"), /\| Delivery mode \| rapid \|/u);
  assert.match(await readFile(profilePath, "utf8"), /\| Repository ID \| profile-only-id \|/u);
  assert.match(output.join(""), /Delivery mode: formal/iu);
  assert.match(output.join(""), new RegExp(`Repository ID: ${installation.repositoryId}`, "u"));
  assert.match(output.join(""), /Delivery mode source: \.ai-sdlc\/installation\.json/iu);
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

test("AC-11 update requires current installation metadata and does not migrate", async () => {
  const target = await initializedProject("claude", "tester");
  const installation = path.join(target, ".ai-sdlc/installation.json");
  const workflow = path.join(target, ".ai-sdlc/workflow.md");

  await rm(installation);
  await writeFile(workflow, "Outdated workflow.\n", "utf8");

  await assert.rejects(
    run(["update", target], { output: () => {} }),
    /installation\.json|current installation metadata|not initialized/iu,
  );

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

test("missing installation metadata is rejected even when --tool is provided", async () => {
  const target = await initializedProject("claude", "tester");
  const workflow = path.join(target, ".ai-sdlc/workflow.md");
  const claudeRole = path.join(target, ".claude/agents/tester.md");

  await rm(path.join(target, ".ai-sdlc/installation.json"));
  await writeFile(workflow, "Outdated workflow.\n", "utf8");
  await writeFile(claudeRole, "Outdated Claude role.\n", "utf8");

  await assert.rejects(
    run(["update", target, "--tool", "claude"], { output: () => {} }),
    /installation\.json|current installation metadata|not initialized/iu,
  );
  assert.equal(await readFile(workflow, "utf8"), "Outdated workflow.\n");
  assert.equal(await readFile(claudeRole, "utf8"), "Outdated Claude role.\n");
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

test("ordinary tool files do not replace required installation metadata", async () => {
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
    /installation\.json|current installation metadata|not initialized/iu,
  );
  assert.equal(await readFile(unrelatedRole, "utf8"), "# Custom tester\n");
  assert.equal(await readFile(workflow, "utf8"), "Outdated workflow.\n");
});

test("invalid installation metadata fails closed before managed files change", async () => {
  const invalidRecords = [
    { schemaVersion: 1, tool: "unknown", roles: [] },
    { schemaVersion: 2, tool: "unknown", roles: [], deliveryMode: "formal" },
    { schemaVersion: 2, tool: "claude", roles: [null], deliveryMode: "formal" },
    {
      schemaVersion: 2,
      tool: "claude",
      roles: ["tester", "pm-ba"],
      deliveryMode: "formal",
    },
    { schemaVersion: 2, tool: "claude", roles: ["tester"], deliveryMode: "fast" },
    { schemaVersion: 2, tool: "claude", roles: ["tester"], deliveryMode: null },
    { schemaVersion: 2, tool: "claude", roles: ["tester"], deliveryMode: ["formal"] },
    {
      schemaVersion: 2,
      tool: "claude",
      roles: ["tester"],
      deliveryMode: "formal",
      unexpected: { future: true },
    },
    {
      schemaVersion: 2,
      tool: "claude",
      roles: ["software-engineer"],
      deliveryMode: "formal",
    },
    {
      schemaVersion: 2,
      tool: "claude",
      roles: ["tester"],
      deliveryMode: "formal",
      roleProfiles: {
        "software-engineer": { areas: ["frontend"], agentMode: "specialist" },
      },
    },
  ].map((record) => record.schemaVersion === 2
    ? { repositoryId: "test-repository", ...record }
    : record);

  invalidRecords.push(
    {
      schemaVersion: 2,
      repositoryId: "bad/repository",
      tool: "claude",
      roles: ["tester"],
      deliveryMode: "formal",
    },
    {
      schemaVersion: 2,
      repositoryId: "other:repository",
      tool: "claude",
      roles: ["tester"],
      deliveryMode: "formal",
    },
  );

  for (const record of invalidRecords) {
    const target = await initializedProject("claude", "tester");
    const installation = path.join(target, ".ai-sdlc/installation.json");
    const workflow = path.join(target, ".ai-sdlc/workflow.md");

    await writeFile(installation, `${JSON.stringify(record)}\n`, "utf8");
    await writeFile(workflow, "Outdated workflow.\n", "utf8");

    await assert.rejects(
      run(["update", target], { output: () => {} }),
      /installation\.json.*(?:unsupported|invalid|missing|must be|must not|unexpected|without)/iu,
    );
    assert.equal(await readFile(workflow, "utf8"), "Outdated workflow.\n");
  }
});

test("duplicate installation keys at any object level fail closed before managed files change", async () => {
  const duplicateRecords = [
    '{"schemaVersion":2,"tool":"claude","roles":["tester"],"deliveryMode":"formal","deliveryMode":"rapid"}\n',
    '{"schemaVersion":2,"tool":"claude","roles":["tester"],"deliveryMode":"formal","delivery\\u004dode":"rapid"}\n',
    '{"schemaVersion":2,"tool":"codex","roles":["software-engineer"],"deliveryMode":"formal","roleProfiles":{"software-engineer":{"areas":["frontend"],"agentMode":"specialist"},"software-engineer":{"areas":["backend"],"agentMode":"specialist"}}}\n',
    '{"schemaVersion":2,"tool":"codex","roles":["software-engineer"],"deliveryMode":"formal","roleProfiles":{"software-engineer":{"areas":["frontend"],"areas":["backend"],"agentMode":"specialist"}}}\n',
    '{"schemaVersion":2,"tool":"codex","roles":["software-engineer"],"deliveryMode":"formal","roleProfiles":{"software-engineer":{"areas":["frontend"],"agentMode":"specialist","agent\\u004dode":"fullstack"}}}\n',
  ];

  for (const source of duplicateRecords) {
    const target = await initializedProject("claude", "tester");
    const installation = path.join(target, ".ai-sdlc/installation.json");
    const workflow = path.join(target, ".ai-sdlc/workflow.md");

    await writeFile(installation, source, "utf8");
    await writeFile(workflow, "Outdated workflow.\n", "utf8");

    await assert.rejects(
      run(["update", target], { output: () => {} }),
      /installation\.json.*duplicate.*key/iu,
    );
    assert.equal(await readFile(workflow, "utf8"), "Outdated workflow.\n");
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

test("update does not report success when an earlier managed file changes concurrently", async () => {
  const target = await initializedProject("claude", "tester");
  const planningPath = path.join(target, ".ai-sdlc/technology-planning.md");
  const workflowPath = path.join(target, ".ai-sdlc/workflow.md");
  await writeFile(planningPath, "Stale planning.\n", "utf8");
  await writeFile(workflowPath, "Stale workflow.\n", "utf8");
  let firstWrittenPath = null;

  await assert.rejects(
    run(["update", target], {
      output: () => {},
      beforeWrite: async ({ path: entryPath }) => {
        if (firstWrittenPath === null) {
          firstWrittenPath = entryPath;
          return;
        }
        await writeFile(path.join(target, firstWrittenPath), "Concurrent project change.\n", "utf8");
      },
    }),
    /changed before update completed|could not be restored safely|concurrent/iu,
  );

  assert.equal(
    await readFile(path.join(target, firstWrittenPath), "utf8"),
    "Concurrent project change.\n",
  );
  assert.equal(await readFile(workflowPath, "utf8"), "Stale workflow.\n");
});

test("update does not report success when a preflight-unchanged file changes concurrently", async () => {
  const target = await initializedProject("claude", "tester");
  const planningPath = path.join(target, ".ai-sdlc/technology-planning.md");
  const workflowPath = path.join(target, ".ai-sdlc/workflow.md");
  await writeFile(workflowPath, "Stale workflow.\n", "utf8");

  await assert.rejects(
    run(["update", target], {
      output: () => {},
      beforeWrite: async ({ path: entryPath }) => {
        if (entryPath === ".ai-sdlc/workflow.md") {
          await writeFile(planningPath, "Concurrent project change.\n", "utf8");
        }
      },
    }),
    /changed before update completed|concurrent/iu,
  );

  assert.equal(await readFile(planningPath, "utf8"), "Concurrent project change.\n");
  assert.equal(await readFile(workflowPath, "utf8"), "Stale workflow.\n");
});

test("AC-05 update rejects every initialization-only configuration option", async () => {
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
  await assert.rejects(
    run(["update", ".", "--engineer-scope", "frontend"]),
    /--engineer-scope is only available with init/u,
  );
  await assert.rejects(
    run(["update", ".", "--repository-id", "api-service"]),
    /--repository-id is only available with init/u,
  );
  await assert.rejects(
    run(["update", ".", "--architecture-source", "..\/delivery"]),
    /--architecture-source is only available with init/u,
  );
  await assert.rejects(run(["update", ".", "extra"]), /Unexpected argument/u);

  const target = await initializedProject("claude", "architect");
  await writeFile(path.join(target, ".ai-sdlc/workflow.md"), "Outdated workflow.\n", "utf8");
  assert.equal(await run(["update", "--tool", "claude"], {
    cwd: target,
    output: () => {},
  }), 0);
});

async function initializedProject(tool, roles, deliveryMode, options = {}) {
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
  if (roles === "all" || roles.split(",").includes("software-engineer")) {
    args.push("--engineer-scope", options.engineerScope ?? "fullstack");
  }
  if (options.architectureSource) {
    args.push("--architecture-source", options.architectureSource);
  }
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

function generatedRoleId(roleId) {
  return roleId === "software-engineer" ? "fullstack-developer" : roleId;
}
