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
const phaseArtifacts = [
  "prd.md",
  "design-spec.md",
  "architecture.md",
  "implementation-notes.md",
  "test-report.md",
  "release-runbook.md",
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
  ], { output: (value) => output.push(value) }), 0);

  assert.equal(existsSync(path.join(target, ".github/copilot-instructions.md")), true);
  assert.equal(existsSync(path.join(target, "CLAUDE.md")), false);
  assert.equal(existsSync(path.join(target, "AGENTS.md")), false);
  assert.equal(existsSync(path.join(target, ".claude")), false);
  assert.equal(existsSync(path.join(target, ".codex")), false);
  assert.match(output.join(""), /Created 14 files/u);

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
  assert.match(instructions, /Role agents are in `\.github\/agents`/u);
});

test("Claude and Codex init use their native files", async () => {
  const cases = [
    {
      tool: "claude",
      instructions: "CLAUDE.md",
      directory: ".claude/agents",
      fileName: (roleId) => `${roleId}.md`,
      absent: [".github", ".codex", "AGENTS.md"],
    },
    {
      tool: "codex",
      instructions: "AGENTS.md",
      directory: ".codex/agents",
      fileName: (roleId) => `${roleId}.toml`,
      absent: [".github", ".claude", "CLAUDE.md"],
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
    ], { output: () => {} }), 0);

    assert.equal(existsSync(path.join(target, item.instructions)), true);
    assert.deepEqual(
      (await readdir(path.join(target, item.directory))).sort(),
      roleIds.map(item.fileName).sort(),
    );
    for (const absent of item.absent) {
      assert.equal(existsSync(path.join(target, absent)), false);
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

test("interactive init asks only for the project and tool", async () => {
  const target = await temporaryDirectory();
  const questions = [];
  const output = [];
  const prompt = answers([
    "",
    "A short summary",
    "not-a-tool",
    "3",
  ], questions);

  assert.equal(await run(["init", target], {
    prompt,
    output: (value) => output.push(value),
  }), 0);

  assert.equal(questions.length, 4);
  assert.match(questions[0], /Project name/u);
  assert.match(questions[1], /Project summary/u);
  assert.match(questions[2], /Choose your AI tool/u);
  assert.match(output.join(""), /Choose 1, 2, or 3/u);

  const instructions = await readFile(path.join(target, "AGENTS.md"), "utf8");
  assert.match(
    instructions,
    new RegExp(`\\*\\*Project:\\*\\* ${escapeRegex(path.basename(target))}`, "u"),
  );
  assert.match(instructions, /\*\*Goal:\*\* A short summary/u);
  assert.match(instructions, /Role agents are in `\.codex\/agents`/u);
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
  ], { output: () => {} });

  const instructions = await readFile(path.join(target, "CLAUDE.md"), "utf8");
  assert.match(instructions, /\*\*Project:\*\* Name \{\{PROJECT_SUMMARY\}\}/u);
  assert.match(instructions, /\*\*Goal:\*\* Goal \{\{PROJECT_NAME\}\}/u);
});

test("shared workflow has one small artifact for each phase", async () => {
  const target = await initializedProject("claude");
  const templates = (
    await readdir(path.join(target, ".ai-sdlc/templates"))
  ).sort();

  assert.deepEqual(templates, [...phaseArtifacts].sort());
  assert.equal(existsSync(path.join(target, ".ai-sdlc/workflow.md")), true);
  assert.equal(existsSync(path.join(target, ".ai-sdlc/roles")), false);

  const workflow = await readFile(path.join(target, ".ai-sdlc/workflow.md"), "utf8");
  const phaseLines = workflow
    .split("\n")
    .filter((line) => /^\| (Discovery|Design|Architecture|Implementation|Verification|Release) \|/u.test(line));
  assert.deepEqual(
    phaseLines.map((line) => line.split("|")[1].trim()),
    ["Discovery", "Design", "Architecture", "Implementation", "Verification", "Release"],
  );
  assert.match(workflow, /For each phase, use the role agent named in the table/u);
  for (const artifact of phaseArtifacts) assert.match(workflow, new RegExp(escapeRegex(artifact), "u"));
});

test("Software Engineer stays focused on code, tests, checks, and one note", async () => {
  const target = await initializedProject("copilot");
  const engineer = await readFile(
    path.join(target, ".github/agents/software-engineer.agent.md"),
    "utf8",
  );
  const notes = await readFile(
    path.join(target, ".ai-sdlc/templates/implementation-notes.md"),
    "utf8",
  );

  assert.match(engineer, /smallest safe code and test diff/u);
  assert.match(engineer, /Run the relevant existing checks/u);
  assert.match(engineer, /Review the real diff/u);
  assert.match(engineer, /Give Tester/u);
  assert.doesNotMatch(
    engineer,
    /seven[- ]lens|Tier A|Tier B|adversarial pass|session log|provenance/iu,
  );

  assert.deepEqual(
    headings(notes),
    [
      "Implementation Notes",
      "Status",
      "Scope",
      "Changes",
      "Checks",
      "Limits and risks",
      "Tester handoff",
    ],
  );
  for (const removed of [
    "implementation-plan.md",
    "implementation-tasks.md",
    "engineering-session-log.md",
    "engineering-test-evidence.md",
    "engineering-review.md",
    "engineering-provenance.md",
  ]) {
    assert.equal(existsSync(path.join(target, ".ai-sdlc/templates", removed)), false);
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
    ], { output: () => {} }),
    /CLAUDE\.md/u,
  );

  assert.equal(await readFile(existing, "utf8"), "Keep this file.\n");
  assert.equal(existsSync(path.join(target, ".ai-sdlc")), false);
  assert.equal(existsSync(path.join(target, ".claude")), false);
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
      ], { output: () => {} }),
      /permission denied|EACCES/iu,
    );
    assert.equal(existsSync(path.join(target, "CLAUDE.md")), false);
    assert.deepEqual(await readdir(lockedDirectory), []);
  } finally {
    await chmod(lockedDirectory, 0o700);
  }
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
  assert.doesNotMatch(helpResult.stdout, /Designer|component catalog|sync|migration/iu);

  await assert.rejects(
    run(["init", ".", "--tool", "unknown"]),
    /Unknown AI tool/u,
  );
  await assert.rejects(
    run(["serve"]),
    /Use: create-ai-native-sdlc init/u,
  );
  await assert.rejects(
    run(["init", ".", "--client", "codex"]),
    /Unknown option/u,
  );
  await assert.rejects(
    run(["init", ".", "--name", "   "]),
    /--name needs a value/u,
  );
});

test("generated text is plain English and has no old runtime terms", async () => {
  for (const tool of ["copilot", "claude", "codex"]) {
    const target = await initializedProject(tool);
    const files = await listFiles(target);
    assert.equal(files.length, 14);

    for (const file of files) {
      const content = await readFile(file, "utf8");
      assert.doesNotMatch(content, /[\u3400-\u9fff]/u, file);
      assert.doesNotMatch(content, /\{\{[A-Z_]+\}\}/u, file);
      assert.doesNotMatch(
        content,
        /Web Platform|Run-scoped|semantic gate|Linked E2E Workspace|artifact revision/iu,
        file,
      );
    }
  }
});

test("the repository has no platform product or old guide tree", () => {
  assert.equal(existsSync(path.join(repositoryRoot, "platform")), false);
  assert.equal(existsSync(path.join(repositoryRoot, "guidelines")), false);
  assert.equal(
    existsSync(path.join(repositoryRoot, "test/tester-e2e-workflow.test.js")),
    false,
  );
});

async function initializedProject(tool) {
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
  ], { output: () => {} });
  return target;
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
