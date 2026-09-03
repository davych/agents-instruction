import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
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
const roleIds = [
  "pm-ba",
  "designer",
  "architect",
  "software-engineer",
  "tester",
  "devops",
];
const allRolesArgs = ["--roles", "all"];
const templateFiles = [
  "architecture-adr.md",
  "architecture-c4-containers.mmd",
  "architecture-c4-context.mmd",
  "architecture-discovery-context.md",
  "architecture-nfrs.md",
  "architecture-options.md",
  "architecture-patterns.md",
  "architecture-risk-review.md",
  "architecture.md",
  "design-baseline.md",
  "design-spec.md",
  "implementation-notes.md",
  "implementation-plan.md",
  "implementation-tasks.md",
  "prd.md",
  "release-runbook.md",
  "story.md",
  "technology-profile.md",
  "test-report.md",
];

test.after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("each AI tool gets only its native instructions and selected role files", async () => {
  const cases = [
    {
      tool: "copilot",
      instructions: ".github/copilot-instructions.md",
      directory: ".github/agents",
      fileName: (roleId) => `${roleId}.agent.md`,
      absent: ["CLAUDE.md", "AGENTS.md", ".claude", ".codex", ".vscode/mcp.json", ".mcp.json"],
    },
    {
      tool: "claude",
      instructions: "CLAUDE.md",
      directory: ".claude/agents",
      fileName: (roleId) => `${roleId}.md`,
      absent: [".github", "AGENTS.md", ".codex", ".vscode/mcp.json", ".mcp.json"],
    },
    {
      tool: "codex",
      instructions: "AGENTS.md",
      directory: ".codex/agents",
      fileName: (roleId) => `${roleId}.toml`,
      absent: [".github", "CLAUDE.md", ".claude", ".vscode/mcp.json", ".mcp.json", ".codex/config.toml"],
    },
  ];

  for (const item of cases) {
    const target = await initializedProject(item.tool);
    assert.equal(existsSync(path.join(target, item.instructions)), true);
    assert.deepEqual(
      (await readdir(path.join(target, item.directory))).sort(),
      roleIds.map(item.fileName).sort(),
    );
    for (const absent of item.absent) {
      assert.equal(existsSync(path.join(target, absent)), false, `${item.tool}: ${absent}`);
    }

    for (const roleId of roleIds) {
      const generated = await readFile(
        path.join(target, item.directory, item.fileName(roleId)),
        "utf8",
      );
      const source = (await readFile(
        path.join(repositoryRoot, "templates/agents", `${roleId}.md`),
        "utf8",
      )).trim();
      if (item.tool === "codex") {
        assert.match(generated, new RegExp(`^name = "${roleId}"\\ndescription = `, "u"));
        assert.equal(await readCodexInstructions(
          path.join(target, item.directory, item.fileName(roleId)),
        ), source);
      } else {
        assert.match(generated, new RegExp(`^---\\nname: "${roleId}"\\ndescription: `, "u"));
        assert.ok(generated.trimEnd().endsWith(source));
      }
    }
  }
});

test("AC-03 all roles record the canonical default delivery mode without changing core outputs", async () => {
  const target = await temporaryDirectory();
  const output = [];

  assert.equal(await run([
    "init",
    target,
    "--name",
    "Small Product",
    "--summary",
    "Solves one clear problem",
    "--tool",
    "copilot",
    ...allRolesArgs,
  ], { output: (value) => output.push(value) }), 0);

  assert.equal(existsSync(path.join(target, ".github/copilot-instructions.md")), true);
  assert.match(output.join(""), /Installation: \.ai-sdlc\/installation\.json/u);
  assert.match(output.join(""), /Profile: \.ai-sdlc\/project-profile\.md/u);
  assert.match(output.join(""), /Artifact hosts: \.ai-sdlc\/artifact-hosts\.json/u);
  assert.match(output.join(""), /Artifact bridge: \.agents\/skills\/sdlc-artifact-bridge\/SKILL\.md/u);
  assert.match(output.join(""), /Selected roles: pm-ba, designer, architect, software-engineer, tester, devops/u);
  assert.match(output.join(""), /Delivery mode: formal/iu);

  const instructions = await readFile(
    path.join(target, ".github/copilot-instructions.md"),
    "utf8",
  );
  assert.match(instructions, /\*\*Project:\*\* Small Product/u);
  assert.match(instructions, /\*\*Goal:\*\* Solves one clear problem/u);
  assert.match(instructions, /`docs\/ai-sdlc\/index\.md`/u);
  assert.match(instructions, /Available dedicated role agents are in `\.github\/agents`/u);
  assert.match(instructions, /`\.ai-sdlc\/project-profile\.md`/u);
  assert.match(instructions, /`\.ai-sdlc\/artifact-hosts\.json`/u);
  assert.match(instructions, /`sdlc-artifact-bridge` skill/u);

  const profile = await readFile(path.join(target, ".ai-sdlc/project-profile.md"), "utf8");
  assert.match(profile, /\| Delivery mode \| formal \|/iu);
  assert.match(profile, /\| Local role agents \| pm-ba, designer, architect, software-engineer, tester, devops \|/u);
  assert.match(profile, /\| Active local phases \| Discovery, Design, Architecture, Implementation, Verification, Release \|/u);
  assert.match(profile, /\| Technology profile \| `docs\/ai-sdlc\/technology-profile\.md` when first created by the Architect \|/u);
  assert.match(profile, /\| Artifact host registry \| `\.ai-sdlc\/artifact-hosts\.json` \|/u);
  assert.match(profile, /\| Artifact bridge skill \| `\.agents\/skills\/sdlc-artifact-bridge\/SKILL\.md` \|/u);
  assert.doesNotMatch(profile, /\| (?:Development work|Development area|Stack preference|UI system|UI MCP|Validation preference) \|/u);

  assert.equal(existsSync(path.join(target, ".ai-sdlc/artifact-hosts.json")), true);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(target, ".ai-sdlc/installation.json"), "utf8")),
    { schemaVersion: 1, tool: "copilot", roles: roleIds, deliveryMode: "formal" },
  );
  assert.equal(existsSync(path.join(target, ".agents/skills/sdlc-artifact-bridge/SKILL.md")), true);
  assert.equal(existsSync(path.join(target, ".vscode/mcp.json")), false);
  assert.equal(existsSync(path.join(target, ".mcp.json")), false);
});

test("roles can be sparse or absent without hidden dependencies", async () => {
  const sparse = await initializedProject("claude", { roles: "tester,designer" });
  assert.deepEqual(await readdir(path.join(sparse, ".claude/agents")), ["designer.md", "tester.md"]);
  const sparseProfile = await readFile(path.join(sparse, ".ai-sdlc/project-profile.md"), "utf8");
  assert.match(sparseProfile, /\| Local role agents \| designer, tester \|/u);
  assert.match(sparseProfile, /\| Active local phases \| Design, Verification \|/u);
  assert.match(sparseProfile, /\| Discovery \| pm-ba \| Not initialized \| unconfigured \|/u);
  assert.match(sparseProfile, /\| Design \| designer \| Initialized \| local \|/u);
  assert.match(sparseProfile, /\| Verification \| tester \| Initialized \| local \|/u);

  const empty = await initializedProject("codex", { roles: "none" });
  assert.equal(existsSync(path.join(empty, ".codex/agents")), false);
  assert.equal(existsSync(path.join(empty, "AGENTS.md")), true);
  assert.equal(existsSync(path.join(empty, ".ai-sdlc/artifact-hosts.json")), true);
  assert.equal(existsSync(path.join(empty, ".agents/skills/sdlc-artifact-bridge/SKILL.md")), true);
  const emptyProfile = await readFile(path.join(empty, ".ai-sdlc/project-profile.md"), "utf8");
  assert.match(emptyProfile, /\| Local role agents \| None \|/u);
  assert.match(emptyProfile, /\| Active local phases \| None \|/u);
});

test("artifact registry has six independent routes and repository-root path patterns", async () => {
  const target = await initializedProject("claude", { roles: "architect,devops" });
  const registry = JSON.parse(
    await readFile(path.join(target, ".ai-sdlc/artifact-hosts.json"), "utf8"),
  );

  assert.equal(registry.version, 1);
  assert.equal(registry.defaultHost, "local");
  assert.deepEqual(registry.hosts.local, {
    kind: "filesystem",
    root: ".",
    artifactIndex: "docs/ai-sdlc/index.md",
  });
  assert.deepEqual(Object.keys(registry.routes), [
    "discovery",
    "design",
    "architecture",
    "implementation",
    "verification",
    "release",
  ]);

  for (const [phase, route] of Object.entries(registry.routes)) {
    const selected = phase === "architecture" || phase === "release";
    assert.equal(route.host, selected ? "local" : null, phase);
    assert.equal(Object.hasOwn(route, "status"), false, phase);
    assert.ok(route.paths.length > 0, phase);
    assert.ok(route.paths.every((value) => value.startsWith("/docs/ai-sdlc/")), phase);
  }
});

test("the generated bridge skill resolves local, filesystem, and HTTPS artifacts without an MCP adapter", async () => {
  for (const tool of ["copilot", "claude", "codex"]) {
    const target = await initializedProject(tool, { roles: "none" });
    const skill = await readFile(
      path.join(target, ".agents/skills/sdlc-artifact-bridge/SKILL.md"),
      "utf8",
    );
    assert.match(skill, /^---\nname: sdlc-artifact-bridge\n/mu);
    assert.match(skill, /\.ai-sdlc\/artifact-hosts\.json/u);
    assert.match(skill, /leading `\/` as a path from the selected repository root/u);
    assert.match(skill, /`filesystem` host/u);
    assert.match(skill, /HTTPS host/u);
    assert.match(skill, /remove exactly the validated logical path's first `\/`/u);
    assert.match(skill, /Do not resolve the logical path from the origin root/u);
    assert.match(skill, /same origin and under the configured base path/u);
    assert.match(skill, /exact match first, otherwise use the single longest matching path prefix/u);
    assert.match(skill, /its `host` must not be null/u);
    assert.match(skill, /reject a backslash or any `\.\.` path segment before or after URL decoding/u);
    assert.match(skill, /including through symbolic links/u);
    assert.match(skill, /read-only/u);
    assert.match(skill, /Do not (?:clone, fetch, synchronize|synchronize, copy)/u);
    assert.match(skill, /Do not use an MCP server for artifact resolution/u);
  }

  const baseUrl = new URL("https://example.com/product-docs/");
  const logicalPath = "/docs/ai-sdlc/prd.md";
  assert.equal(
    new URL(logicalPath.slice(1), baseUrl).href,
    "https://example.com/product-docs/docs/ai-sdlc/prd.md",
  );
});

test("project profile records safe root-level evidence for later Architect planning", async () => {
  const target = await temporaryDirectory();
  await writeFile(path.join(target, "package.json"), JSON.stringify({
    dependencies: { react: "latest", vite: "latest", tailwindcss: "latest" },
    scripts: { build: "vite build", lint: "eslint .", privateTask: "secret-command" },
  }), "utf8");
  await writeFile(path.join(target, "components.json"), JSON.stringify({
    $schema: "https://ui.shadcn.com/schema.json",
  }), "utf8");

  await run([
    "init",
    target,
    "--name",
    "Detected Frontend",
    "--summary",
    "Records safe project evidence",
    "--tool",
    "claude",
    "--roles",
    "architect",
  ], { output: () => {} });

  const profile = await readFile(path.join(target, ".ai-sdlc/project-profile.md"), "utf8");
  assert.match(profile, /\| package\.json \| Node\.js package manifest; React dependency; Vite dependency; Tailwind CSS dependency; scripts: build, lint \| Architect technology-profile evidence \|/u);
  assert.match(profile, /\| components\.json \| shadcn\/ui project configuration \| Architect technology-profile evidence \|/u);
  assert.doesNotMatch(profile, /privateTask|secret-command/u);
  assert.equal(profile.includes(target), false);
});

test("AC-02 interactive init asks for delivery mode after relevant role selection and retries invalid answers", async () => {
  const target = await temporaryDirectory();
  const questions = [];
  const output = [];
  const prompt = answers(["1", "2", "1", "2", "1", "2", "not-a-mode", "2"], questions);

  await run([
    "init",
    target,
    "--name",
    "Role Questions",
    "--summary",
    "Chooses roles independently",
    "--tool",
    "claude",
  ], { prompt, output: (value) => output.push(value) });

  assert.equal(questions.length, 8);
  assert.deepEqual(
    questions.slice(0, 6).map((question) => question.match(/^Initialize the (.+?) role/mu)?.[1]),
    ["PM / BA", "Designer", "Architect", "Software Engineer", "Tester", "DevOps"],
  );
  assert.equal(
    questions.slice(0, 6).some((question) => /development|stack|validation/iu.test(question)),
    false,
  );
  assert.ok(questions.slice(6).every((question) => /delivery mode/iu.test(question)));
  assert.ok(
    questions[6].toLowerCase().indexOf("formal")
      < questions[6].toLowerCase().indexOf("rapid"),
    "formal must be the first delivery-mode choice",
  );
  assert.deepEqual(
    (await readdir(path.join(target, ".claude/agents"))).sort(),
    ["architect.md", "pm-ba.md", "tester.md"],
  );
  assert.match(output.join(""), /Selected roles: pm-ba, architect, tester/u);
  assert.match(output.join(""), /Delivery mode: rapid/iu);
  assert.equal(
    JSON.parse(await readFile(path.join(target, ".ai-sdlc/installation.json"), "utf8"))
      .deliveryMode,
    "rapid",
  );
});

test("AC-02 interactive init skips the delivery-mode question when no selected role uses it", async () => {
  const cases = [
    { answers: ["2", "2", "2", "1", "1", "1"], roles: ["software-engineer", "tester", "devops"] },
    { answers: ["2", "2", "2", "2", "2", "2"], roles: [] },
  ];

  for (const item of cases) {
    const target = await temporaryDirectory();
    const questions = [];

    await run([
      "init",
      target,
      "--name",
      "Role Questions",
      "--summary",
      "Chooses roles independently",
      "--tool",
      "claude",
    ], { prompt: answers(item.answers, questions), output: () => {} });

    assert.equal(questions.length, 6);
    assert.equal(questions.some((question) => /delivery mode/iu.test(question)), false);
    const installation = JSON.parse(
      await readFile(path.join(target, ".ai-sdlc/installation.json"), "utf8"),
    );
    assert.deepEqual(installation.roles, item.roles);
    assert.equal(installation.deliveryMode, "formal");
  }
});

test("AC-01 init accepts only canonical delivery modes and validates them before writing", async () => {
  for (const deliveryMode of ["formal", "rapid"]) {
    const target = await temporaryDirectory();
    const output = [];

    assert.equal(await run([
      "init",
      target,
      "--name",
      "Mode Project",
      "--summary",
      "Exercises a delivery mode",
      "--tool",
      "claude",
      "--roles",
      "tester",
      "--delivery-mode",
      deliveryMode,
    ], { output: (value) => output.push(value) }), 0);

    const installation = JSON.parse(
      await readFile(path.join(target, ".ai-sdlc/installation.json"), "utf8"),
    );
    const profile = await readFile(path.join(target, ".ai-sdlc/project-profile.md"), "utf8");
    assert.equal(installation.deliveryMode, deliveryMode);
    assert.match(profile, new RegExp(`\\| Delivery mode \\| ${deliveryMode} \\|`, "iu"));
    assert.match(output.join(""), new RegExp(`Delivery mode: ${deliveryMode}`, "iu"));
  }

  for (const modeArgs of [
    ["--delivery-mode", "fast"],
    ["--delivery-mode", "1"],
    ["--delivery-mode"],
  ]) {
    const target = await temporaryDirectory();
    const sentinel = path.join(target, "keep.txt");
    await writeFile(sentinel, "Keep me.\n", "utf8");

    await assert.rejects(
      run([
        "init",
        target,
        "--name",
        "Invalid Mode",
        "--summary",
        "Must fail before writing",
        "--tool",
        "claude",
        "--roles",
        "all",
        ...modeArgs,
      ], { output: () => {} }),
      /--delivery-mode|delivery mode/iu,
    );

    assert.deepEqual(await readdir(target), ["keep.txt"]);
    assert.equal(await readFile(sentinel, "utf8"), "Keep me.\n");
  }
});

test("AC-03 rapid mode keeps phase order, role selection, and AI-tool isolation unchanged", async () => {
  const target = await initializedProject("codex", {
    roles: "all",
    deliveryMode: "rapid",
  });
  const workflow = await readFile(path.join(target, ".ai-sdlc/workflow.md"), "utf8");
  const phaseLines = workflow
    .split("\n")
    .filter((line) => /^\| (Discovery|Design|Architecture|Implementation|Verification|Release) \|/u.test(line));

  assert.deepEqual(
    phaseLines.map((line) => line.split("|")[1].trim()),
    ["Discovery", "Design", "Architecture", "Implementation", "Verification", "Release"],
  );
  assert.deepEqual(
    (await readdir(path.join(target, ".codex/agents"))).sort(),
    roleIds.map((roleId) => `${roleId}.toml`).sort(),
  );
  assert.equal(existsSync(path.join(target, ".github")), false);
  assert.equal(existsSync(path.join(target, ".claude")), false);

  for (const roleId of ["pm-ba", "designer", "architect"]) {
    const role = await readCodexInstructions(path.join(target, ".codex/agents", `${roleId}.toml`));
    assert.match(role, /delivery mode/iu, roleId);
    assert.ok(headings(role).some((heading) => /rapid/iu.test(heading)), roleId);
  }
  for (const roleId of ["software-engineer", "tester", "devops"]) {
    const role = await readCodexInstructions(path.join(target, ".codex/agents", `${roleId}.toml`));
    assert.equal(
      headings(role).some((heading) => /(?:formal|rapid).*delivery|delivery.*(?:formal|rapid)/iu.test(heading)),
      false,
      roleId,
    );
  }
});

test("project text is inserted once and kept literal", async () => {
  const target = await temporaryDirectory();
  await run([
    "init",
    target,
    "--name",
    "Name {{PROJECT_SUMMARY}}",
    "--summary",
    "Goal {{PROJECT_NAME}}",
    "--tool",
    "claude",
    ...allRolesArgs,
  ], { output: () => {} });

  const instructions = await readFile(path.join(target, "CLAUDE.md"), "utf8");
  assert.match(instructions, /\*\*Project:\*\* Name \{\{PROJECT_SUMMARY\}\}/u);
  assert.match(instructions, /\*\*Goal:\*\* Goal \{\{PROJECT_NAME\}\}/u);
});

test("shared workflow keeps the six phases and the full template set", async () => {
  const target = await initializedProject("claude");
  const templates = (await readdir(path.join(target, ".ai-sdlc/templates"))).sort();

  assert.deepEqual(templates, [...templateFiles].sort());
  assert.equal(existsSync(path.join(target, ".ai-sdlc/workflow.md")), true);

  const workflow = await readFile(path.join(target, ".ai-sdlc/workflow.md"), "utf8");
  const phaseLines = workflow
    .split("\n")
    .filter((line) => /^\| (Discovery|Design|Architecture|Implementation|Verification|Release) \|/u.test(line));
  assert.deepEqual(
    phaseLines.map((line) => line.split("|")[1].trim()),
    ["Discovery", "Design", "Architecture", "Implementation", "Verification", "Release"],
  );
  assert.match(workflow, /stable order and ownership vocabulary/u);
  assert.match(workflow, /subset may be sparse/u);
  assert.match(workflow, /Read `\.ai-sdlc\/project-profile\.md` before starting/u);
  assert.match(workflow, /use `\.ai-sdlc\/artifact-hosts\.json` with the `sdlc-artifact-bridge` skill/u);
  assert.match(workflow, /Architecture Pack files/u);
  assert.match(workflow, /optional plan, tasks, and notes/u);
  assert.match(workflow, /Do not initialize, simulate, or create filler work for a missing role/u);
  assert.match(workflow, /Do not block a selected later role merely because an earlier role is not local/u);
  assert.match(workflow, /route host is null or inaccessible/u);
  assert.match(workflow, /structured question UI/u);
  assert.match(workflow, /two or three mutually exclusive options/u);
  assert.match(workflow, /recommended option first/u);
  assert.match(workflow, /Continue dependent work only after the answer/u);
  assert.match(workflow, /Do not defer an unresolved decision/u);
});

test("AC-08 shared rapid rules define actionable Risk and Blocker markers without weakening safeguards", async () => {
  const target = await initializedProject("claude", { deliveryMode: "rapid" });
  const workflow = await readFile(path.join(target, ".ai-sdlc/workflow.md"), "utf8");
  const rapid = guidanceAround(workflow, "rapid", 6000);

  assert.match(rapid, /Risk:/u);
  assert.match(rapid, /Blocker:/u);
  assert.match(rapid, /risk[\s\S]{0,300}impact/iu);
  assert.match(rapid, /risk[\s\S]{0,500}(?:evidence|basis|unknown)/iu);
  assert.match(rapid, /blocker[\s\S]{0,400}(?:blocked work|work (?:is )?blocked|what .*blocks?)/iu);
  assert.match(rapid, /blocker[\s\S]{0,500}(?:decision|input)/iu);
  assert.match(rapid, /pause only[\s\S]{0,120}(?:affected|blocked)/iu);
  assert.match(workflow, /cannot be read[\s\S]{0,100}supported JSON object/iu);
  assert.match(workflow, /Never fall back to the project profile/iu);

  for (const safeguard of [
    /safety/iu,
    /privacy/iu,
    /compliance/iu,
    /data loss/iu,
    /shared contract/iu,
    /migration/iu,
    /(?:hard|difficult|expensive)[ -]to[ -]reverse|irreversible/iu,
  ]) {
    assert.match(rapid, safeguard);
  }
  assert.match(
    rapid,
    /(?:do not|must not|never)[\s\S]{0,500}(?:skip|bypass)|(?:cannot|must not)[\s\S]{0,300}(?:because|for)[\s\S]{0,100}(?:rapid|speed)/iu,
  );
});

test("artifact index lists only real, openable artifacts", async () => {
  const target = await initializedProject("claude");
  const index = await readFile(path.join(target, "docs/ai-sdlc/index.md"), "utf8");

  assert.match(index, /single entry point/u);
  assert.match(index, /Only list artifacts that exist and can be opened/u);
  assert.match(index, /\| Artifact \| Description \|/u);
  assert.doesNotMatch(index, /\[.+\]\(.+\)/u);

  const workflow = await readFile(path.join(target, ".ai-sdlc/workflow.md"), "utf8");
  assert.match(workflow, /create, update, move, or delete/u);
  assert.match(workflow, /link relative to the index, such as `\.\/prd\.md`/u);
  assert.match(workflow, /cite their canonical source in the consuming document/u);
  assert.match(workflow, /one plain-English description/u);
  assert.match(workflow, /remove stale rows/u);
});

test("PM and BA templates retain PRD and user story detail", async () => {
  const target = await initializedProject("claude");
  const pm = await readFile(path.join(target, ".claude/agents/pm-ba.md"), "utf8");
  const prd = await readFile(path.join(target, ".ai-sdlc/templates/prd.md"), "utf8");
  const story = await readFile(path.join(target, ".ai-sdlc/templates/story.md"), "utf8");

  assert.match(pm, /plain, concrete, reviewable requirements/u);
  assert.match(pm, /docs\/ai-sdlc\/stories/u);
  assert.match(pm, /real situation in plain, everyday language/u);
  assert.match(pm, /what happens now, why it matters, what should happen instead/u);
  assert.match(pm, /avoid slogans, invented jargon, or abstract labels/u);
  assert.match(pm, /one user task needs more detail than the PRD/u);
  assert.match(pm, /Give every story and acceptance criterion an ID that does not change/u);
  assert.match(pm, /what someone can see afterward/u);
  assert.deepEqual(
    headings(prd),
    [
      "PRD: <Feature or product area>",
      "Problem and context",
      "Target users",
      "Goals and success measures",
      "Scope",
      "In scope",
      "Out of scope",
      "Business rules",
      "Acceptance criteria",
      "User story index",
      "Assumptions",
      "Decision record",
    ],
  );
  assert.match(story, /As a <user>, I want <capability>/u);
  assert.match(story, /<US-ID>-AC-01/u);
  assert.match(story, /```gherkin/u);
  assert.match(story, /Alternate and failure paths/u);
  assert.match(story, /## Decision record/u);
});

test("AC-04 formal guidance preserves established role depth and treats a missing mode as formal", async () => {
  const target = await initializedProject("claude", {
    roles: "pm-ba,designer,architect",
    deliveryMode: "formal",
  });
  const roles = {
    "pm-ba": [/PRD/u, /stor(?:y|ies)/iu, /acceptance criter/iu],
    designer: [/design baseline/iu, /design spec/iu, /Figma/u],
    architect: [/Architecture Pack/u, /C4/u, /ADR/u, /NFR/u, /risk review/iu],
  };

  const workflow = await readFile(path.join(target, ".ai-sdlc/workflow.md"), "utf8");
  assert.match(
    workflow,
    /installation record or field is missing[\s\S]{0,80}`formal`/iu,
  );
  assert.match(workflow, /`deliveryMode` field[\s\S]{0,100}authoritative/iu);
  assert.match(
    workflow,
    /`formal` keeps the structured, reviewable approach in the role instructions/iu,
  );

  for (const [roleId, retainedConcepts] of Object.entries(roles)) {
    const role = await readFile(path.join(target, ".claude/agents", `${roleId}.md`), "utf8");
    for (const concept of retainedConcepts) assert.match(role, concept, roleId);
  }
});

test("AC-05 rapid PM and BA guidance favors a minimal evidenced increment and observable acceptance", async () => {
  const target = await initializedProject("claude", {
    roles: "pm-ba",
    deliveryMode: "rapid",
  });
  const role = await readFile(path.join(target, ".claude/agents/pm-ba.md"), "utf8");
  const rapid = guidanceAround(role, "rapid");

  assert.match(rapid, /smallest|minimum/iu);
  assert.match(rapid, /deliverable|valuable|usable/iu);
  assert.match(rapid, /increment|slice|change/iu);
  assert.match(rapid, /business rule/iu);
  assert.match(rapid, /necessary|required|needed/iu);
  assert.match(rapid, /acceptance criter/iu);
  assert.match(rapid, /observable|visible|checkable|can be checked/iu);
  assert.match(rapid, /without evidence|unsupported|no evidence/iu);
  assert.match(rapid, /ceremon|filler|ritual/iu);
  assert.match(rapid, /do not|avoid/iu);
});

test("AC-06 rapid Designer guidance stays on the affected slice while retaining essential UX states", async () => {
  const target = await initializedProject("claude", {
    roles: "designer",
    deliveryMode: "rapid",
  });
  const role = await readFile(path.join(target, ".claude/agents/designer.md"), "utf8");
  const rapid = guidanceAround(role, "rapid", 4500);

  assert.match(rapid, /affected/iu);
  assert.match(rapid, /slice/iu);
  assert.match(rapid, /(?:real|necessary|required|actually occur)[\s\S]{0,100}states?|states?[\s\S]{0,100}(?:real|necessary|required|actually occur)/iu);
  assert.match(rapid, /reuse[\s\S]{0,120}existing[\s\S]{0,120}pattern/iu);
  assert.match(rapid, /do not|avoid|not by default|unless (?:needed|required|requested)/iu);
  assert.match(rapid, /design system/iu);
  assert.match(rapid, /design baseline/iu);
  assert.match(rapid, /Figma/u);
  assert.match(rapid, /high[ -]fidelity/iu);
  assert.match(rapid, /responsive/iu);
  assert.match(rapid, /accessib/iu);
  assert.match(rapid, /(?:key|critical|required|necessary)[\s\S]{0,80}(?:failure|error) states?|(?:failure|error) states?[\s\S]{0,80}(?:key|critical|required|necessary)/iu);
});

test("AC-07 rapid Architect guidance preserves boundaries and creates only triggered minimum evidence", async () => {
  const target = await initializedProject("claude", {
    roles: "architect",
    deliveryMode: "rapid",
  });
  const role = await readFile(path.join(target, ".claude/agents/architect.md"), "utf8");
  const profile = await readFile(path.join(target, ".ai-sdlc/project-profile.md"), "utf8");
  const planning = await readFile(path.join(target, ".ai-sdlc/technology-planning.md"), "utf8");
  const rapid = guidanceAround(role, "rapid", 5000);

  assert.match(rapid, /(?:keep|preserve|stay within)[\s\S]{0,160}(?:existing|current)[\s\S]{0,160}(?:technology|technical|architecture)[\s\S]{0,100}boundar/iu);
  assert.match(rapid, /future[\s\S]{0,160}(?:assumption|hypothetical|possible need)|(?:assumption|hypothetical)[\s\S]{0,160}future/iu);
  for (const unnecessaryAddition of [
    /service/iu,
    /layer/iu,
    /framework/iu,
    /vendor/iu,
    /abstraction/iu,
  ]) {
    assert.match(rapid, unnecessaryAddition);
  }
  assert.match(rapid, /do not|avoid|must not/iu);
  for (const conditionalArtifact of [
    /C4/u,
    /ADR/u,
    /options/iu,
    /NFR/u,
    /risk review/iu,
  ]) {
    assert.match(rapid, conditionalArtifact);
  }
  assert.match(rapid, /trigger|only when|when .*require|real need/iu);
  assert.match(rapid, /minimum|smallest|minimal/iu);
  assert.match(role, /any later task that needs a material technology choice/iu);
  assert.match(profile, /delivery-mode entry rules/iu);
  assert.match(planning, /missing profile alone is not a reason to create one/iu);
});

test("human decisions are asked immediately and artifacts record resolved choices", async () => {
  const target = await initializedProject("claude");
  const workflow = await readFile(path.join(target, ".ai-sdlc/workflow.md"), "utf8");
  const readme = await readFile(path.join(repositoryRoot, "README.md"), "utf8");

  assert.match(workflow, /pause at that point/u);
  assert.match(workflow, /impact or trade-off in one sentence/u);
  assert.match(workflow, /selected decision and its source/u);
  assert.match(readme, /agent asks immediately with two or three clear options/u);

  const deferredDecision = /open decisions?|open questions?|decision still needed|open target decisions|needs decision|decision needed/iu;
  for (const file of templateFiles.filter((name) => name !== "technology-profile.md")) {
    const content = await readFile(path.join(target, ".ai-sdlc/templates", file), "utf8");
    assert.doesNotMatch(content, deferredDecision, file);
  }

  for (const file of [
    "prd.md",
    "story.md",
    "design-spec.md",
    "architecture.md",
    "implementation-plan.md",
    "release-runbook.md",
  ]) {
    const content = await readFile(path.join(target, ".ai-sdlc/templates", file), "utf8");
    assert.match(content, /Decision record|decision record/u, file);
  }
  const options = await readFile(
    path.join(target, ".ai-sdlc/templates/architecture-options.md"),
    "utf8",
  );
  assert.match(options, /## Selected decision/u);
});

test("Designer stays technology-neutral when no technology profile exists", async () => {
  const target = await initializedProject("copilot");
  const designer = await readFile(
    path.join(target, ".github/agents/designer.agent.md"),
    "utf8",
  );
  const baseline = await readFile(
    path.join(target, ".ai-sdlc/templates/design-baseline.md"),
    "utf8",
  );
  const spec = await readFile(
    path.join(target, ".ai-sdlc/templates/design-spec.md"),
    "utf8",
  );
  const profile = await readFile(path.join(target, ".ai-sdlc/project-profile.md"), "utf8");

  assert.match(designer, /approved visual references, verified source behavior/u);
  assert.match(designer, /Read `\.ai-sdlc\/project-profile\.md`/u);
  assert.match(designer, /use `\.ai-sdlc\/artifact-hosts\.json` with the `sdlc-artifact-bridge` skill/u);
  assert.match(designer, /Work independently when PM \/ BA or Architect agents are not initialized/u);
  assert.match(designer, /If none exists, remain technology-neutral/u);
  assert.match(designer, /user journey, information hierarchy, primary action/u);
  assert.match(designer, /For visual work, render the affected viewport/u);
  assert.match(designer, /approved reference or adjacent product surfaces/u);
  assert.match(designer, /iterate on observed differences/u);
  assert.match(designer, /Use Figma only when the user requests it/u);
  assert.match(designer, /Confirm the target file, page, screens, states, viewports/u);
  assert.match(designer, /Use auto-layout/u);
  assert.match(designer, /Figma URL or node ID only after/u);
  assert.match(designer, /pixel-perfect fidelity/u);
  assert.doesNotMatch(designer, /shadcn\/ui|Ant Design|Material UI/u);
  assert.doesNotMatch(designer, /\bVDS\b|vds-query|component-query|validate-spec/iu);
  assert.match(profile, /Initialization does not choose a stack or validation depth/u);
  assert.match(baseline, /Human-curated notes/u);
  assert.match(spec, /Experience and information hierarchy/u);
  assert.match(spec, /Responsive behavior/u);
  assert.match(spec, /Accessibility and content/u);
  assert.match(spec, /Visual evidence/u);
  assert.doesNotMatch(spec, /spec_version|deferred_validations|validator/iu);
});

test("Designer keeps delivery uncertainty out of the UI and uses realistic mock content", async () => {
  const target = await initializedProject("copilot");
  const designer = await readFile(
    path.join(target, ".github/agents/designer.agent.md"),
    "utf8",
  );
  const spec = await readFile(
    path.join(target, ".ai-sdlc/templates/design-spec.md"),
    "utf8",
  );

  assert.match(designer, /Keep PRD or story dependencies, assumptions, and pending confirmations separate from product UI content, states, and layout/u);
  assert.match(designer, /best-supported reversible assumptions that do not require human authority/u);
  assert.match(designer, /review-only `!` marker/u);
  assert.match(designer, /separate annotation layer and outside the product layout/u);
  assert.match(designer, /Removing that layer must leave the UI's dimensions, spacing, hierarchy, copy, interaction, states, accessibility, and implementation unchanged/u);
  assert.match(designer, /plain, representative mock content that fits the confirmed business scenario/u);
  assert.match(designer, /everyday language used by the target users/u);
  assert.match(designer, /names, dates, amounts, statuses, labels, and messages believable and consistent/u);
  assert.match(designer, /Avoid real personal or production data, lorem ipsum, vague placeholders, slogans, and invented jargon/u);
  assert.match(designer, /identify them as draft or mock in the design spec, not inside the UI/u);
  assert.match(designer, /never present them as approved requirements or final content/u);
  assert.match(designer, /review annotation only when the current design does not depend on a human decision/u);
  assert.match(designer, /If finalizing any affected UI requires a human decision, ask immediately/u);
  assert.match(designer, /pause only that part, and continue unaffected design work/u);
  assert.match(spec, /## UI content/u);
  assert.match(spec, /## Review-only annotations/u);
  assert.match(spec, /do not block the current design or require a human decision to complete it/u);
  assert.match(spec, /review notes, not UI or implementation requirements/u);
  assert.match(spec, /does not make the design `Blocked`/u);
  assert.match(spec, /Ask about a required decision immediately and record its resolution in the decision record instead of this table/u);
  assert.match(spec, /Screen and UI anchor/u);
  assert.match(spec, /Plain-language note/u);
  assert.match(spec, /## Reversible design assumptions/u);
  assert.match(spec, /evidence-based, reversible, and do not require human authority/u);
  assert.doesNotMatch(spec, /Assumption or blocker/u);
});

test("Architect initializes technology planning on first use without other roles", async () => {
  const target = await initializedProject("codex", { roles: "architect" });
  const architect = await readCodexInstructions(
    path.join(target, ".codex/agents/architect.toml"),
  );
  const planning = await readFile(path.join(target, ".ai-sdlc/technology-planning.md"), "utf8");
  const profileTemplate = await readFile(
    path.join(target, ".ai-sdlc/templates/technology-profile.md"),
    "utf8",
  );

  assert.deepEqual(await readdir(path.join(target, ".codex/agents")), ["architect.toml"]);
  assert.match(architect, /first Architecture task/u);
  assert.match(architect, /look for `docs\/ai-sdlc\/technology-profile\.md` locally and through the configured Architecture route/u);
  assert.match(architect, /`Proposed` or `Confirmed` status/u);
  assert.match(architect, /A `Superseded` profile is not usable/u);
  assert.match(architect, /inspect evidence, ask whether to preserve verified current technology/u);
  assert.match(architect, /then ask only applicable material choices/u);
  assert.match(architect, /create the profile from its template/u);
  assert.match(architect, /Work independently when PM \/ BA, Designer, Software Engineer, Tester, or DevOps agents are not initialized/u);
  assert.match(architect, /Do not install dependencies, scaffold an application/u);

  assert.match(planning, /Search the local artifact index, the Architecture route/u);
  assert.match(planning, /Ask the user only about material choices that cannot be resolved from evidence/u);
  assert.match(planning, /one decision at a time with two or three viable options/u);
  assert.match(planning, /Add the profile to `docs\/ai-sdlc\/index\.md`/u);
  assert.match(planning, /without Software Engineer, Tester, or DevOps agents being present/u);
  for (const area of [
    "Frontend and interaction",
    "Services and APIs",
    "Data and storage",
    "Integrations and messaging",
    "Runtime and deployment",
    "Security and privacy",
    "Observability and operations",
    "Validation and quality",
  ]) {
    assert.match(profileTemplate, new RegExp(escapeRegex(area), "u"), area);
  }
});

test("Architecture Pack keeps C4, ADR, concerns, and required API patterns", async () => {
  const target = await initializedProject("codex");
  const templateRoot = path.join(target, ".ai-sdlc/templates");
  const architect = await readCodexInstructions(
    path.join(target, ".codex/agents/architect.toml"),
  );
  const overview = await readFile(path.join(templateRoot, "architecture.md"), "utf8");
  const patterns = await readFile(
    path.join(templateRoot, "architecture-patterns.md"),
    "utf8",
  );
  const adr = await readFile(path.join(templateRoot, "architecture-adr.md"), "utf8");
  const context = await readFile(
    path.join(templateRoot, "architecture-c4-context.mmd"),
    "utf8",
  );
  const containers = await readFile(
    path.join(templateRoot, "architecture-c4-containers.mmd"),
    "utf8",
  );

  for (const concern of ["API", "Data", "Integration", "Security", "Observability", "Frontend"]) {
    assert.match(architect, new RegExp(`\\b${concern}\\b`, "u"));
    assert.match(overview, new RegExp(`^\\| ${concern} \\|`, "mu"));
  }
  assert.match(architect, /C4 system context view/u);
  assert.match(architect, /C4 container view/u);
  assert.match(architect, /project provides a Mermaid renderer or checker/u);
  assert.match(architect, /check was not run/u);
  assert.match(architect, /docs\/ai-sdlc\/adrs/u);
  assert.match(architect, /required project baseline/u);
  assert.match(architect, /Keep the system structure and technical decisions consistent/u);
  assert.match(architect, /Write every architecture document in plain language/u);
  assert.match(architect, /what exists now, what needs to change/u);
  assert.match(architect, /explain what they mean for this project instead of using the label as the explanation/u);
  assert.match(architect, /who uses the system and which outside systems it talks to/u);
  assert.match(architect, /targets that can be checked and how to check them/u);
  assert.match(architect, /real alternatives to compare/u);

  assert.match(patterns, /RESTful contract/u);
  assert.match(patterns, /HTTP status codes are the authoritative transport outcome/u);
  assert.match(patterns, /do not return `200` for a failed request/u);
  assert.match(patterns, /JSON envelope family/u);
  assert.match(patterns, /cursor or offset pagination/u);
  assert.match(patterns, /opaque cursor with a stable unique order/u);
  assert.match(patterns, /authoritative OpenAPI YAML contract/u);
  assert.match(patterns, /same change as the API behavior/u);
  assert.match(patterns, /OpenAPI lint or contract check/u);

  assert.match(adr, /## Context/u);
  assert.match(adr, /## Decision/u);
  assert.match(adr, /## Options considered/u);
  assert.match(adr, /## Consequences/u);
  assert.match(adr, /## Rules for future work/u);
  assert.match(adr, /\*\*Decision owner:\*\*/u);
  assert.match(adr, /\*\*Decision evidence:\*\*/u);
  assert.match(context, /^C4Context/mu);
  assert.match(context, /C4 L1/u);
  assert.match(containers, /^C4Container/mu);
  assert.match(containers, /C4 L2/u);

  const architectureFiles = await Promise.all(
    templateFiles
      .filter((file) => file.startsWith("architecture"))
      .map((file) => readFile(path.join(templateRoot, file), "utf8")),
  );
  for (const file of architectureFiles) {
    assert.doesNotMatch(
      file,
      /architecture-rulebook|architecture-selection|catalogDigest|reviewId|optionsArtifactId|selectedAt|selection review UUID|minimum_findings|machine-readable/iu,
    );
  }
});

test("Software Engineer can use plan, tasks, and implementation notes without extra evidence packs", async () => {
  const target = await initializedProject("copilot");
  const engineer = await readFile(
    path.join(target, ".github/agents/software-engineer.agent.md"),
    "utf8",
  );
  const plan = await readFile(
    path.join(target, ".ai-sdlc/templates/implementation-plan.md"),
    "utf8",
  );
  const tasks = await readFile(
    path.join(target, ".ai-sdlc/templates/implementation-tasks.md"),
    "utf8",
  );
  const notes = await readFile(
    path.join(target, ".ai-sdlc/templates/implementation-notes.md"),
    "utf8",
  );

  assert.match(engineer, /implementation-plan\.md/u);
  assert.match(engineer, /implementation-tasks\.md/u);
  assert.match(engineer, /smallest complete vertical slice/u);
  assert.match(engineer, /Use the technology profile and accepted ADRs when they exist/u);
  assert.match(engineer, /Choose check depth from confirmed quality requirements/u);
  assert.match(engineer, /commands confirmed by project files or instructions/u);
  assert.match(engineer, /Do not scaffold an application/u);
  assert.match(plan, /Repository change map/u);
  assert.match(plan, /Acceptance and verification plan/u);
  assert.match(tasks, /Repository and path/u);
  assert.match(tasks, /Evidence or blocker/u);
  assert.deepEqual(
    headings(notes),
    [
      "Implementation Notes",
      "Status",
      "Scope",
      "Changes",
      "Decisions used",
      "Checks",
      "Limits and risks",
      "Verification notes",
    ],
  );
  for (const absent of [
    "engineering-session-log.md",
    "engineering-test-evidence.md",
    "engineering-review.md",
    "engineering-provenance.md",
  ]) {
    assert.equal(existsSync(path.join(target, ".ai-sdlc/templates", absent)), false);
  }
});

test("every role knows how to resolve artifacts without auto-initializing dependencies", async () => {
  const target = await initializedProject("claude");
  for (const roleId of roleIds) {
    const content = await readFile(path.join(target, ".claude/agents", `${roleId}.md`), "utf8");
    assert.match(content, /\.ai-sdlc\/artifact-hosts\.json/u, roleId);
    assert.match(content, /sdlc-artifact-bridge/u, roleId);
  }

  const workflow = await readFile(path.join(target, ".ai-sdlc/workflow.md"), "utf8");
  assert.match(workflow, /A role not initialized here may be performed elsewhere or may be unnecessary/u);
  assert.match(workflow, /Do not initialize, simulate, or create filler work for a missing role/u);
});

test("init stops before writing when a destination exists", async () => {
  const target = await temporaryDirectory();
  const existing = path.join(target, "CLAUDE.md");
  await writeFile(existing, "Keep this file.\n", "utf8");

  await assert.rejects(
    run([
      "init",
      target,
      "--name",
      "Conflict",
      "--summary",
      "Must not overwrite",
      "--tool",
      "claude",
      ...allRolesArgs,
    ], { output: () => {} }),
    /CLAUDE\.md/u,
  );

  assert.equal(await readFile(existing, "utf8"), "Keep this file.\n");
  assert.equal(existsSync(path.join(target, ".ai-sdlc")), false);
  assert.equal(existsSync(path.join(target, ".claude")), false);
});

test("init preserves an existing artifact index and stops before writing", async () => {
  const target = await temporaryDirectory();
  const indexDirectory = path.join(target, "docs/ai-sdlc");
  const index = path.join(indexDirectory, "index.md");
  await mkdir(indexDirectory, { recursive: true });
  await writeFile(index, "# Existing index\n", "utf8");

  await assert.rejects(
    run([
      "init",
      target,
      "--name",
      "Existing Index",
      "--summary",
      "Must keep the current artifact list",
      "--tool",
      "codex",
      ...allRolesArgs,
    ], { output: () => {} }),
    /docs\/ai-sdlc\/index\.md/u,
  );

  assert.equal(await readFile(index, "utf8"), "# Existing index\n");
  assert.equal(existsSync(path.join(target, "AGENTS.md")), false);
  assert.equal(existsSync(path.join(target, ".ai-sdlc")), false);
  assert.equal(existsSync(path.join(target, ".codex")), false);
});

test("init preserves an existing project profile and stops before writing", async () => {
  const target = await temporaryDirectory();
  const profileDirectory = path.join(target, ".ai-sdlc");
  const profile = path.join(profileDirectory, "project-profile.md");
  await mkdir(profileDirectory, { recursive: true });
  await writeFile(profile, "# Existing profile\n", "utf8");

  await assert.rejects(
    run([
      "init",
      target,
      "--name",
      "Existing Profile",
      "--summary",
      "Must keep initialization choices",
      "--tool",
      "claude",
      ...allRolesArgs,
    ], { output: () => {} }),
    /\.ai-sdlc\/project-profile\.md/u,
  );

  assert.equal(await readFile(profile, "utf8"), "# Existing profile\n");
  assert.equal(existsSync(path.join(target, "CLAUDE.md")), false);
  assert.equal(existsSync(path.join(target, ".mcp.json")), false);
});

test("init preserves an existing artifact registry and stops before writing", async () => {
  const target = await temporaryDirectory();
  const registry = path.join(target, ".ai-sdlc/artifact-hosts.json");
  await mkdir(path.dirname(registry), { recursive: true });
  await writeFile(registry, '{"keep":true}\n', "utf8");

  await assert.rejects(
    run([
      "init",
      target,
      "--name",
      "Existing Registry",
      "--summary",
      "Must keep artifact routes",
      "--tool",
      "claude",
      ...allRolesArgs,
    ], { output: () => {} }),
    /\.ai-sdlc\/artifact-hosts\.json/u,
  );

  assert.equal(await readFile(registry, "utf8"), '{"keep":true}\n');
  assert.equal(existsSync(path.join(target, "CLAUDE.md")), false);
  assert.equal(existsSync(path.join(target, ".claude")), false);
});

test("init leaves unrelated MCP configuration untouched and creates none", async () => {
  const target = await temporaryDirectory();
  const existing = path.join(target, ".mcp.json");
  await writeFile(existing, '{"keep":true}\n', "utf8");

  await run([
    "init",
    target,
    "--name",
    "Unrelated Configuration",
    "--summary",
    "Initializes roles without tool servers",
    "--tool",
    "claude",
    "--roles",
    "architect",
  ], { output: () => {} });

  assert.equal(await readFile(existing, "utf8"), '{"keep":true}\n');
  assert.equal(existsSync(path.join(target, "CLAUDE.md")), true);
  assert.equal(existsSync(path.join(target, ".vscode/mcp.json")), false);
  assert.equal(existsSync(path.join(target, ".codex/config.toml")), false);
});

test("init rejects a symbolic-link output parent", {
  skip: process.platform === "win32",
}, async () => {
  const target = await temporaryDirectory();
  const outside = await temporaryDirectory();
  await symlink(outside, path.join(target, ".github"));

  await assert.rejects(
    run([
      "init",
      target,
      "--name",
      "Safe Paths",
      "--summary",
      "Must stay in the target",
      "--tool",
      "copilot",
      ...allRolesArgs,
    ], { output: () => {} }),
    /\.github\//u,
  );

  assert.deepEqual(await readdir(outside), []);
  assert.equal(existsSync(path.join(target, ".ai-sdlc")), false);
});

test("init keeps the useful error for a file in the target path", async () => {
  const root = await temporaryDirectory();
  const file = path.join(root, "not-a-directory");
  await writeFile(file, "Keep this file.\n", "utf8");

  await assert.rejects(
    run([
      "init",
      path.join(file, "project"),
      "--name",
      "Bad Target",
      "--summary",
      "Must fail clearly",
      "--tool",
      "claude",
      ...allRolesArgs,
    ], { output: () => {} }),
    (error) => error?.code === "ENOTDIR" && !String(error.message).includes("rollback"),
  );
  assert.equal(await readFile(file, "utf8"), "Keep this file.\n");
});

test("init removes its earlier files when a later write fails", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, async () => {
  const target = await temporaryDirectory();
  const lockedDirectory = path.join(target, ".ai-sdlc");
  await mkdir(lockedDirectory);
  await chmod(lockedDirectory, 0o500);

  try {
    await assert.rejects(
      run([
        "init",
        target,
        "--name",
        "Rollback Test",
        "--summary",
        "A later directory cannot be written",
        "--tool",
        "claude",
        ...allRolesArgs,
      ], { output: () => {} }),
      /permission denied|EACCES/iu,
    );
    assert.equal(existsSync(path.join(target, "CLAUDE.md")), false);
    assert.equal(existsSync(path.join(target, ".mcp.json")), false);
    assert.deepEqual(await readdir(lockedDirectory), []);
  } finally {
    await chmod(lockedDirectory, 0o700);
  }
});

test("rollback removes an unchanged generated project profile", async () => {
  const target = await temporaryDirectory();

  await assert.rejects(
    run([
      "init",
      target,
      "--name",
      "Profile Rollback",
      "--summary",
      "Fails after the profile is written",
      "--tool",
      "claude",
      "--roles",
      "architect",
    ], {
      output: () => {},
      beforeWrite: ({ path: entryPath }) => {
        if (entryPath === ".ai-sdlc/workflow.md") throw new Error("Planned workflow failure");
      },
    }),
    /Planned workflow failure/u,
  );

  assert.equal(existsSync(path.join(target, "CLAUDE.md")), false);
  assert.equal(existsSync(path.join(target, ".ai-sdlc/project-profile.md")), false);
});

test("init preserves a file created by another process after the conflict check", async () => {
  const target = await temporaryDirectory();
  const racedFile = path.join(target, ".ai-sdlc/artifact-hosts.json");

  await assert.rejects(
    run([
      "init",
      target,
      "--name",
      "Write Race",
      "--summary",
      "Preserves a concurrently created file",
      "--tool",
      "claude",
      ...allRolesArgs,
    ], {
      output: () => {},
      beforeWrite: async ({ path: entryPath }) => {
        if (entryPath === ".ai-sdlc/artifact-hosts.json") {
          await mkdir(path.dirname(racedFile), { recursive: true });
          await writeFile(racedFile, "Created by another process.\n", "utf8");
        }
      },
    }),
    /EEXIST|file already exists/iu,
  );

  assert.equal(await readFile(racedFile, "utf8"), "Created by another process.\n");
  assert.equal(existsSync(path.join(target, "CLAUDE.md")), false);
});

test("rollback keeps a generated file that another process changed or replaced", async () => {
  const cases = [
    {
      expected: "Changed by another process.\n",
      message: /changed during rollback.*CLAUDE\.md/iu,
      update: async (file) => writeFile(file, "Changed by another process.\n", "utf8"),
    },
    {
      expected: null,
      message: /replaced during rollback.*CLAUDE\.md/iu,
      update: async (file) => {
        const content = await readFile(file, "utf8");
        await rename(file, `${file}.original`);
        await writeFile(file, content, "utf8");
        return content;
      },
    },
  ];

  for (const item of cases) {
    const target = await temporaryDirectory();
    const instructions = path.join(target, "CLAUDE.md");
    let expected = item.expected;

    await assert.rejects(
      run([
        "init",
        target,
        "--name",
        "Rollback Guard",
        "--summary",
        "Keep outside changes",
        "--tool",
        "claude",
        ...allRolesArgs,
      ], {
        output: () => {},
        beforeWrite: async ({ index }) => {
          if (index !== 1) return;
          expected = await item.update(instructions) ?? expected;
          throw new Error("Planned later failure");
        },
      }),
      (error) => error instanceof AggregateError
        && /Planned later failure/u.test(error.message)
        && item.message.test(error.message),
    );
    assert.equal(await readFile(instructions, "utf8"), expected);
  }
});

test("AC-09 init does not report success after authoritative metadata changes", async () => {
  const target = await temporaryDirectory();
  const installationPath = path.join(target, ".ai-sdlc/installation.json");

  await assert.rejects(
    run([
      "init",
      target,
      "--name",
      "Authority Race",
      "--summary",
      "Keeps mode output truthful",
      "--tool",
      "claude",
      "--roles",
      "architect",
      "--delivery-mode",
      "rapid",
    ], {
      output: () => {},
      beforeWrite: async ({ path: entryPath }) => {
        if (entryPath !== ".ai-sdlc/project-profile.md") return;
        const installation = JSON.parse(await readFile(installationPath, "utf8"));
        installation.deliveryMode = "formal";
        await writeFile(
          installationPath,
          `${JSON.stringify(installation, null, 2)}\n`,
          "utf8",
        );
      },
    }),
    (error) => error instanceof AggregateError
      && /changed before initialization completed/iu.test(error.message)
      && /changed during rollback/iu.test(error.message),
  );

  assert.equal(
    JSON.parse(await readFile(installationPath, "utf8")).deliveryMode,
    "formal",
  );
  assert.equal(existsSync(path.join(target, "CLAUDE.md")), false);
  assert.equal(existsSync(path.join(target, ".ai-sdlc/project-profile.md")), false);
});

test("AC-01 CLI help lists delivery mode and invalid options fail", async () => {
  const cliPath = path.join(repositoryRoot, "bin/cli.js");
  const helpResult = spawnSync(process.execPath, [cliPath, "--help"], {
    encoding: "utf8",
  });

  assert.equal(helpResult.status, 0, helpResult.stderr);
  assert.match(helpResult.stdout, /--tool <tool>/u);
  assert.match(helpResult.stdout, /--roles <list>/u);
  assert.match(helpResult.stdout, /--delivery-mode <mode>/u);
  assert.match(helpResult.stdout, /formal/u);
  assert.match(helpResult.stdout, /rapid/u);
  assert.doesNotMatch(helpResult.stdout, /--development|--stack|--validation/u);

  await assert.rejects(run(["init", ".", "--tool", "unknown"]), /Unknown AI tool/u);
  await assert.rejects(
    run(["init", ".", "--roles", "architect,wizard"]),
    /Unknown role: wizard/u,
  );
  await assert.rejects(
    run(["init", ".", "--roles", "architect,architecture"]),
    /Duplicate role: architect/u,
  );
  const completeBase = [
    "init",
    ".",
    "--name",
    "Argument Test",
    "--summary",
    "Checks conditional arguments",
    "--tool",
    "claude",
  ];
  await assert.rejects(run(completeBase, { output: () => {} }), /--roles is required/u);
  await assert.rejects(
    run([...completeBase, "--development", "frontend"], { output: () => {} }),
    /--development was removed.*--roles/u,
  );
  await assert.rejects(
    run([...completeBase, "--stack", "react-shadcn"], { output: () => {} }),
    /--stack was removed.*technology profile/u,
  );
  await assert.rejects(
    run([...completeBase, "--validation", "standard"], { output: () => {} }),
    /--validation was removed.*technology profile/u,
  );
  await assert.rejects(run(["serve"]), /Use: create-ai-native-sdlc init/u);
  await assert.rejects(run(["init", ".", "--client", "codex"]), /Unknown option/u);
  await assert.rejects(run(["init", ".", "--name", "   "]), /--name needs a value/u);
  await assert.rejects(run(["init", ".", "--roles"]), /--roles needs a value/u);
});

test("AC-10 README explains both delivery modes, their default and their scope", async () => {
  const readme = await readFile(path.join(repositoryRoot, "README.md"), "utf8");

  assert.match(readme, /## Generated files/u);
  assert.match(readme, /## Delivery workflow/u);
  assert.match(readme, /## Architecture Pack/u);
  assert.match(readme, /docs\/ai-sdlc\/index\.md/u);
  assert.match(readme, /\.ai-sdlc\/project-profile\.md/u);
  assert.match(readme, /--roles/u);
  assert.match(readme, /pm-ba,designer,architect/u);
  assert.match(readme, /all|`all`/u);
  assert.match(readme, /none|`none`/u);
  assert.match(readme, /\.ai-sdlc\/artifact-hosts\.json/u);
  assert.match(readme, /sdlc-artifact-bridge\//u);
  assert.match(readme, /\$sdlc-artifact-bridge \/docs\/ai-sdlc\/prd\.md/u);
  assert.match(readme, /\$sdlc-artifact-bridge product-repo:\/docs\/ai-sdlc\/prd\.md/u);
  assert.match(readme, /SKILL\.md/u);
  assert.match(readme, /technology profile/u);
  assert.match(readme, /create-ai-native-sdlc update \./u);
  assert.match(readme, /Project state is preserved/u);
  assert.match(readme, /\.ai-sdlc\/installation\.json/u);
  assert.match(readme, /installation\.json[\s\S]{0,100}authoritative/iu);
  assert.match(readme, /profile snapshot does not (?:change|switch)/iu);
  assert.match(readme, /supported legacy installation/u);
  assert.match(readme, /does not use MCP|No MCP|not (?:an )?MCP/iu);
  assert.match(readme, /--delivery-mode/u);
  assert.match(readme, /formal/iu);
  assert.match(readme, /rapid/iu);
  assert.match(readme, /default[\s\S]{0,100}formal|formal[\s\S]{0,100}default/iu);
  assert.match(readme, /PM \/ BA|PM\/BA/u);
  assert.match(readme, /Designer/u);
  assert.match(readme, /Architect/u);
  assert.match(readme, /(?:only|affects)[\s\S]{0,200}(?:PM \/ BA|PM\/BA)[\s\S]{0,200}Designer[\s\S]{0,200}Architect|(?:PM \/ BA|PM\/BA)[\s\S]{0,200}Designer[\s\S]{0,200}Architect[\s\S]{0,200}(?:only|affects)/iu);
  assert.match(readme, /safety/iu);
  assert.match(readme, /privacy/iu);
  assert.match(readme, /compliance/iu);
  assert.match(readme, /data loss/iu);
  assert.match(readme, /shared contract/iu);
  assert.match(readme, /migration/iu);
  assert.match(readme, /(?:hard|difficult|expensive)[ -]to[ -]reverse|irreversible/iu);
  assert.doesNotMatch(readme, /--development|--stack|--validation/u);
});

test("AC-11 delivery mode adds no dependencies or generated paths and keeps rollback create-only", async () => {
  const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  assert.deepEqual(packageJson.files, ["bin", "templates", "README.md", "LICENSE"]);
  assert.equal(Object.hasOwn(packageJson, "dependencies"), false);
  assert.equal(Object.hasOwn(packageJson, "devDependencies"), false);

  const expectedPaths = [
    ".agents/skills/sdlc-artifact-bridge/SKILL.md",
    ".ai-sdlc/artifact-hosts.json",
    ".ai-sdlc/installation.json",
    ".ai-sdlc/project-profile.md",
    ".ai-sdlc/technology-planning.md",
    ".ai-sdlc/workflow.md",
    ...templateFiles.map((file) => `.ai-sdlc/templates/${file}`),
    ...roleIds.map((roleId) => `.claude/agents/${roleId}.md`),
    "CLAUDE.md",
    "docs/ai-sdlc/index.md",
  ].sort();

  for (const deliveryMode of ["formal", "rapid"]) {
    const target = await initializedProject("claude", { deliveryMode });
    const relativePaths = (await listFiles(target))
      .map((file) => path.relative(target, file).split(path.sep).join("/"))
      .sort();
    assert.deepEqual(relativePaths, expectedPaths, deliveryMode);
  }

  const rollbackTarget = await temporaryDirectory();
  const sentinel = path.join(rollbackTarget, "keep.txt");
  await writeFile(sentinel, "Existing project file.\n", "utf8");
  await assert.rejects(
    run([
      "init",
      rollbackTarget,
      "--name",
      "Rapid Rollback",
      "--summary",
      "Fails after writes start",
      "--tool",
      "claude",
      "--roles",
      "all",
      "--delivery-mode",
      "rapid",
    ], {
      output: () => {},
      beforeWrite: ({ path: entryPath }) => {
        if (entryPath === ".ai-sdlc/workflow.md") throw new Error("Planned rapid failure");
      },
    }),
    /Planned rapid failure/u,
  );
  assert.deepEqual(await listFiles(rollbackTarget), [sentinel]);
  assert.equal(await readFile(sentinel, "utf8"), "Existing project file.\n");
});

test("npm package includes the CLI, templates, bridge skill, and no generated MCP config", async () => {
  const npmCache = await temporaryDirectory();
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: npmCache },
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout)[0];
  const files = report.files.map((item) => item.path);
  assert.ok(files.includes("bin/cli.js"));
  assert.ok(files.includes("templates/project-profile.md"));
  assert.ok(files.includes("templates/shared/.ai-sdlc/technology-planning.md"));
  assert.ok(files.includes("templates/shared/.agents/skills/sdlc-artifact-bridge/SKILL.md"));
  assert.equal(files.some((file) => /mcp\.json|config\.toml/u.test(file)), false);
});

test("generated files are plain English and do not contain old platform contracts", async () => {
  for (const tool of ["copilot", "claude", "codex"]) {
    const target = await initializedProject(tool);
    const files = await listFiles(target);
    assert.ok(files.length >= 30);

    for (const file of files) {
      const content = await readFile(file, "utf8");
      assert.doesNotMatch(content, /[\u3400-\u9fff]/u, file);
      assert.doesNotMatch(content, /\{\{[A-Z_]+\}\}/u, file);
      assert.doesNotMatch(
        content,
        /Run-scoped|semantic gate|architecture-rulebook|architecture-selection|catalogDigest|reviewId|optionsArtifactId|selectedAt|selection review UUID|minimum_findings|execution contract|change contract|seven-lens|Tier [ABC]|ai-native\.yaml/iu,
        file,
      );
    }
  }
});

async function initializedProject(tool, configuration = {}) {
  const target = await temporaryDirectory();
  const args = [
    "init",
    target,
    "--name",
    "Test Project",
    "--summary",
    "A small test project",
    "--tool",
    tool,
    "--roles",
    configuration.roles ?? "all",
  ];
  if (configuration.deliveryMode) {
    args.push("--delivery-mode", configuration.deliveryMode);
  }
  await run(args, { output: () => {} });
  return target;
}

async function readCodexInstructions(file) {
  const generated = await readFile(file, "utf8");
  const instructions = generated.match(/^developer_instructions = (.+)$/mu);
  assert.ok(instructions);
  return JSON.parse(instructions[1]);
}

function headings(markdown) {
  return [...markdown.matchAll(/^#{1,6}\s+(.+)$/gmu)].map((match) => match[1]);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function guidanceAround(markdown, mode, length = 3500) {
  const match = new RegExp(`\\b${escapeRegex(mode)}\\b`, "iu").exec(markdown);
  assert.ok(match, `Expected ${mode} delivery guidance`);
  return markdown.slice(match.index, match.index + length);
}

function answers(values, questions) {
  const queue = [...values];
  return async (question) => {
    questions.push(question);
    return queue.shift() ?? "";
  };
}

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-native-init-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function listFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...await listFiles(entryPath));
    } else if (entry.isFile()) {
      result.push(entryPath);
    }
  }
  return result.sort();
}
