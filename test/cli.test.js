import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import YAML from "yaml";

import { runCli } from "../src/cli.js";
import { applyPlan } from "../src/engine.js";

const temporaryDirectories = [];

test.after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("init preserves an existing project and generates all provider roles", async () => {
  const root = await createTempDirectory();
  await writeFile(path.join(root, "README.md"), "user readme\n", "utf8");
  await writeFile(path.join(root, "AGENTS.md"), "# Existing instructions\n", "utf8");
  await writeFile(path.join(root, ".gitignore"), "dist/\n", "utf8");

  const initialized = await invoke(["init", root, "--name", "Solo App", "--summary", "Test product"]);
  assert.equal(initialized.code, 0, initialized.stderr);
  assert.equal(await readFile(path.join(root, "README.md"), "utf8"), "user readme\n");

  const agents = await readFile(path.join(root, "AGENTS.md"), "utf8");
  assert.match(agents, /^# Existing instructions/u);
  assert.match(agents, /ai-native-sdlc:start/u);
  assert.match(agents, /Solo App/u);

  const roleIds = ["pm-ba", "designer", "architect", "software-engineer", "tester", "devops"];
  for (const roleId of roleIds) {
    await access(path.join(root, `.github/agents/${roleId}.agent.md`));
    await access(path.join(root, `.claude/agents/${roleId}.md`));
    await access(path.join(root, `.codex/agents/${roleId}.toml`));
    await access(path.join(root, `.ai-sdlc/roles/${roleId}.md`));
  }

  const clean = await invoke(["check", root]);
  assert.equal(clean.code, 0, clean.stderr);
});

test("provider agent and skill metadata follows each native contract", async () => {
  const root = await initializedProject();
  const copilot = frontmatter(await readFile(path.join(root, ".github/agents/pm-ba.agent.md"), "utf8"));
  assert.equal(copilot.name, "PM / BA");
  assert.equal(typeof copilot.description, "string");

  const claude = frontmatter(await readFile(path.join(root, ".claude/agents/pm-ba.md"), "utf8"));
  assert.equal(claude.name, "pm-ba");
  assert.equal(typeof claude.description, "string");

  const skill = frontmatter(await readFile(path.join(root, ".agents/skills/discovery/SKILL.md"), "utf8"));
  assert.equal(skill.name, "discovery");
  assert.ok(skill.description.length <= 1024);

  const codex = await readFile(path.join(root, ".codex/agents/pm-ba.toml"), "utf8");
  assert.match(codex, /^name = "pm-ba"$/mu);
  assert.match(codex, /^description = ".+"$/mu);
  assert.match(codex, /^developer_instructions = ".+"$/mu);
});

test("sync is byte-idempotent and can discover the project root from a child", async () => {
  const root = await initializedProject();
  const child = path.join(root, "src/nested");
  await mkdir(child, { recursive: true });
  const before = await contentSnapshot(root);

  const synced = await invoke(["sync"], child);
  assert.equal(synced.code, 0, synced.stderr);
  assert.match(synced.stdout, /写入 0 个文件/u);
  assert.deepEqual(await contentSnapshot(root), before);
});

test("dry-run on a missing target performs zero writes", async () => {
  const parent = await createTempDirectory();
  const target = path.join(parent, "not-created");
  const result = await invoke(["init", target, "--dry-run", "--name", "Dry Run"]);
  assert.equal(result.code, 0, result.stderr);
  await assert.rejects(stat(target), { code: "ENOENT" });
});

test("an unknown managed file causes a transactional conflict", async () => {
  const root = await createTempDirectory();
  const conflictingPath = path.join(root, ".codex/agents/pm-ba.toml");
  await mkdir(path.dirname(conflictingPath), { recursive: true });
  await writeFile(conflictingPath, "user owned\n", "utf8");
  const before = await contentSnapshot(root);

  const result = await invoke(["init", root, "--name", "Conflict"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /未写入任何文件/u);
  assert.deepEqual(await contentSnapshot(root), before);
});

test("force backs up a conflicting managed file before replacing it", async () => {
  const root = await createTempDirectory();
  const conflictingPath = path.join(root, ".codex/agents/pm-ba.toml");
  await mkdir(path.dirname(conflictingPath), { recursive: true });
  await writeFile(conflictingPath, "user owned\n", "utf8");
  await chmod(conflictingPath, 0o600);

  const result = await invoke(["init", root, "--name", "Force", "--force"]);
  assert.equal(result.code, 0, result.stderr);
  const backupRoot = path.join(root, ".ai-sdlc/backups");
  const [runId] = await readdir(backupRoot);
  const backupPath = path.join(backupRoot, runId, ".codex/agents/pm-ba.toml");
  assert.equal(
    await readFile(backupPath, "utf8"),
    "user owned\n"
  );
  assert.equal((await stat(conflictingPath)).mode & 0o777, 0o600);
  assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(backupRoot, runId))).mode & 0o777, 0o700);
  assert.match(await readFile(conflictingPath, "utf8"), /name = "pm-ba"/u);
});

test("a symlinked backup root is rejected before any external backup write", async () => {
  const root = await createTempDirectory();
  const outside = await createTempDirectory();
  const conflictingPath = path.join(root, ".codex/agents/pm-ba.toml");
  await mkdir(path.dirname(conflictingPath), { recursive: true });
  await mkdir(path.join(root, ".ai-sdlc"), { recursive: true });
  await writeFile(conflictingPath, "user owned\n", "utf8");
  await symlink(outside, path.join(root, ".ai-sdlc/backups"), "dir");

  const result = await invoke(["init", root, "--name", "Unsafe Backup", "--force"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /符号链接/u);
  assert.deepEqual(await readdir(outside), []);
  assert.equal(await readFile(conflictingPath, "utf8"), "user owned\n");
});

test("seed artifacts stay user-owned while managed baselines follow config", async () => {
  const root = await initializedProject();
  const seedPath = path.join(root, "docs/ai-sdlc/product/product-brief.md");
  await writeFile(seedPath, "# My living product brief\n", "utf8");
  await mutateConfig(root, (config) => {
    config.project.summary = "Changed from configuration";
  });

  const synced = await invoke(["sync", root]);
  assert.equal(synced.code, 0, synced.stderr);
  assert.equal(await readFile(seedPath, "utf8"), "# My living product brief\n");
  assert.match(
    await readFile(path.join(root, ".ai-sdlc/baseline/project-charter.md"), "utf8"),
    /Changed from configuration/u
  );
  assert.equal((await invoke(["check", root])).code, 0);
});

test("block updates preserve user content outside markers", async () => {
  const root = await initializedProject();
  const agentsPath = path.join(root, "AGENTS.md");
  const generated = await readFile(agentsPath, "utf8");
  await writeFile(agentsPath, `USER PREFIX\n${generated}USER SUFFIX\n`, "utf8");
  await mutateConfig(root, (config) => {
    config.project.summary = "New block summary";
  });

  const synced = await invoke(["sync", root]);
  assert.equal(synced.code, 0, synced.stderr);
  const updated = await readFile(agentsPath, "utf8");
  assert.match(updated, /^USER PREFIX/u);
  assert.match(updated, /USER SUFFIX\n$/u);
  assert.match(updated, /New block summary/u);
});

test("manual edits to a generated block conflict and force creates a backup", async () => {
  const root = await initializedProject();
  const claudePath = path.join(root, "CLAUDE.md");
  const original = await readFile(claudePath, "utf8");
  await writeFile(claudePath, original.replace("Claude Code Adapter", "Human changed block"), "utf8");

  const conflict = await invoke(["sync", root]);
  assert.equal(conflict.code, 2);
  const forced = await invoke(["sync", root, "--force"]);
  assert.equal(forced.code, 0, forced.stderr);
  assert.match(await readFile(claudePath, "utf8"), /Claude Code Adapter/u);
  const backupRuns = await readdir(path.join(root, ".ai-sdlc/backups"));
  assert.ok(backupRuns.length > 0);
});

test("disabling an integration and pruning removes only owned provider files", async () => {
  const root = await initializedProject();
  await mutateConfig(root, (config) => {
    config.integrations.codex = false;
  });

  const stale = await invoke(["sync", root]);
  assert.equal(stale.code, 0, stale.stderr);
  assert.match(stale.stdout, /stale/u);
  await access(path.join(root, ".codex/agents/architect.toml"));

  const pruned = await invoke(["sync", root, "--prune"]);
  assert.equal(pruned.code, 0, pruned.stderr);
  await assert.rejects(access(path.join(root, ".codex/agents/architect.toml")), { code: "ENOENT" });
  const backupRuns = await readdir(path.join(root, ".ai-sdlc/backups"));
  await access(path.join(root, ".ai-sdlc/backups", backupRuns[0], ".codex/agents/architect.toml"));
  assert.equal((await invoke(["check", root])).code, 0);
});

test("invalid and duplicate YAML is rejected without writes", async () => {
  const root = await initializedProject();
  const configPath = path.join(root, "ai-native.yaml");
  const valid = await readFile(configPath, "utf8");
  await writeFile(configPath, `${valid}\nschemaVersion: 1\n`, "utf8");
  const before = await contentSnapshot(root);

  const result = await invoke(["sync", root]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Map keys must be unique|重复/u);
  assert.deepEqual(await contentSnapshot(root), before);
});

test("unsafe output paths are rejected before they can escape the project", async () => {
  const root = await initializedProject();
  const escapeName = `${path.basename(root)}-escape.md`;
  const outside = path.join(path.dirname(root), escapeName);
  await mutateConfig(root, (config) => {
    config.artifacts[0].output = `../${escapeName}`;
  });
  const before = await contentSnapshot(root);

  const result = await invoke(["sync", root]);
  assert.equal(result.code, 1);
  assert.deepEqual(await contentSnapshot(root), before);
  await assert.rejects(access(outside), { code: "ENOENT" });
});

test("reserved manifest and config paths cannot be used as generated outputs", async () => {
  const root = await initializedProject();
  const manifestPath = path.join(root, ".ai-sdlc/manifest.json");
  const manifestBefore = await readFile(manifestPath, "utf8");
  await mutateConfig(root, (config) => {
    config.paths.baseline = ".ai-sdlc";
    config.baselines[0].output = ".ai-sdlc/manifest.json";
  });

  const result = await invoke(["sync", root]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /保留文件/u);
  assert.equal(await readFile(manifestPath, "utf8"), manifestBefore);
});

test("a symlink in an output path is rejected before external writes", async () => {
  const root = await initializedProject();
  const outside = await createTempDirectory();
  const linkPath = path.join(root, "docs/ai-sdlc/external-link");
  await symlink(outside, linkPath, "dir");
  await mutateConfig(root, (config) => {
    config.artifacts[0].output = "docs/ai-sdlc/external-link/escaped.md";
  });
  const manifestPath = path.join(root, ".ai-sdlc/manifest.json");
  const manifestBefore = await readFile(manifestPath, "utf8");

  const result = await invoke(["sync", root]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /符号链接/u);
  assert.equal(await readFile(manifestPath, "utf8"), manifestBefore);
  await assert.rejects(access(path.join(outside, "escaped.md")), { code: "ENOENT" });
});

test("unknown commands fail without creating a typo-named project", async () => {
  const root = await createTempDirectory();
  const result = await invoke(["sycn"], root);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /未知命令/u);
  await assert.rejects(access(path.join(root, "sycn")), { code: "ENOENT" });
});

test("custom config paths never embed shell-executable quoting in generated instructions", async () => {
  const root = await createTempDirectory();
  const configPath = "config/solo $HOME's.yaml";
  const initialized = await invoke(["init", root, "--config", configPath, "--name", "Custom Config"]);
  assert.equal(initialized.code, 0, initialized.stderr);
  const agents = await readFile(path.join(root, "AGENTS.md"), "utf8");
  assert.match(agents, /--config <path-to-config>/u);
  assert.match(agents, /当前 shell 正确引用/u);
  assert.doesNotMatch(agents, /--config .*\$HOME/u);
  assert.equal((await invoke(["check", root, "--config", configPath])).code, 0);
});

test("manifest cannot claim and prune the YAML source of truth", async () => {
  const root = await initializedProject();
  const manifestPath = path.join(root, ".ai-sdlc/manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.files["ai-native.yaml"] = {
    hash: "0".repeat(64),
    mode: "managed",
    pathCreatedByGenerator: false
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const result = await invoke(["sync", root, "--prune"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /manifest 不得管理保留文件/u);
  await access(path.join(root, "ai-native.yaml"));
});

test("missing registered block markers conflict instead of duplicating instructions", async () => {
  const root = await initializedProject();
  const agentsPath = path.join(root, "AGENTS.md");
  const withoutMarkers = (await readFile(agentsPath, "utf8"))
    .replace("<!-- ai-native-sdlc:start -->\n", "")
    .replace("<!-- ai-native-sdlc:end -->\n", "");
  await writeFile(agentsPath, withoutMarkers, "utf8");
  const before = await readFile(agentsPath, "utf8");

  const result = await invoke(["sync", root]);
  assert.equal(result.code, 2);
  assert.equal(await readFile(agentsPath, "utf8"), before);
});

test("pruning a generated block from a pre-existing empty host preserves the host file", async () => {
  const root = await createTempDirectory();
  await writeFile(path.join(root, "CLAUDE.md"), "", "utf8");
  assert.equal((await invoke(["init", root, "--name", "Empty Host"])).code, 0);
  await mutateConfig(root, (config) => {
    config.integrations.claudeCode = false;
  });
  assert.equal((await invoke(["sync", root, "--prune"])).code, 0);
  assert.equal(await readFile(path.join(root, "CLAUDE.md"), "utf8"), "\n");
});

test("CRLF checkouts are ownership-equivalent to generated LF text", async () => {
  const root = await initializedProject();
  for (const relativePath of [
    "AGENTS.md",
    ".ai-sdlc/baseline/project-charter.md",
    ".ai-sdlc/manifest.json"
  ]) {
    const filePath = path.join(root, relativePath);
    const source = await readFile(filePath, "utf8");
    await writeFile(filePath, source.replace(/\n/gu, "\r\n"), "utf8");
  }
  const checked = await invoke(["check", root]);
  assert.equal(checked.code, 0, checked.stderr);
});

test("check reports drift with exit code 1 and machine-readable JSON", async () => {
  const root = await initializedProject();
  await mutateConfig(root, (config) => {
    config.project.summary = "Unsynchronized change";
  });
  const checked = await invoke(["check", root, "--json"]);
  assert.equal(checked.code, 1);
  const result = JSON.parse(checked.stdout);
  assert.equal(result.mode, "check");
  assert.equal(result.drift, true);
  assert.equal(result.exitCode, 1);
  assert.ok(result.counts.update > 0);
});

test("file-to-directory output migration fails safely with actionable guidance", async () => {
  const root = await initializedProject();
  await mutateConfig(root, (config) => {
    config.baselines[0].output = ".ai-sdlc/baseline/project-charter.md/nested.md";
  });
  const before = await contentSnapshot(root);
  const result = await invoke(["sync", root, "--prune"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /临时同级路径/u);
  assert.deepEqual(await contentSnapshot(root), before);
});

test("a disabled role can be pruned after its workflow and deliverables are removed", async () => {
  const root = await initializedProject();
  await mutateConfig(root, (config) => {
    const designer = config.roles.find((role) => role.id === "designer");
    designer.enabled = false;
    designer.deliverables = [];
    config.artifacts = config.artifacts.filter((artifact) => artifact.id !== "design-spec");
    config.workflow.phases = config.workflow.phases
      .filter((phase) => phase.id !== "design")
      .map((phase) => ({
        ...phase,
        inputs: phase.inputs.filter((input) => input !== "design-spec")
      }));
  });

  const firstPrune = await invoke(["sync", root, "--prune"]);
  assert.equal(firstPrune.code, 0, firstPrune.stderr);
  await assert.rejects(access(path.join(root, ".github/agents/designer.agent.md")), { code: "ENOENT" });
  const seedPath = path.join(root, "docs/ai-sdlc/design/design-spec.md");
  await access(seedPath);
  assert.match(firstPrune.stdout, /seed files are user-owned/u);

  await rm(seedPath);
  assert.equal((await invoke(["sync", root, "--prune"])).code, 0);
  assert.equal((await invoke(["check", root])).code, 0);
});

test("rollback preserves a concurrent user edit instead of deleting it", async () => {
  const root = await createTempDirectory();
  const firstPath = path.join(root, "a.txt");
  const secondPath = path.join(root, "b.txt");
  await writeFile(secondPath, "before\n", "utf8");
  const plan = {
    root,
    actions: [
      {
        kind: "create",
        mode: "managed",
        path: "a.txt",
        before: null,
        after: "generated\n",
        backup: false
      },
      {
        kind: "update",
        mode: "managed",
        path: "b.txt",
        before: "before\n",
        after: "after\n",
        backup: false
      }
    ]
  };

  await assert.rejects(
    applyPlan(plan, {
      beforeAction: async (_action, index) => {
        if (index === 1) {
          await writeFile(firstPath, "USER-RACE\n", "utf8");
          await writeFile(secondPath, "CONCURRENT\n", "utf8");
        }
      }
    }),
    (error) => {
      assert.match(error.message, /已回滚本次写入/u);
      assert.ok(error.details.some((detail) => detail.includes("回滚未覆盖已变化的文件: a.txt")));
      return true;
    }
  );
  assert.equal(await readFile(firstPath, "utf8"), "USER-RACE\n");
  assert.equal(await readFile(secondPath, "utf8"), "CONCURRENT\n");
});

test("rollback refuses a parent-directory symlink swap", async () => {
  const root = await createTempDirectory();
  const outside = await createTempDirectory();
  const secondPath = path.join(root, "trigger.txt");
  await writeFile(secondPath, "before\n", "utf8");
  const plan = twoActionRollbackPlan(root, "nested/generated.txt", secondPath);

  await assert.rejects(
    applyPlan(plan, {
      beforeAction: async (_action, index) => {
        if (index === 1) {
          await rename(path.join(root, "nested"), path.join(root, "nested-original"));
          await writeFile(path.join(outside, "generated.txt"), "generated\n", "utf8");
          await symlink(outside, path.join(root, "nested"), "dir");
          await writeFile(secondPath, "CONCURRENT\n", "utf8");
        }
      }
    }),
    (error) => error.details.some((detail) => detail.includes("nested/generated.txt"))
  );
  assert.equal(await readFile(path.join(outside, "generated.txt"), "utf8"), "generated\n");
});

test("rollback refuses an ABA parent-directory replacement", async () => {
  const root = await createTempDirectory();
  const secondPath = path.join(root, "trigger.txt");
  await writeFile(secondPath, "before\n", "utf8");
  const plan = twoActionRollbackPlan(root, "nested/generated.txt", secondPath);

  await assert.rejects(
    applyPlan(plan, {
      beforeAction: async (_action, index) => {
        if (index === 1) {
          await rename(path.join(root, "nested"), path.join(root, "nested-original"));
          await mkdir(path.join(root, "nested"));
          await writeFile(path.join(root, "nested/generated.txt"), "generated\n", "utf8");
          await writeFile(secondPath, "CONCURRENT\n", "utf8");
        }
      }
    }),
    (error) => error.details.some((detail) => detail.includes("nested/generated.txt"))
  );
  assert.equal(await readFile(path.join(root, "nested/generated.txt"), "utf8"), "generated\n");
});

async function initializedProject() {
  const root = await createTempDirectory();
  const result = await invoke(["init", root, "--name", "Fixture Project"]);
  assert.equal(result.code, 0, result.stderr);
  return root;
}

async function createTempDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-native-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function invoke(args, cwd = process.cwd()) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(args, {
    cwd,
    stdout: (message) => { stdout += message; },
    stderr: (message) => { stderr += message; }
  });
  return { code, stdout, stderr };
}

async function mutateConfig(root, mutate) {
  const configPath = path.join(root, "ai-native.yaml");
  const config = YAML.parse(await readFile(configPath, "utf8"));
  mutate(config);
  await writeFile(configPath, YAML.stringify(config, { lineWidth: 0 }), "utf8");
}

function frontmatter(source) {
  const match = source.match(/^---\n([\s\S]*?)\n---\n/u);
  assert.ok(match, "expected YAML frontmatter");
  return YAML.parse(match[1]);
}

function twoActionRollbackPlan(root, createdPath, secondPath) {
  return {
    root,
    actions: [
      {
        kind: "create",
        mode: "managed",
        path: createdPath,
        before: null,
        after: "generated\n",
        backup: false
      },
      {
        kind: "update",
        mode: "managed",
        path: path.basename(secondPath),
        before: "before\n",
        after: "after\n",
        backup: false
      }
    ]
  };
}

async function contentSnapshot(root) {
  const snapshot = {};
  await walk(root, "", snapshot);
  return snapshot;
}

async function walk(root, relative, snapshot) {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walk(root, childRelative, snapshot);
    } else {
      snapshot[childRelative] = await readFile(path.join(root, childRelative), "utf8");
    }
  }
}
