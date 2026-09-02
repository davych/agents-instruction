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

test("all roles produce the profile, registry, and default bridge skill", async () => {
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
  assert.match(output.join(""), /Profile: \.ai-sdlc\/project-profile\.md/u);
  assert.match(output.join(""), /Artifact hosts: \.ai-sdlc\/artifact-hosts\.json/u);
  assert.match(output.join(""), /Artifact bridge: \.agents\/skills\/sdlc-artifact-bridge\/SKILL\.md/u);
  assert.match(output.join(""), /Selected roles: pm-ba, designer, architect, software-engineer, tester, devops/u);

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
  assert.match(profile, /\| Local role agents \| pm-ba, designer, architect, software-engineer, tester, devops \|/u);
  assert.match(profile, /\| Active local phases \| Discovery, Design, Architecture, Implementation, Verification, Release \|/u);
  assert.match(profile, /\| Technology profile \| `docs\/ai-sdlc\/technology-profile\.md` when first created by the Architect \|/u);
  assert.match(profile, /\| Artifact host registry \| `\.ai-sdlc\/artifact-hosts\.json` \|/u);
  assert.match(profile, /\| Artifact bridge skill \| `\.agents\/skills\/sdlc-artifact-bridge\/SKILL\.md` \|/u);
  assert.doesNotMatch(profile, /\| (?:Development work|Development area|Stack preference|UI system|UI MCP|Validation preference) \|/u);

  assert.equal(existsSync(path.join(target, ".ai-sdlc/artifact-hosts.json")), true);
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

test("interactive init asks six independent role questions and no stack questionnaire", async () => {
  const target = await temporaryDirectory();
  const questions = [];
  const output = [];
  const prompt = answers(["1", "2", "1", "2", "1", "2"], questions);

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

  assert.equal(questions.length, 6);
  assert.deepEqual(
    questions.map((question) => question.match(/^Initialize the (.+?) role/mu)?.[1]),
    ["PM / BA", "Designer", "Architect", "Software Engineer", "Tester", "DevOps"],
  );
  assert.equal(
    questions.some((question) => /development|stack|validation/iu.test(question)),
    false,
  );
  assert.deepEqual(
    (await readdir(path.join(target, ".claude/agents"))).sort(),
    ["architect.md", "pm-ba.md", "tester.md"],
  );
  assert.match(output.join(""), /Selected roles: pm-ba, architect, tester/u);
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

  assert.match(pm, /docs\/ai-sdlc\/stories/u);
  assert.match(pm, /stable story and acceptance-criteria IDs/u);
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

test("CLI help is short and invalid options fail", async () => {
  const cliPath = path.join(repositoryRoot, "bin/cli.js");
  const helpResult = spawnSync(process.execPath, [cliPath, "--help"], {
    encoding: "utf8",
  });

  assert.equal(helpResult.status, 0, helpResult.stderr);
  assert.match(helpResult.stdout, /--tool <tool>/u);
  assert.match(helpResult.stdout, /--roles <list>/u);
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

test("README describes role selection, artifact routing, and Architect technology planning", async () => {
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
  assert.match(readme, /does not use MCP|No MCP|not (?:an )?MCP/iu);
  assert.doesNotMatch(readme, /--development|--stack|--validation/u);
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
  await run([
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
  ], { output: () => {} });
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
