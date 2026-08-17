import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ProjectPathPolicy } from "../src/services/project-paths.ts";

test("a missing project path is checked through its nearest real ancestor", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-paths-"));
  const allowed = path.join(root, "allowed");
  const outside = path.join(root, "outside");
  await Promise.all([mkdir(allowed), mkdir(outside)]);
  await symlink(outside, path.join(allowed, "escape"));

  try {
    const policy = new ProjectPathPolicy([allowed]);
    await assert.rejects(
      () => policy.resolveProjectPath(path.join(allowed, "escape", "new-project"), true),
      /不在 .*允许范围/u
    );
    assert.equal(
      await policy.resolveProjectPath(path.join(allowed, "real", "new-project"), true),
      path.join(await realpath(allowed), "real", "new-project")
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
