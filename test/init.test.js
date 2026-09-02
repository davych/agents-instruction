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
const coreRoleIds = [
  "pm-ba",
  "designer",
  "architect",
];
const roleIds = [
  ...coreRoleIds,
  "software-engineer",
  "tester",
  "devops",
];
const frontendDevelopmentArgs = [
  "--development",
  "frontend",
  "--stack",
  "react-shadcn",
  "--validation",
  "standard",
];
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
  "test-report.md",
];

test.after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("Copilot init writes only the Copilot tool set", async () => {
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
    ...frontendDevelopmentArgs,
  ], { output: (value) => output.push(value) }), 0);

  assert.equal(existsSync(path.join(target, ".github/copilot-instructions.md")), true);
  assert.equal(existsSync(path.join(target, ".vscode/mcp.json")), true);
  assert.equal(existsSync(path.join(target, "CLAUDE.md")), false);
  assert.equal(existsSync(path.join(target, "AGENTS.md")), false);
  assert.equal(existsSync(path.join(target, ".mcp.json")), false);
  assert.equal(existsSync(path.join(target, ".claude")), false);
  assert.equal(existsSync(path.join(target, ".codex")), false);
  assert.match(output.join(""), /Created 29 files/u);
  assert.match(output.join(""), /Profile: \.ai-sdlc\/project-profile\.md/u);
  assert.match(output.join(""), /Development work: Yes/u);
  assert.match(output.join(""), /Development area: Frontend/u);
  assert.match(output.join(""), /Stack: React \+ Vite \+ Tailwind \+ shadcn\/ui/u);
  assert.match(output.join(""), /Validation: Standard/u);
  assert.match(output.join(""), /shadcn MCP: \.vscode\/mcp\.json/u);

  const files = (await readdir(path.join(target, ".github/agents"))).sort();
  assert.deepEqual(files, roleIds.map((roleId) => `${roleId}.agent.md`).sort());

  for (const roleId of roleIds) {
    const generated = await readFile(
      path.join(target, ".github/agents", `${roleId}.agent.md`),
      "utf8",
    );
    const canonical = await readFile(
      path.join(repositoryRoot, "templates/agents", `${roleId}.md`),
      "utf8",
    );
    assert.match(generated, new RegExp(`^---\\nname: "${roleId}"\\ndescription: `, "u"));
    assert.ok(generated.endsWith(canonical));
  }

  const instructions = await readFile(
    path.join(target, ".github/copilot-instructions.md"),
    "utf8",
  );
  assert.match(instructions, /\*\*Project:\*\* Small Product/u);
  assert.match(instructions, /\*\*Goal:\*\* Solves one clear problem/u);
  assert.match(instructions, /`docs\/ai-sdlc\/index\.md`/u);
  assert.match(instructions, /Available dedicated role agents are in `\.github\/agents`/u);
  assert.match(instructions, /`\.ai-sdlc\/project-profile\.md`/u);

  const profile = await readFile(path.join(target, ".ai-sdlc/project-profile.md"), "utf8");
  assert.match(profile, /\| Development work \| Yes \|/u);
  assert.match(profile, /\| Development area \| Frontend \|/u);
  assert.match(profile, /\| UI system \| shadcn\/ui \|/u);
  assert.match(profile, /\| Validation preference \| Standard \|/u);
  assert.match(profile, /\| Dedicated agents \| pm-ba, designer, architect, software-engineer, tester, devops \|/u);

  const mcp = JSON.parse(await readFile(path.join(target, ".vscode/mcp.json"), "utf8"));
  assert.deepEqual(mcp, {
    servers: {
      shadcn: {
        command: "npx",
        args: ["shadcn@latest", "mcp"],
      },
    },
  });
});

test("Claude and Codex init use native role and shadcn MCP files", async () => {
  const cases = [
    {
      tool: "claude",
      instructions: "CLAUDE.md",
      directory: ".claude/agents",
      fileName: (roleId) => `${roleId}.md`,
      mcpPath: ".mcp.json",
      absent: [".github", ".vscode", ".codex", "AGENTS.md"],
      assertMcp: (content) => {
        assert.deepEqual(JSON.parse(content), {
          mcpServers: {
            shadcn: {
              command: "npx",
              args: ["shadcn@latest", "mcp"],
            },
          },
        });
      },
    },
    {
      tool: "codex",
      instructions: "AGENTS.md",
      directory: ".codex/agents",
      fileName: (roleId) => `${roleId}.toml`,
      mcpPath: ".codex/config.toml",
      absent: [".github", ".vscode", ".claude", ".mcp.json", "CLAUDE.md"],
      assertMcp: (content) => {
        assert.equal(
          content,
          '[mcp_servers.shadcn]\ncommand = "npx"\nargs = ["shadcn@latest", "mcp"]\n',
        );
      },
    },
  ];

  for (const item of cases) {
    const target = await temporaryDirectory();
    assert.equal(await run([
      "init",
      target,
      "--name",
      "Native Files",
      "--summary",
      "Checks one selected tool",
      "--tool",
      item.tool,
      ...frontendDevelopmentArgs,
    ], { output: () => {} }), 0);

    assert.equal(existsSync(path.join(target, item.instructions)), true);
    assert.equal(existsSync(path.join(target, item.mcpPath)), true);
    assert.deepEqual(
      (await readdir(path.join(target, item.directory))).sort(),
      roleIds.map(item.fileName).sort(),
    );
    for (const absent of item.absent) {
      assert.equal(existsSync(path.join(target, absent)), false);
    }
    item.assertMcp(await readFile(path.join(target, item.mcpPath), "utf8"));

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
        const instructions = generated.match(/^developer_instructions = (.+)$/mu);
        assert.ok(instructions);
        assert.equal(JSON.parse(instructions[1]), source);
      } else {
        assert.match(generated, new RegExp(`^---\\nname: "${roleId}"\\ndescription: `, "u"));
        assert.ok(generated.trimEnd().endsWith(source));
      }
    }
  }
});

test("no-development mode installs only product, design, and architecture agents", async () => {
  const cases = [
    {
      tool: "copilot",
      directory: ".github/agents",
      fileName: (roleId) => `${roleId}.agent.md`,
      mcpPath: ".vscode/mcp.json",
    },
    {
      tool: "claude",
      directory: ".claude/agents",
      fileName: (roleId) => `${roleId}.md`,
      mcpPath: ".mcp.json",
    },
    {
      tool: "codex",
      directory: ".codex/agents",
      fileName: (roleId) => `${roleId}.toml`,
      mcpPath: ".codex/config.toml",
    },
  ];

  for (const item of cases) {
    const target = await initializedProject(item.tool, { development: "none" });
    assert.deepEqual(
      (await readdir(path.join(target, item.directory))).sort(),
      coreRoleIds.map(item.fileName).sort(),
    );
    assert.equal(existsSync(path.join(target, item.mcpPath)), false);
    assert.equal((await listFiles(target)).length, 25);

    const profile = await readFile(path.join(target, ".ai-sdlc/project-profile.md"), "utf8");
    assert.match(profile, /\| Development work \| No \|/u);
    assert.match(profile, /\| Development area \| Not applicable \|/u);
    assert.match(profile, /\| Stack preference \| Not applicable \|/u);
    assert.match(profile, /\| Validation preference \| Not applicable \|/u);
    assert.match(profile, /\| Active phases \| Discovery, Design, Architecture \|/u);
    assert.match(profile, /\| Dedicated agents \| pm-ba, designer, architect \|/u);

    const workflow = await readFile(path.join(target, ".ai-sdlc/workflow.md"), "utf8");
    assert.match(workflow, /Implementation, Verification, and Release have no active work/u);
  }
});

test("frontend and backend presets write one profile and only shadcn writes MCP", async () => {
  const cases = [
    {
      development: "frontend",
      stack: "react-shadcn",
      stackLabel: "React + Vite + Tailwind + shadcn/ui",
      uiSystem: "shadcn/ui",
      validation: "standard",
      validationLabel: "Standard",
      mcp: true,
    },
    {
      development: "frontend",
      stack: "react-antd",
      stackLabel: "React + Vite + Ant Design",
      uiSystem: "Ant Design",
      validation: "lean",
      validationLabel: "Lean",
      mcp: false,
    },
    {
      development: "frontend",
      stack: "react-mui",
      stackLabel: "React + Vite + Material UI",
      uiSystem: "Material UI",
      validation: "thorough",
      validationLabel: "Thorough",
      mcp: false,
    },
    {
      development: "frontend",
      stack: "frontend-existing",
      stackLabel: "Use the existing frontend stack",
      uiSystem: "Follow existing project conventions",
      validation: "standard",
      validationLabel: "Standard",
      mcp: false,
    },
    {
      development: "backend",
      stack: "java-spring",
      stackLabel: "Java + Spring Boot",
      uiSystem: "Not applicable",
      validation: "standard",
      validationLabel: "Standard",
      mcp: false,
    },
    {
      development: "backend",
      stack: "node-typescript",
      stackLabel: "Node.js + TypeScript",
      uiSystem: "Not applicable",
      validation: "lean",
      validationLabel: "Lean",
      mcp: false,
    },
    {
      development: "backend",
      stack: "python-fastapi",
      stackLabel: "Python + FastAPI",
      uiSystem: "Not applicable",
      validation: "thorough",
      validationLabel: "Thorough",
      mcp: false,
    },
    {
      development: "backend",
      stack: "backend-existing",
      stackLabel: "Use the existing backend stack",
      uiSystem: "Not applicable",
      validation: "standard",
      validationLabel: "Standard",
      mcp: false,
    },
  ];

  for (const item of cases) {
    const target = await initializedProject("claude", item);
    const profile = await readFile(path.join(target, ".ai-sdlc/project-profile.md"), "utf8");
    assert.ok(profile.includes("| Development work | Yes |"));
    assert.ok(profile.includes(`| Development area | ${item.development === "frontend" ? "Frontend" : "Backend"} |`));
    assert.ok(profile.includes(`| Stack preference | ${item.stackLabel} |`));
    assert.ok(profile.includes(`| UI system | ${item.uiSystem} |`));
    assert.ok(profile.includes(`| UI MCP | ${item.mcp ? "shadcn" : "None"} |`));
    assert.ok(profile.includes(`| Validation preference | ${item.validationLabel} |`));
    assert.match(
      profile,
      item.development === "frontend" ? /For frontend work/u : /For (?:.+ )?backend work/u,
    );
    assert.equal(existsSync(path.join(target, ".mcp.json")), item.mcp);
    assert.equal((await listFiles(target)).length, item.mcp ? 29 : 28);
    assert.deepEqual(
      (await readdir(path.join(target, ".claude/agents"))).sort(),
      roleIds.map((roleId) => `${roleId}.md`).sort(),
    );
  }
});

test("project profile records safe root-level stack evidence", async () => {
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
    ...frontendDevelopmentArgs,
  ], { output: () => {} });

  const profile = await readFile(path.join(target, ".ai-sdlc/project-profile.md"), "utf8");
  assert.match(profile, /\| package\.json \| Node\.js package manifest; React dependency; Vite dependency; Tailwind CSS dependency; scripts: build, lint \|/u);
  assert.match(profile, /\| components\.json \| shadcn\/ui project configuration \|/u);
  assert.doesNotMatch(profile, /privateTask|secret-command/u);
  assert.equal(profile.includes(target), false);
});

test("stack recommendations require matching evidence and stay neutral for mixed backends", async () => {
  const cases = [
    {
      name: "plain Java",
      area: "backend",
      choice: "4",
      expected: "Use the existing backend stack",
      files: { "pom.xml": "<project><artifactId>plain-java</artifactId></project>\n" },
    },
    {
      name: "plain Python",
      area: "backend",
      choice: "4",
      expected: "Use the existing backend stack",
      files: { "requirements.txt": "django==5.0\n" },
    },
    {
      name: "JavaScript backend",
      area: "backend",
      choice: "4",
      expected: "Use the existing backend stack",
      files: {
        "package.json": JSON.stringify({ dependencies: { express: "latest" } }),
      },
    },
    {
      name: "existing Vue frontend",
      area: "frontend",
      choice: "4",
      expected: "Use the existing frontend stack",
      files: {
        "package.json": JSON.stringify({ dependencies: { vue: "latest" } }),
      },
    },
    {
      name: "existing Go backend",
      area: "backend",
      choice: "4",
      expected: "Use the existing backend stack",
      files: { "go.mod": "module example.com/service\n\ngo 1.24\n" },
      profilePattern: /Target directory is not empty/u,
    },
    {
      name: "unconfirmed components file",
      area: "frontend",
      choice: "4",
      expected: "Use the existing frontend stack",
      files: {
        "package.json": JSON.stringify({
          dependencies: { react: "latest", vite: "latest", tailwindcss: "latest" },
        }),
        "components.json": "{}\n",
      },
      profilePattern: /components\.json present; shadcn\/ui configuration not confirmed/u,
    },
    {
      name: "Spring Boot",
      area: "backend",
      choice: "1",
      expected: "Java + Spring Boot",
      files: {
        "pom.xml": "<project><artifactId>spring-boot-starter-web</artifactId></project>\n",
      },
    },
    {
      name: "TypeScript backend",
      area: "backend",
      choice: "2",
      expected: "Node.js + TypeScript",
      files: {
        "package.json": JSON.stringify({
          dependencies: { express: "latest" },
          devDependencies: { typescript: "latest" },
        }),
      },
    },
    {
      name: "tsconfig TypeScript backend",
      area: "backend",
      choice: "2",
      expected: "Node.js + TypeScript",
      files: {
        "package.json": JSON.stringify({ dependencies: { express: "latest" } }),
        "tsconfig.json": "{}\n",
      },
    },
    {
      name: "FastAPI",
      area: "backend",
      choice: "3",
      expected: "Python + FastAPI",
      files: { "requirements.txt": "fastapi==1.0\n" },
    },
    {
      name: "shadcn frontend",
      area: "frontend",
      choice: "1",
      expected: "React + Vite + Tailwind + shadcn/ui",
      files: {
        "package.json": JSON.stringify({
          dependencies: { react: "latest", vite: "latest", tailwindcss: "latest" },
        }),
        "components.json": JSON.stringify({
          $schema: "https://ui.shadcn.com/schema.json",
        }),
      },
    },
    {
      name: "Ant Design frontend",
      area: "frontend",
      choice: "2",
      expected: "React + Vite + Ant Design",
      files: {
        "package.json": JSON.stringify({
          dependencies: { react: "latest", vite: "latest", antd: "latest" },
        }),
      },
    },
    {
      name: "Material UI frontend",
      area: "frontend",
      choice: "3",
      expected: "React + Vite + Material UI",
      files: {
        "package.json": JSON.stringify({
          dependencies: { react: "latest", vite: "latest", "@mui/material": "latest" },
        }),
      },
    },
    {
      name: "mixed frontend UI systems",
      area: "frontend",
      choice: "4",
      expected: "Use the existing frontend stack",
      files: {
        "package.json": JSON.stringify({
          dependencies: {
            react: "latest",
            vite: "latest",
            antd: "latest",
            "@mui/material": "latest",
          },
        }),
      },
    },
    {
      name: "mixed backend",
      area: "backend",
      choice: "4",
      expected: "Use the existing backend stack",
      files: {
        "pom.xml": "<project><artifactId>spring-boot-starter-web</artifactId></project>\n",
        "requirements.txt": "fastapi==1.0\n",
      },
    },
  ];

  for (const item of cases) {
    const target = await temporaryDirectory();
    for (const [file, content] of Object.entries(item.files)) {
      await writeFile(path.join(target, file), content, "utf8");
    }
    const questions = [];
    const prompt = answers([
      "1",
      item.area === "frontend" ? "1" : "2",
      item.choice,
      "1",
    ], questions);

    await run([
      "init",
      target,
      "--name",
      item.name,
      "--summary",
      "Checks honest stack recommendations",
      "--tool",
      "claude",
    ], { prompt, output: () => {} });

    const stackQuestion = questions.find((question) => /stack preference/u.test(question));
    assert.ok(stackQuestion, item.name);
    assert.match(
      stackQuestion,
      new RegExp(`${escapeRegex(item.expected)} \\(project evidence; recommended\\)`, "u"),
      item.name,
    );
    assert.equal(
      [...stackQuestion.matchAll(/\(project evidence; recommended\)/gu)].length,
      1,
      item.name,
    );
    if (item.profilePattern) {
      const profile = await readFile(path.join(target, ".ai-sdlc/project-profile.md"), "utf8");
      assert.match(profile, item.profilePattern, item.name);
    }
  }
});

test("interactive init asks a short conditional development questionnaire", async () => {
  const target = await temporaryDirectory();
  const questions = [];
  const output = [];
  const prompt = answers([
    "",
    "A short summary",
    "not-a-tool",
    "3",
    "maybe",
    "1",
    "3",
    "1",
    "9",
    "1",
    "9",
    "1",
  ], questions);

  assert.equal(await run(["init", target], {
    prompt,
    output: (value) => output.push(value),
  }), 0);

  assert.equal(questions.length, 12);
  assert.match(questions[0], /Project name/u);
  assert.match(questions[1], /Project summary/u);
  assert.match(questions[2], /Choose your AI tool/u);
  assert.match(questions[4], /perform code development/u);
  assert.match(questions[6], /What development work/u);
  assert.match(questions[8], /frontend stack preference/u);
  assert.match(questions[8], /shadcn\/ui \(recommended\)/u);
  assert.doesNotMatch(questions[8], /project evidence/u);
  assert.match(questions[10], /validation preference/u);
  assert.match(output.join(""), /Choose 1, 2, 3, or 4/u);

  const instructions = await readFile(path.join(target, "AGENTS.md"), "utf8");
  assert.match(
    instructions,
    new RegExp(`\\*\\*Project:\\*\\* ${escapeRegex(path.basename(target))}`, "u"),
  );
  assert.match(instructions, /\*\*Goal:\*\* A short summary/u);
  assert.match(instructions, /Available dedicated role agents are in `\.codex\/agents`/u);
  const profile = await readFile(path.join(target, ".ai-sdlc/project-profile.md"), "utf8");
  assert.match(profile, /\| Development work \| Yes \|/u);
  assert.match(profile, /\| Development area \| Frontend \|/u);
  assert.match(profile, /\| Stack preference \| React \+ Vite \+ Tailwind \+ shadcn\/ui \|/u);
  assert.match(profile, /\| Validation preference \| Standard \|/u);
});

test("interactive no-development choice skips stack and validation questions", async () => {
  const target = await temporaryDirectory();
  const questions = [];
  const prompt = answers(["Docs Project", "Shared delivery documents", "2", "2"], questions);

  await run(["init", target], { prompt, output: () => {} });

  assert.equal(questions.length, 4);
  assert.match(questions[3], /perform code development/u);
  assert.equal(questions.some((question) => /stack preference|validation preference/u.test(question)), false);
  assert.deepEqual(
    (await readdir(path.join(target, ".claude/agents"))).sort(),
    coreRoleIds.map((roleId) => `${roleId}.md`).sort(),
  );
  assert.equal(existsSync(path.join(target, ".mcp.json")), false);
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
    ...frontendDevelopmentArgs,
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
  assert.match(workflow, /Keep the six phases and their owners in this order/u);
  assert.match(workflow, /Use the named dedicated agent for each active phase/u);
  assert.match(workflow, /Read `\.ai-sdlc\/project-profile\.md` before starting/u);
  assert.match(workflow, /Architecture Pack files/u);
  assert.match(workflow, /optional plan, tasks, and notes/u);
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
  assert.match(workflow, /canonical URL for an artifact owned by another repository/u);
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
  for (const file of templateFiles) {
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

test("Designer follows the configured UI system without legacy design scripts", async () => {
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
  assert.match(designer, /configured UI system/u);
  assert.match(designer, /project profile names a UI MCP server/u);
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
  assert.match(profile, /\| UI system \| shadcn\/ui \|/u);
  assert.match(baseline, /Human-curated notes/u);
  assert.match(baseline, /configured UI-system convention/u);
  assert.match(spec, /Experience and information hierarchy/u);
  assert.match(spec, /Responsive behavior/u);
  assert.match(spec, /Accessibility and content/u);
  assert.match(spec, /Visual evidence/u);
  assert.match(spec, /configured UI-system component/u);
  assert.doesNotMatch(spec, /spec_version|deferred_validations|validator/iu);
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
  assert.match(engineer, /profile's validation preference/u);
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

test("roles and artifact templates do not require explicit handoffs", async () => {
  const target = await initializedProject("claude");
  const files = [
    ...roleIds.map((roleId) => path.join(target, ".claude/agents", `${roleId}.md`)),
    ...templateFiles.map((file) => path.join(target, ".ai-sdlc/templates", file)),
    path.join(target, ".ai-sdlc/workflow.md"),
    path.join(target, "docs/ai-sdlc/index.md"),
    path.join(target, "CLAUDE.md"),
  ];

  for (const file of files) {
    const content = await readFile(file, "utf8");
    assert.doesNotMatch(
      content,
      /\bhandoff\b|next owner|give (?:the )?(?:PM \/ BA|Designer|Architect|Software Engineer|Tester|DevOps)\b/iu,
      file,
    );
  }
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
      ...frontendDevelopmentArgs,
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
      ...frontendDevelopmentArgs,
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
      ...frontendDevelopmentArgs,
    ], { output: () => {} }),
    /\.ai-sdlc\/project-profile\.md/u,
  );

  assert.equal(await readFile(profile, "utf8"), "# Existing profile\n");
  assert.equal(existsSync(path.join(target, "CLAUDE.md")), false);
  assert.equal(existsSync(path.join(target, ".mcp.json")), false);
});

test("init preserves existing MCP config for every selected tool", async () => {
  const cases = [
    {
      tool: "copilot",
      mcpPath: ".vscode/mcp.json",
      instructionsPath: ".github/copilot-instructions.md",
    },
    { tool: "claude", mcpPath: ".mcp.json", instructionsPath: "CLAUDE.md" },
    { tool: "codex", mcpPath: ".codex/config.toml", instructionsPath: "AGENTS.md" },
  ];

  for (const item of cases) {
    const target = await temporaryDirectory();
    const mcp = path.join(target, item.mcpPath);
    await mkdir(path.dirname(mcp), { recursive: true });
    await writeFile(mcp, "keep this configuration\n", "utf8");

    await assert.rejects(
      run([
        "init",
        target,
        "--name",
        "Existing MCP",
        "--summary",
        "Must keep the current tool configuration",
        "--tool",
        item.tool,
        ...frontendDevelopmentArgs,
      ], { output: () => {} }),
      new RegExp(escapeRegex(item.mcpPath), "u"),
    );

    assert.equal(await readFile(mcp, "utf8"), "keep this configuration\n");
    assert.equal(existsSync(path.join(target, item.instructionsPath)), false);
    assert.equal(existsSync(path.join(target, ".ai-sdlc")), false);
  }
});

test("backend initialization leaves an unrelated MCP config untouched", async () => {
  const target = await temporaryDirectory();
  const mcp = path.join(target, ".mcp.json");
  await writeFile(mcp, '{"keep":true}\n', "utf8");

  await run([
    "init",
    target,
    "--name",
    "Backend MCP",
    "--summary",
    "Does not configure a UI MCP",
    "--tool",
    "claude",
    "--development",
    "backend",
    "--stack",
    "java-spring",
    "--validation",
    "standard",
  ], { output: () => {} });

  assert.equal(await readFile(mcp, "utf8"), '{"keep":true}\n');
  assert.equal(existsSync(path.join(target, "CLAUDE.md")), true);
  const profile = await readFile(path.join(target, ".ai-sdlc/project-profile.md"), "utf8");
  assert.match(profile, /\| UI MCP \| None \|/u);
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
      ...frontendDevelopmentArgs,
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
      ...frontendDevelopmentArgs,
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
        ...frontendDevelopmentArgs,
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
      "--development",
      "frontend",
      "--stack",
      "react-antd",
      "--validation",
      "standard",
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
  const racedFile = path.join(target, ".mcp.json");

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
      ...frontendDevelopmentArgs,
    ], {
      output: () => {},
      beforeWrite: async ({ path: entryPath }) => {
        if (entryPath === ".mcp.json") {
          await writeFile(racedFile, "Created by another process.\n", "utf8");
        }
      },
    }),
    /EEXIST|file already exists/iu,
  );

  assert.equal(await readFile(racedFile, "utf8"), "Created by another process.\n");
  assert.equal(existsSync(path.join(target, "CLAUDE.md")), false);
  assert.equal(existsSync(path.join(target, ".ai-sdlc")), false);
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
        ...frontendDevelopmentArgs,
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
  assert.match(helpResult.stdout, /--development <mode>/u);
  assert.match(helpResult.stdout, /--stack <preset>/u);
  assert.match(helpResult.stdout, /--validation <preference>/u);

  await assert.rejects(run(["init", ".", "--tool", "unknown"]), /Unknown AI tool/u);
  await assert.rejects(
    run(["init", ".", "--development", "mobile"]),
    /Unknown development mode: mobile/u,
  );
  await assert.rejects(run(["init", ".", "--stack", "rails"]), /Unknown stack: rails/u);
  await assert.rejects(
    run(["init", ".", "--validation", "maximum"]),
    /Unknown validation preference: maximum/u,
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
  await assert.rejects(run(completeBase, { output: () => {} }), /--development is required/u);
  await assert.rejects(
    run([...completeBase, "--development", "frontend"], { output: () => {} }),
    /--stack is required for frontend development/u,
  );
  await assert.rejects(
    run([
      ...completeBase,
      "--development",
      "frontend",
      "--stack",
      "react-shadcn",
    ], { output: () => {} }),
    /--validation is required when development is enabled/u,
  );
  await assert.rejects(
    run([
      ...completeBase,
      "--stack",
      "java-spring",
      "--development",
      "frontend",
      "--validation",
      "standard",
    ], { output: () => {} }),
    /Stack java-spring is not valid for frontend development/u,
  );
  await assert.rejects(
    run([...completeBase, "--development", "none", "--stack", "react-shadcn"], {
      output: () => {},
    }),
    /--stack cannot be used/u,
  );
  await assert.rejects(
    run([...completeBase, "--development", "none", "--validation", "standard"], {
      output: () => {},
    }),
    /--validation cannot be used/u,
  );
  await assert.rejects(run(["serve"]), /Use: create-ai-native-sdlc init/u);
  await assert.rejects(run(["init", ".", "--client", "codex"]), /Unknown option/u);
  await assert.rejects(run(["init", ".", "--name", "   "]), /--name needs a value/u);
  await assert.rejects(run(["init", ".", "--development"]), /--development needs a value/u);
  await assert.rejects(run(["init", ".", "--stack"]), /--stack needs a value/u);
  await assert.rejects(run(["init", ".", "--validation"]), /--validation needs a value/u);
});

test("README describes current outputs without the old negative capability list", async () => {
  const readme = await readFile(path.join(repositoryRoot, "README.md"), "utf8");

  assert.match(readme, /## Generated files/u);
  assert.match(readme, /## Delivery workflow/u);
  assert.match(readme, /## Architecture Pack/u);
  assert.match(readme, /docs\/ai-sdlc\/index\.md/u);
  assert.match(readme, /\.ai-sdlc\/project-profile\.md/u);
  assert.match(readme, /`none`/u);
  assert.match(readme, /`frontend`/u);
  assert.match(readme, /`backend`/u);
  assert.match(readme, /`react-shadcn`, `react-antd`, `react-mui`/u);
  assert.match(readme, /`java-spring`, `node-typescript`, `python-fastapi`/u);
  assert.match(readme, /`frontend-existing`/u);
  assert.match(readme, /`backend-existing`/u);
  assert.match(readme, /`lean`, `standard`, or `thorough`/u);
  assert.doesNotMatch(readme, /## What it does not include/iu);
  assert.doesNotMatch(
    readme,
    /^- No (?:web app|server or database|workflow runner|dashboard|sync or migration engine|large group of reports)/imu,
  );
});

test("generated files are plain English and do not contain old platform contracts", async () => {
  for (const tool of ["copilot", "claude", "codex"]) {
    const target = await initializedProject(tool);
    const files = await listFiles(target);
    assert.equal(files.length, 29);

    for (const file of files) {
      const content = await readFile(file, "utf8");
      assert.doesNotMatch(content, /[\u3400-\u9fff]/u, file);
      assert.doesNotMatch(content, /\{\{[A-Z_]+\}\}/u, file);
      assert.doesNotMatch(
        content,
        /Run-scoped|semantic gate|artifact revision|artifact registry|architecture-rulebook|architecture-selection|catalogDigest|reviewId|optionsArtifactId|selectedAt|selection review UUID|minimum_findings|machine-readable|execution contract|change contract|seven-lens|Tier [ABC]|ai-native\.yaml/iu,
        file,
      );
    }
  }
});

async function initializedProject(tool, configuration = {}) {
  const target = await temporaryDirectory();
  const development = configuration.development ?? "frontend";
  const developmentArgs = ["--development", development];
  if (development !== "none") {
    developmentArgs.push(
      "--stack",
      configuration.stack ?? (development === "frontend" ? "react-shadcn" : "java-spring"),
      "--validation",
      configuration.validation ?? "standard",
    );
  }
  await run([
    "init",
    target,
    "--name",
    "Test Project",
    "--summary",
    "A small test project",
    "--tool",
    tool,
    ...developmentArgs,
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
