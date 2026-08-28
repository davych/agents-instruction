import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createRunChangeset } from "../src/services/run-changeset.ts";

const execFile = promisify(execFileCallback);

test("CLOUD-AC-12/Tier C: changeset covers add/modify/delete/rename/binary without changing Git index or objects", async () => {
  const root = await createRepository();
  try {
    const baseRevision = await git(root, ["rev-parse", "HEAD"]);
    const indexPath = path.join(root, ".git", "index");
    await Promise.all([
      writeFile(path.join(root, "main.ts"), "export const value = 2;\n", "utf8"),
      writeFile(path.join(root, "added.ts"), "export const added = true;\n", "utf8"),
      writeFile(path.join(root, "binary.bin"), Buffer.from([0, 255, 1, 2, 3, 0, 4])),
      mkdir(path.join(root, "platform-control")),
      rename(path.join(root, "rename-me.ts"), path.join(root, "renamed.ts")),
      unlink(path.join(root, "delete-me.ts")),
    ]);
    await writeFile(path.join(root, "platform-control", "private.md"), "do not publish\n", "utf8");
    const statusBefore = await git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
    // Git status may refresh tracked-file stat data in the real index. Capture
    // the byte baseline immediately before the service call being isolated.
    const beforeIndex = await readFile(indexPath);
    const beforeObjects = await listTree(path.join(root, ".git", "objects"));

    const changeset = await createRunChangeset({
      runId: randomUUID(),
      workspaceRoot: root,
      baseRevision,
      excludedPaths: ["platform-control"],
    });

    assert.equal(changeset.baseRevision, baseRevision);
    assert.equal(changeset.headRevision, baseRevision);
    assert.equal(changeset.dirty, true);
    assert.equal(changeset.downloadAvailable, true);
    assert.equal(changeset.patchBytes, changeset.patch.length);
    assert.equal(
      changeset.patchSha256,
      createHash("sha256").update(changeset.patch).digest("hex"),
    );
    const byPath = new Map(changeset.files.map((file) => [file.path, file]));
    assert.equal(byPath.get("main.ts")?.status, "modified");
    assert.equal(byPath.get("added.ts")?.status, "added");
    assert.equal(byPath.get("delete-me.ts")?.status, "deleted");
    assert.deepEqual(byPath.get("renamed.ts"), {
      path: "renamed.ts",
      status: "renamed",
      oldPath: "rename-me.ts",
      binary: false,
    });
    assert.equal(byPath.get("binary.bin")?.status, "added");
    assert.equal(byPath.get("binary.bin")?.binary, true);
    assert.equal(byPath.has("platform-control/private.md"), false);
    assert.match(changeset.patch.toString("utf8"), /GIT binary patch/u);
    assert.doesNotMatch(changeset.patch.toString("utf8"), /platform-control|do not publish/u);
    assert.deepEqual(await readFile(indexPath), beforeIndex);
    assert.deepEqual(await listTree(path.join(root, ".git", "objects")), beforeObjects);
    assert.equal(
      await git(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
      statusBefore,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLOUD-AC-12/Tier C: oversized binary patch is withheld while bounded manifest remains available", async () => {
  const root = await createRepository();
  try {
    const baseRevision = await git(root, ["rev-parse", "HEAD"]);
    await writeFile(path.join(root, "large.txt"), "large change\n".repeat(2_000), "utf8");

    const changeset = await createRunChangeset({
      runId: randomUUID(),
      workspaceRoot: root,
      baseRevision,
      maxPatchBytes: 64,
    });

    assert.equal(changeset.dirty, true);
    assert.equal(changeset.files.some(({ path: filePath }) => filePath === "large.txt"), true);
    assert.equal(changeset.downloadAvailable, false);
    assert.equal(changeset.patchBytes, 0);
    assert.equal(changeset.patch.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-changeset-check-"));
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "user.name", "AI SDLC Check"]);
  await git(root, ["config", "user.email", "check@example.invalid"]);
  await Promise.all([
    writeFile(path.join(root, "main.ts"), "export const value = 1;\n", "utf8"),
    writeFile(path.join(root, "rename-me.ts"), "export const rename = true;\n", "utf8"),
    writeFile(path.join(root, "delete-me.ts"), "export const remove = true;\n", "utf8"),
  ]);
  await git(root, ["add", "--", "."]);
  await git(root, ["commit", "-m", "fixture"]);
  return root;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return stdout.trim();
}

async function listTree(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = path.posix.join(prefix.split(path.sep).join("/"), entry.name);
    if (entry.isDirectory()) result.push(...await listTree(root, relative));
    else result.push(relative);
  }
  return result;
}
