import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "ai-native-pack-"));

try {
  const packageDirectory = path.join(temporaryRoot, "package");
  const consumerDirectory = path.join(temporaryRoot, "consumer");
  const targetDirectory = path.join(temporaryRoot, "project with 空格");
  await mkdir(packageDirectory, { recursive: true });
  await mkdir(consumerDirectory, { recursive: true });
  await mkdir(targetDirectory, { recursive: true });
  await writeFile(path.join(targetDirectory, "sentinel.txt"), "keep me\n", "utf8");
  await writeFile(
    path.join(consumerDirectory, "package.json"),
    '{"name":"pack-smoke-consumer","private":true,"version":"1.0.0"}\n',
    "utf8"
  );

  const pack = run("npm", ["pack", "--json", "--pack-destination", packageDirectory], repositoryRoot);
  const [{ filename }] = JSON.parse(pack.stdout);
  const tarball = path.join(packageDirectory, filename);

  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], consumerDirectory);
  await access(path.join(consumerDirectory, "node_modules/.bin/create-ai-native-sdlc"), constants.X_OK);

  run(
    "npx",
    ["--no-install", "create-ai-native-sdlc", "init", targetDirectory, "--name", "Pack Smoke"],
    consumerDirectory
  );
  run("npx", ["--no-install", "create-ai-native-sdlc", "sync", targetDirectory], consumerDirectory);
  run("npx", ["--no-install", "create-ai-native-sdlc", "check", targetDirectory], consumerDirectory);

  const sentinel = await readFile(path.join(targetDirectory, "sentinel.txt"), "utf8");
  if (sentinel !== "keep me\n") {
    throw new Error("Existing target files were changed by packaged CLI");
  }
  for (const expected of [
    "ai-native.yaml",
    "AGENTS.md",
    "CLAUDE.md",
    ".github/agents/pm-ba.agent.md",
    ".claude/agents/designer.md",
    ".codex/agents/architect.toml",
    ".ai-sdlc/manifest.json"
  ]) {
    await access(path.join(targetDirectory, expected));
  }

  process.stdout.write(`Pack smoke test passed: ${filename}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_cache: path.join(temporaryRoot, "npm-cache"),
      npm_config_fund: "false"
    }
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})\n${result.stdout}\n${result.stderr}`
    );
  }
  return result;
}
