import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { run } from "../bin/cli.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories = [];
const canonicalRoutes = {
  discovery: ["Discovery", "pm-ba"],
  design: ["Design", "designer"],
  architecture: ["Architecture", "architect"],
  implementation: ["Implementation", "software-engineer"],
  verification: ["Verification", "tester"],
  release: ["Release", "devops"],
};
const toolCases = [
  {
    tool: "copilot",
    instructions: ".github/copilot-instructions.md",
    agentsDirectory: ".github/agents",
    agentFile: (identity) => `${identity}.agent.md`,
    absent: ["CLAUDE.md", "AGENTS.md", ".claude", ".codex"],
  },
  {
    tool: "claude",
    instructions: "CLAUDE.md",
    agentsDirectory: ".claude/agents",
    agentFile: (identity) => `${identity}.md`,
    absent: [".github", "AGENTS.md", ".codex"],
  },
  {
    tool: "codex",
    instructions: "AGENTS.md",
    agentsDirectory: ".codex/agents",
    agentFile: (identity) => `${identity}.toml`,
    absent: [".github", "CLAUDE.md", ".claude"],
  },
];

test.after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("AC-01 architect-only initialization records no engineering profile and never asks engineering questions", async () => {
  const target = await temporaryDirectory();
  const questions = [];

  assert.equal(await run([
    "init",
    target,
    "--name",
    "Architecture Only",
    "--summary",
    "Plans architecture without a local developer",
    "--tool",
    "claude",
    "--roles",
    "architect",
  ], {
    output: () => {},
    prompt: async (question) => {
      questions.push(question);
      if (/delivery mode/iu.test(question)) return "1";
      throw new Error(`Architect-only initialization asked an unrelated question: ${question}`);
    },
  }), 0);

  const installation = await readJson(target, ".ai-sdlc/installation.json");
  assert.equal(installation.schemaVersion, 2);
  assert.deepEqual(installation.roles, ["architect"]);
  assert.equal(Object.hasOwn(installation, "roleProfiles"), false);
  assert.equal(questions.filter((question) => /engineer.*scope|frontend.*backend/iu.test(question)).length, 0);
  assert.equal(questions.filter((question) => /framework|language|database|technology stack/iu.test(question)).length, 0);
  assert.deepEqual(await readdir(path.join(target, ".claude/agents")), ["architect.md"]);
});

test("AC-02 software-engineer requires one scope question interactively and a scope flag non-interactively before writes", async () => {
  const nonInteractiveTarget = await temporaryDirectory();
  await writeFile(path.join(nonInteractiveTarget, "keep.txt"), "Keep me.\n", "utf8");

  await assert.rejects(run([
    "init",
    nonInteractiveTarget,
    "--name",
    "Missing Scope",
    "--summary",
    "Must fail closed",
    "--tool",
    "claude",
    "--roles",
    "software-engineer",
  ], { output: () => {} }), /engineer.*scope|--engineer-scope/iu);
  assert.deepEqual(await readdir(nonInteractiveTarget), ["keep.txt"]);

  const interactiveTarget = await temporaryDirectory();
  const questions = [];
  const answers = ["2", "2", "2", "1", "2", "2", "1"];
  assert.equal(await run([
    "init",
    interactiveTarget,
    "--name",
    "Interactive Scope",
    "--summary",
    "Selects one frontend developer",
    "--tool",
    "claude",
  ], {
    output: () => {},
    prompt: async (question) => {
      questions.push(question);
      return answers.shift() ?? "";
    },
  }), 0);

  const scopeQuestions = questions.filter((question) => /engineer.*scope|frontend.*backend/iu.test(question));
  assert.equal(scopeQuestions.length, 1, questions.join("\n---\n"));
  assert.equal(questions.filter((question) => /framework|language|database|technology stack/iu.test(question)).length, 0);
  assert.deepEqual(
    (await readJson(interactiveTarget, ".ai-sdlc/installation.json"))
      .roleProfiles["software-engineer"],
    { areas: ["frontend"], agentMode: "specialist" },
  );
});

test("AC-03 frontend and backend scopes record schema-v2 specialists and generate only the matching identity", async () => {
  const cases = [
    { tool: "copilot", area: "frontend", identity: "frontend-developer" },
    { tool: "claude", area: "backend", identity: "backend-developer" },
  ];

  for (const item of cases) {
    const target = await initializedProject(item.tool, item.area);
    const tool = toolCases.find((candidate) => candidate.tool === item.tool);
    const installation = await readJson(target, ".ai-sdlc/installation.json");
    assert.equal(installation.schemaVersion, 2);
    assert.deepEqual(installation.roles, ["software-engineer"]);
    assert.deepEqual(installation.roleProfiles, {
      "software-engineer": { areas: [item.area], agentMode: "specialist" },
    });
    assert.deepEqual(
      await readdir(path.join(target, tool.agentsDirectory)),
      [tool.agentFile(item.identity)],
    );
    assert.equal(existsSync(path.join(target, tool.agentsDirectory, tool.agentFile("software-engineer"))), false);
    const profile = await readFile(path.join(target, ".ai-sdlc/project-profile.md"), "utf8");
    assert.match(profile, new RegExp(`\\b${item.identity}\\b`, "u"));
    assert.match(profile, new RegExp(`\\b${item.area}\\b`, "iu"));
    assert.match(profile, /\bspecialist\b/iu);
  }
});

test("AC-03 repository ID is stable, overrideable, and safe for exact catalog matching", async () => {
  const defaultTarget = await initializedProject("claude", "frontend");
  const defaultInstallation = await readJson(defaultTarget, ".ai-sdlc/installation.json");
  assert.equal(defaultInstallation.repositoryId, path.basename(defaultTarget).toLowerCase());

  const explicitTarget = await initializedProject("claude", "frontend", {
    repositoryId: "customer-web",
  });
  const explicitInstallation = await readJson(explicitTarget, ".ai-sdlc/installation.json");
  assert.equal(explicitInstallation.repositoryId, "customer-web");
  assert.match(
    await readFile(path.join(explicitTarget, ".ai-sdlc/project-profile.md"), "utf8"),
    /\| Repository ID \| customer-web \|/u,
  );

  const unsafeTarget = await temporaryDirectory();
  await writeFile(path.join(unsafeTarget, "keep.txt"), "Keep me.\n", "utf8");
  for (const repositoryId of ["../customer-web", "аpi-service", "équipe"]) {
    await assert.rejects(run([
      "init",
      unsafeTarget,
      "--name",
      "Unsafe Repository ID",
      "--repository-id",
      repositoryId,
      "--summary",
      "Must reject ambiguous catalog identity",
      "--tool",
      "claude",
      "--roles",
      "software-engineer",
      "--engineer-scope",
      "frontend",
    ], { output: () => {} }), /repository-id.*lowercase kebab-case/iu);
  }
  assert.deepEqual(await readdir(unsafeTarget), ["keep.txt"]);

  const unicodeParent = await temporaryDirectory();
  const unicodeTarget = path.join(unicodeParent, "代码仓库");
  await mkdir(unicodeTarget);
  await assert.rejects(run([
    "init",
    unicodeTarget,
    "--name",
    "Unicode directory",
    "--summary",
    "Requires an explicit ASCII repository ID",
    "--tool",
    "claude",
    "--roles",
    "architect",
  ], { output: () => {} }), /cannot produce an ASCII repository ID.*--repository-id/iu);
  assert.deepEqual(await readdir(unicodeTarget), []);
});

test("AC-04 fullstack creates one agent while separate frontend and backend retain one canonical owner", async () => {
  const fullstack = await initializedProject("codex", "fullstack");
  const fullstackInstallation = await readJson(fullstack, ".ai-sdlc/installation.json");
  assert.deepEqual(fullstackInstallation.roleProfiles["software-engineer"], {
    areas: ["frontend", "backend"],
    agentMode: "fullstack",
  });
  assert.deepEqual(await readdir(path.join(fullstack, ".codex/agents")), ["fullstack-developer.toml"]);
  assert.match(
    await readFile(path.join(fullstack, ".ai-sdlc/project-profile.md"), "utf8"),
    /fullstack-developer[\s\S]{0,200}fullstack|fullstack[\s\S]{0,200}fullstack-developer/iu,
  );

  const separate = await initializedProject("copilot", "frontend,backend");
  const separateInstallation = await readJson(separate, ".ai-sdlc/installation.json");
  assert.deepEqual(separateInstallation.roles, ["software-engineer"]);
  assert.deepEqual(separateInstallation.roleProfiles["software-engineer"], {
    areas: ["frontend", "backend"],
    agentMode: "separate",
  });
  assert.deepEqual(
    (await readdir(path.join(separate, ".github/agents"))).sort(),
    ["backend-developer.agent.md", "frontend-developer.agent.md"],
  );
  const separateProfile = await readFile(path.join(separate, ".ai-sdlc/project-profile.md"), "utf8");
  assert.match(separateProfile, /frontend-developer/u);
  assert.match(separateProfile, /backend-developer/u);
  assert.match(separateProfile, /\bseparate\b/iu);
  const registry = await readJson(separate, ".ai-sdlc/artifact-hosts.json");
  assert.equal(registry.routes.implementation.phase, "Implementation");
  assert.equal(registry.routes.implementation.role, "software-engineer");

  const reversed = await initializedProject("claude", "backend,frontend");
  assert.deepEqual(
    (await readJson(reversed, ".ai-sdlc/installation.json"))
      .roleProfiles["software-engineer"],
    { areas: ["frontend", "backend"], agentMode: "separate" },
  );
});

test("AC-05 invalid scopes plus init-only update options fail before managed writes", async () => {
  const invalidInitArguments = [
    ["--roles", "software-engineer", "--engineer-scope", "mobile"],
    ["--roles", "software-engineer", "--engineer-scope", "frontend,frontend"],
    ["--roles", "software-engineer", "--engineer-scope", "frontend", "--engineer-mode", "separate"],
    ["--roles", "architect", "--engineer-scope", "frontend"],
  ];

  for (const extraArguments of invalidInitArguments) {
    const target = await temporaryDirectory();
    await writeFile(path.join(target, "keep.txt"), "Keep me.\n", "utf8");
    await assert.rejects(run([
      "init",
      target,
      "--name",
      "Invalid Profile",
      "--summary",
      "Must not partly initialize",
      "--tool",
      "claude",
      ...extraArguments,
    ], { output: () => {} }), /engineer|scope|mode|software-engineer|duplicate/iu);
    assert.deepEqual(await readdir(target), ["keep.txt"]);
  }

  const updateTarget = await architectOnlyProject();
  const workflowPath = path.join(updateTarget, ".ai-sdlc/workflow.md");
  for (const option of [
    ["--engineer-scope", "frontend"],
    ["--repository-id", "web-app"],
    ["--architecture-source", "https://example.com/architecture/"],
  ]) {
    await writeFile(workflowPath, "Outdated but untouched.\n", "utf8");
    await assert.rejects(
      run(["update", updateTarget, ...option], { output: () => {} }),
      /only available with init|initialization-only|init option/iu,
    );
    assert.equal(await readFile(workflowPath, "utf8"), "Outdated but untouched.\n");
  }
});

test("AC-05 interactive engineer scope retries a duplicate area instead of aborting", async () => {
  const target = await temporaryDirectory();
  const answers = ["frontend,frontend", "frontend"];
  const questions = [];

  assert.equal(await run([
    "init",
    target,
    "--name",
    "Retry Scope",
    "--summary",
    "Recovers from one malformed interactive choice",
    "--tool",
    "claude",
    "--roles",
    "software-engineer",
  ], {
    output: () => {},
    prompt: async (question) => {
      questions.push(question);
      return answers.shift() ?? "frontend";
    },
  }), 0);

  assert.equal(questions.length, 2);
  assert.deepEqual(
    (await readJson(target, ".ai-sdlc/installation.json"))
      .roleProfiles["software-engineer"],
    { areas: ["frontend"], agentMode: "specialist" },
  );
});

test("AC-06 initialization exposes no framework, language, database, or stack selection", async () => {
  const helpResult = spawnSync(
    process.execPath,
    [path.join(repositoryRoot, "bin/cli.js"), "--help"],
    { encoding: "utf8" },
  );
  assert.equal(helpResult.status, 0, helpResult.stderr);
  assert.doesNotMatch(helpResult.stdout, /--(?:framework|language|database|stack)(?:\s|=|$)/iu);

  const target = await temporaryDirectory();
  const questions = [];
  assert.equal(await run([
    "init",
    target,
    "--name",
    "No Stack Wizard",
    "--summary",
    "Keeps technology decisions with Architecture",
    "--tool",
    "codex",
    "--roles",
    "software-engineer",
    "--engineer-scope",
    "frontend",
  ], {
    output: () => {},
    prompt: async (question) => {
      questions.push(question);
      throw new Error("Complete non-interactive input must not prompt");
    },
  }), 0);
  assert.deepEqual(questions, []);
});

test("AC-07 filesystem and HTTPS architecture sources route externally while unsafe sources and local Architect conflicts fail", async () => {
  const externalRepository = await temporaryDirectory();
  await mkdir(path.join(externalRepository, "docs/ai-sdlc"), { recursive: true });

  const sourceCases = [
    {
      source: externalRepository,
      expectedHost: { kind: "filesystem", key: "root", value: externalRepository },
    },
    {
      source: "https://example.com/product-architecture",
      expectedHost: {
        kind: "url",
        key: "baseUrl",
        value: "https://example.com/product-architecture/",
      },
    },
  ];

  for (const item of sourceCases) {
    const target = await initializedProject("claude", "backend", {
      architectureSource: item.source,
    });
    const installation = await readJson(target, ".ai-sdlc/installation.json");
    const registry = await readJson(target, ".ai-sdlc/artifact-hosts.json");
    assert.deepEqual(installation.architectureSource, {
      kind: item.expectedHost.kind,
      [item.expectedHost.key]: item.expectedHost.value,
    });
    assert.equal(registry.routes.architecture.host, "delivery-project");
    assert.equal(registry.hosts["delivery-project"].kind, item.expectedHost.kind);
    assert.equal(registry.hosts["delivery-project"][item.expectedHost.key], item.expectedHost.value);
    assert.match(
      await readFile(path.join(target, ".ai-sdlc/project-profile.md"), "utf8"),
      new RegExp(escapeRegex(item.source), "u"),
    );
  }

  for (const item of [
    { source: "http://example.com/architecture/", roles: "software-engineer" },
    { source: "https://user:secret@example.com/architecture/", roles: "software-engineer" },
    { source: "https://example.com/architecture/", roles: "architect,software-engineer" },
    { source: "https://example.com/architecture/", roles: "architect" },
  ]) {
    const target = await temporaryDirectory();
    await writeFile(path.join(target, "keep.txt"), "Keep me.\n", "utf8");
    const args = [
      "init",
      target,
      "--name",
      "Rejected Source",
      "--summary",
      "Rejects an unsafe or conflicting source",
      "--tool",
      "claude",
      "--roles",
      item.roles,
      "--architecture-source",
      item.source,
    ];
    if (item.roles.includes("software-engineer")) {
      args.push("--engineer-scope", "backend");
    }
    await assert.rejects(run(args, { output: () => {} }), /architecture source|HTTPS|credential|unsafe|Architect|software-engineer/iu);
    assert.deepEqual(await readdir(target), ["keep.txt"]);
  }
});

test("AC-08 generated artifact bridge is read-only and resolves the technology catalog and scoped child paths", async () => {
  const target = await initializedProject("claude", "frontend");
  const registry = await readJson(target, ".ai-sdlc/artifact-hosts.json");
  const architecturePaths = registry.routes.architecture.paths;
  assert.ok(architecturePaths.includes("/docs/ai-sdlc/technology-profile.md"));
  assert.ok(
    architecturePaths.some((artifactPath) => artifactPath.startsWith("/docs/ai-sdlc/technology/")),
    architecturePaths.join(", "),
  );

  const bridge = await readFile(
    path.join(target, ".agents/skills/sdlc-artifact-bridge/SKILL.md"),
    "utf8",
  );
  assert.match(bridge, /read-only/iu);
  assert.match(bridge, /exact match[\s\S]{0,180}(?:longest matching path prefix|prefix match)/iu);
  assert.match(bridge, /do not[\s\S]{0,120}(?:clone|copy|synchron)/iu);
  assert.match(bridge, /do not[\s\S]{0,120}(?:write|modify|create)/iu);

  const catalogTemplate = await readFile(
    path.join(target, ".ai-sdlc/templates/technology-profile.md"),
    "utf8",
  );
  assert.match(catalogTemplate, /`\/docs\/ai-sdlc\/technology\/frontend\/<scope-id>\.md`/u);
  assert.match(catalogTemplate, /`\/docs\/ai-sdlc\/technology\/backend\/<scope-id>\.md`/u);
  assert.match(catalogTemplate, /Repository ID/u);
  assert.match(catalogTemplate, /Source host\/path/u);
  assert.match(catalogTemplate, /first matches Repository ID and Kind/iu);
  assert.match(catalogTemplate, /deployable or Scope ID set affected by the current task/iu);
  assert.match(catalogTemplate, /ambiguous[\s\S]{0,80}ask/iu);
  assert.match(catalogTemplate, /Planned \/ Not created/iu);
  assert.doesNotMatch(catalogTemplate, /`\.\/technology\/(?:frontend|backend)\//u);
});

test("AC-09 Architect guidance defines scoped first-use technology decisions and the human acceptance boundary", async () => {
  const target = await architectOnlyProject("codex");
  const guidance = await readAgent(target, "codex", "architect");

  for (const systemType of ["existing", "greenfield", "hybrid"]) {
    assert.match(guidance, new RegExp(`\\b${systemType}\\b`, "iu"), systemType);
  }
  for (const state of ["Required", "Accepted", "Observed", "Proposed", "Excluded", "Unknown"]) {
    assert.match(guidance, new RegExp(`\\b${state}\\b`, "u"), state);
  }
  assert.match(guidance, /docs\/ai-sdlc\/technology-profile\.md/u);
  assert.match(guidance, /docs\/ai-sdlc\/technology\/(?:frontend|backend)\//u);
  assert.match(guidance, /(?:human|person)[\s\S]{0,180}(?:accept|approval)|accept(?:ed|ance)[\s\S]{0,180}(?:human|person)/iu);
  assert.match(guidance, /rapid[\s\S]{0,800}(?:does not skip|must not skip|still (?:create|record|need))/iu);
  assert.match(guidance, /(?:do not|not required|skip|do not force)[\s\S]{0,260}(?:no code|does not contain application code|non-code repository|documentation-only|feasibility|data-only|integration-only)|(?:no code|does not contain application code|non-code repository|documentation-only|feasibility|data-only|integration-only)[\s\S]{0,260}(?:do not|not required|skip|do not force)/iu);
  assert.match(guidance, /shared contracts|identity|trust boundar|compatibility|ADR/iu);
  assert.match(guidance, /\[a-z0-9\][\s\S]{0,100}kebab-case|kebab-case[\s\S]{0,100}\[a-z0-9\]/iu);
  assert.match(guidance, /never[\s\S]{0,160}(?:slash|path|URL)|reject[\s\S]{0,160}(?:slash|path|URL)/iu);
  assert.match(guidance, /existing or hybrid[\s\S]{0,240}host ID[\s\S]{0,240}(?:filesystem|HTTPS)/iu);
  assert.match(guidance, /add only that host[\s\S]{0,120}do not add a phase route/iu);
  assert.match(guidance, /preserv[\s\S]{0,180}Proposed[\s\S]{0,180}accept[\s\S]{0,120}Accepted/iu);
  assert.match(guidance, /hybrid[\s\S]{0,180}per concern/iu);
});

test("AC-10 scoped developer agents have distinct boundaries, accepted-profile gating, scoped artifacts, and Clean Code discipline", async () => {
  const cases = [
    {
      scope: "frontend",
      identity: "frontend-developer",
      artifactArea: "frontend",
      boundary: /(?:frontend|client|user interface)[\s\S]{0,500}(?:boundary|responsib|own)/iu,
    },
    {
      scope: "backend",
      identity: "backend-developer",
      artifactArea: "backend",
      boundary: /(?:backend|server|service)[\s\S]{0,500}(?:boundary|responsib|own)/iu,
    },
    {
      scope: "fullstack",
      identity: "fullstack-developer",
      artifactArea: "fullstack",
      boundary: /(?:full-stack|fullstack)[\s\S]{0,500}(?:integration|frontend[\s\S]{0,80}backend|end.to.end)/iu,
    },
  ];
  const sharedDiscipline = [
    /domain[\s-]*(?:name|language)|naming[\s\S]{0,80}domain/iu,
    /cohesi/iu,
    /explicit dependenc|dependenc(?:y|ies)[\s\S]{0,40}explicit|explicit contract/iu,
    /boundary validation|validate[\s\S]{0,80}boundar/iu,
    /honest types?|types?[\s\S]{0,80}honest/iu,
    /error handling|handle errors?/iu,
    /side effects?|concurrency/iu,
    /least privilege/iu,
    /measur(?:e|ed)[\s\S]{0,80}performance|performance[\s\S]{0,80}measur|measure before optimizing/iu,
    /behavio(?:u)?ral tests?|test observable behavior/iu,
    /dependency restraint|dependencies[\s\S]{0,140}(?:restrain|necessary|need|sufficient|cost)/iu,
    /focused diffs?|unrelated cleanup|speculative abstraction/iu,
  ];

  for (const item of cases) {
    const target = await initializedProject("claude", item.scope);
    const guidance = await readAgent(target, "claude", item.identity);
    assert.match(guidance, item.boundary);
    assert.match(guidance, new RegExp(`docs/ai-sdlc/implementation/${item.artifactArea}/`, "u"));
    assert.match(guidance, /plan\.md[\s\S]{0,80}tasks\.md[\s\S]{0,80}notes\.md/u);
    assert.match(guidance, /Required[\s\S]{0,120}Accepted|Accepted[\s\S]{0,120}Required/u);
    assert.match(guidance, /Observed|Proposed|Excluded|Unknown/u);
    assert.match(guidance, /(?:only|must)[\s\S]{0,180}(?:Required|Accepted)|(?:Required|Accepted)[\s\S]{0,180}only/iu);
    for (const rule of sharedDiscipline) assert.match(guidance, rule, `${item.identity}: ${rule}`);
  }

  const separate = await initializedProject("claude", "frontend,backend");
  for (const identity of ["frontend-developer", "backend-developer"]) {
    const guidance = await readAgent(separate, "claude", identity);
    assert.match(guidance, /shared files/iu);
    assert.match(guidance, /single owner/iu);
    assert.match(guidance, /do not start parallel work/iu);
    assert.match(guidance, /never[\s\S]{0,100}(?:same shared file|both agents)/iu);
    assert.match(guidance, /lead[\s\S]{0,160}ask once/iu);
    assert.match(guidance, /lead[\s\S]{0,220}scoped `plan\.md`/iu);
    assert.match(guidance, /Repository ID[\s\S]{0,120}(?:exactly matches|matches)[\s\S]{0,120}`repositoryId`/iu);
  }

  const frontendProfile = await readFile(
    path.join(separate, ".ai-sdlc/templates/technology-profile-frontend.md"),
    "utf8",
  );
  assert.match(frontendProfile, /Client security and privacy[\s\S]{0,120}XSS[\s\S]{0,120}CSP[\s\S]{0,120}CSRF/iu);
});

test("AC-11 update restores the exact schema-v2 scoped set and rejects schema v1 without changing managed or delivery files", async () => {
  const target = await initializedProject("claude", "frontend,backend");
  const installationPath = path.join(target, ".ai-sdlc/installation.json");
  const profilePath = path.join(target, ".ai-sdlc/project-profile.md");
  const registryPath = path.join(target, ".ai-sdlc/artifact-hosts.json");
  const workflowPath = path.join(target, ".ai-sdlc/workflow.md");
  const frontendPath = path.join(target, ".claude/agents/frontend-developer.md");
  const backendPath = path.join(target, ".claude/agents/backend-developer.md");
  const deliveryPath = path.join(target, "docs/ai-sdlc/implementation/frontend/notes.md");
  const snapshots = {
    installation: await readFile(installationPath, "utf8"),
    profile: await readFile(profilePath, "utf8"),
    registry: await readFile(registryPath, "utf8"),
    workflow: await readFile(workflowPath, "utf8"),
    frontend: await readFile(frontendPath, "utf8"),
    backend: await readFile(backendPath, "utf8"),
  };
  await mkdir(path.dirname(deliveryPath), { recursive: true });
  await writeFile(deliveryPath, "# Project-owned notes\n\nPreserve this work.\n", "utf8");
  await writeFile(frontendPath, "Outdated frontend agent.\n", "utf8");
  await rm(backendPath);
  await writeFile(workflowPath, "Outdated workflow.\n", "utf8");

  assert.equal(await run(["update", target], { output: () => {} }), 0);
  assert.equal(await readFile(frontendPath, "utf8"), snapshots.frontend);
  assert.equal(await readFile(backendPath, "utf8"), snapshots.backend);
  assert.equal(await readFile(workflowPath, "utf8"), snapshots.workflow);
  assert.equal(await readFile(installationPath, "utf8"), snapshots.installation);
  assert.equal(await readFile(profilePath, "utf8"), snapshots.profile);
  assert.equal(await readFile(registryPath, "utf8"), snapshots.registry);
  assert.equal(await readFile(deliveryPath, "utf8"), "# Project-owned notes\n\nPreserve this work.\n");
  assert.deepEqual(
    (await readdir(path.join(target, ".claude/agents"))).sort(),
    ["backend-developer.md", "frontend-developer.md"],
  );

  const schemaOne = JSON.parse(snapshots.installation);
  schemaOne.schemaVersion = 1;
  await writeFile(installationPath, `${JSON.stringify(schemaOne, null, 2)}\n`, "utf8");
  await writeFile(workflowPath, "Schema-one sentinel workflow.\n", "utf8");
  await assert.rejects(
    run(["update", target], { output: () => {} }),
    /schema(?:Version)? 1|schema version 1|unsupported.*schema|migration/iu,
  );
  assert.equal(await readFile(workflowPath, "utf8"), "Schema-one sentinel workflow.\n");
  assert.equal((await readJson(target, ".ai-sdlc/installation.json")).schemaVersion, 1);
  assert.equal(await readFile(deliveryPath, "utf8"), "# Project-owned notes\n\nPreserve this work.\n");
});

test("AC-12 every supported tool renders only native scoped files and preserves create-only rollback", async () => {
  for (const item of toolCases) {
    const target = await initializedProject(item.tool, "frontend");
    assert.equal(existsSync(path.join(target, item.instructions)), true);
    assert.deepEqual(
      await readdir(path.join(target, item.agentsDirectory)),
      [item.agentFile("frontend-developer")],
    );
    for (const absentPath of item.absent) {
      assert.equal(existsSync(path.join(target, absentPath)), false, `${item.tool}: ${absentPath}`);
    }
  }

  const conflictTarget = await temporaryDirectory();
  const conflictPath = path.join(conflictTarget, ".claude/agents/frontend-developer.md");
  await mkdir(path.dirname(conflictPath), { recursive: true });
  await writeFile(conflictPath, "Project-owned agent.\n", "utf8");
  await assert.rejects(
    run(initArguments(conflictTarget, "claude", "frontend"), { output: () => {} }),
    /already exist|unsafe|refus|create-only|destination/iu,
  );
  assert.equal(await readFile(conflictPath, "utf8"), "Project-owned agent.\n");

  const rollbackTarget = await temporaryDirectory();
  await writeFile(path.join(rollbackTarget, "keep.txt"), "Keep me.\n", "utf8");
  await assert.rejects(run(initArguments(rollbackTarget, "claude", "frontend"), {
    output: () => {},
    beforeWrite: async ({ index }) => {
      if (index === 3) throw new Error("Injected acceptance-test failure");
    },
  }), /Injected acceptance-test failure/u);
  assert.deepEqual(await listFiles(rollbackTarget), ["keep.txt"]);
});

test("AC-13 six canonical phases and owners remain one-to-one with one collision-free registry route each", async () => {
  const target = await initializedProject("claude", "frontend,backend", {
    roles: "all",
  });
  const registry = await readJson(target, ".ai-sdlc/artifact-hosts.json");
  assert.deepEqual(Object.keys(registry.routes), Object.keys(canonicalRoutes));
  assert.equal(Object.values(registry.routes).length, 6);

  for (const [routeId, [phase, role]] of Object.entries(canonicalRoutes)) {
    assert.equal(registry.routes[routeId].phase, phase, routeId);
    assert.equal(registry.routes[routeId].role, role, routeId);
  }

  const workflow = await readFile(path.join(target, ".ai-sdlc/workflow.md"), "utf8");
  const phaseRows = workflow
    .split("\n")
    .filter((line) => /^\| (Discovery|Design|Architecture|Implementation|Verification|Release) \|/u.test(line));
  assert.deepEqual(
    phaseRows.map((line) => line.split("|").slice(1, 3).map((value) => value.trim())),
    [
      ["Discovery", "PM / BA"],
      ["Design", "Designer"],
      ["Architecture", "Architect"],
      ["Implementation", "Software Engineer"],
      ["Verification", "Tester"],
      ["Release", "DevOps"],
    ],
  );
  assert.equal(
    registry.routes.implementation.paths.filter((value, index, paths) => paths.indexOf(value) === index).length,
    registry.routes.implementation.paths.length,
  );
  assert.deepEqual(registry.routes.implementation.paths, ["/docs/ai-sdlc/implementation/"]);
});

test("AC-14 npm pack dry-run succeeds and includes the scoped engineering profile sources", async () => {
  const npmCache = await temporaryDirectory();
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: npmCache },
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const files = report[0].files.map((entry) => entry.path);
  assert.ok(files.includes("templates/agents/software-engineer.md"));
  assert.ok(files.includes("templates/shared/.agents/skills/sdlc-artifact-bridge/SKILL.md"));
  assert.ok(
    files.filter((file) => file.startsWith("templates/agent-scopes/software-engineer/")).length >= 3,
    "The package must include frontend, backend, and full-stack scope fragments",
  );
});

async function initializedProject(tool, engineerScope, options = {}) {
  const target = await temporaryDirectory();
  await run(initArguments(target, tool, engineerScope, options), { output: () => {} });
  return target;
}

function initArguments(target, tool, engineerScope, options = {}) {
  const args = [
    "init",
    target,
    "--name",
    "Scoped Engineering",
    "--summary",
    "Exercises scoped developer identities",
    "--tool",
    tool,
    "--roles",
    options.roles ?? "software-engineer",
    "--engineer-scope",
    engineerScope,
  ];
  if (options.repositoryId) args.push("--repository-id", options.repositoryId);
  if (options.architectureSource) args.push("--architecture-source", options.architectureSource);
  return args;
}

async function architectOnlyProject(tool = "claude") {
  const target = await temporaryDirectory();
  await run([
    "init",
    target,
    "--name",
    "Architecture Only",
    "--summary",
    "Exercises Architect guidance",
    "--tool",
    tool,
    "--roles",
    "architect",
  ], { output: () => {} });
  return target;
}

async function readJson(target, relativePath) {
  return JSON.parse(await readFile(path.join(target, relativePath), "utf8"));
}

async function readAgent(target, tool, identity) {
  const item = toolCases.find((candidate) => candidate.tool === tool);
  const generated = await readFile(
    path.join(target, item.agentsDirectory, item.agentFile(identity)),
    "utf8",
  );
  if (tool !== "codex") return generated;
  const instructions = generated.match(/^developer_instructions = (.+)$/mu);
  assert.ok(instructions, `Missing Codex instructions for ${identity}`);
  return JSON.parse(instructions[1]);
}

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "scoped-engineering-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function listFiles(directory, root = directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...await listFiles(entryPath, root));
    } else if (entry.isFile()) {
      result.push(path.relative(root, entryPath).split(path.sep).join("/"));
    }
  }
  return result.sort();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
