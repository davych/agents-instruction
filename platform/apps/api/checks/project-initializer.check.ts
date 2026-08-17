import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { initializeCodexProject } from "../src/services/project-initializer.ts";

test("the web initializer reuses the existing CLI and writes a Codex project", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-init-"));
  const target = path.join(parent, "sample");
  try {
    await initializeCodexProject(target, "Sample", "Line one\nLine two");
    const config = await readFile(path.join(target, "ai-native.yaml"), "utf8");
    assert.match(config, /name: "Sample"/u);
    assert.match(config, /summary: "Line one Line two"/u);
    assert.match(config, /client: "codex"/u);
    await readFile(path.join(target, ".codex", "agents", "pm-ba.toml"), "utf8");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
