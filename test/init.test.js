import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import YAML from "yaml";

import { run } from "../bin/cli.js";

const temporaryDirectories = [];

test.after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("init copies the YAML-driven workflow and all six native role adapters", async () => {
  const target = await temporaryDirectory();
  assert.equal(await run(
    ["init", target, "--name", "Solo Product", "--summary", "A small product"],
    process.cwd(),
    () => {}
  ), 0);

  const config = YAML.parse(await readFile(path.join(target, "ai-native.yaml"), "utf8"));
  assert.equal(config.project.name, "Solo Product");
  assert.equal(config.roles.length, 6);

  for (const role of config.roles) {
    await readFile(path.join(target, `.ai-native/roles/${role.id}.md`), "utf8");
    await readFile(path.join(target, `.github/agents/${role.id}.agent.md`), "utf8");
    await readFile(path.join(target, `.claude/agents/${role.id}.md`), "utf8");
    await readFile(path.join(target, `.codex/agents/${role.id}.toml`), "utf8");
  }
  assert.match(await readFile(path.join(target, "AGENTS.md"), "utf8"), /Solo Product/u);
  assert.match(await readFile(path.join(target, ".ai-native/baseline/workflow.md"), "utf8"), /Discovery/u);
});

test("the installed-bin style entry runs and preserves existing project files", async () => {
  const target = await temporaryDirectory();
  const launcherRoot = await temporaryDirectory();
  const launcher = path.join(launcherRoot, ".bin/create-ai-native-sdlc");
  await mkdir(path.dirname(launcher), { recursive: true });
  await symlink(path.resolve("bin/cli.js"), launcher);
  const agentsPath = path.join(target, "AGENTS.md");
  await writeFile(agentsPath, "user instructions\n", "utf8");

  const result = spawnSync(launcher, ["init", target], {
    cwd: path.resolve("."),
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(agentsPath, "utf8"), "user instructions\n");
  assert.match(await readFile(path.join(target, "ai-native.yaml"), "utf8"), /version: 1/u);
});

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-native-simple-"));
  temporaryDirectories.push(directory);
  return directory;
}
