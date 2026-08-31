import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { initializeCodexProject } from "../src/services/project-initializer.ts";
import { loadDefinition } from "../src/services/definition-loader.ts";

test("CLOUD-AC-05/Tier C: a plain source repository loads a separate managed control pack", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-control-root-"));
  const sourceRoot = path.join(parent, "source");
  const controlRoot = path.join(parent, "control");
  try {
    await Promise.all([
      initializeCodexProject(controlRoot, "Managed control", "Cloud control pack"),
      mkdir(sourceRoot),
    ]);

    const definition = await loadDefinition({ sourceRoot, controlRoot });

    assert.equal(definition.sourceRoot, sourceRoot);
    assert.equal(definition.controlRoot, controlRoot);
    assert.equal(definition.configPath, path.join(controlRoot, "ai-native.yaml"));
    assert.equal(definition.outputRoot, path.join(sourceRoot, "docs"));
    assert.ok(definition.artifacts.length > 0);
    assert.ok(definition.artifacts.every(({ absolutePath }) => (
      absolutePath === sourceRoot || absolutePath.startsWith(`${sourceRoot}${path.sep}`)
    )));
    assert.ok(definition.artifacts.every(({ absolutePath }) => !absolutePath.startsWith(controlRoot)));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("CLOUD-AC-14/Tier C: legacy local definition loading keeps source and control roots together", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-local-definition-"));
  try {
    await initializeCodexProject(root, "Legacy local", "Compatibility fixture");
    const definition = await loadDefinition(root);
    assert.equal(definition.sourceRoot, root);
    assert.equal(definition.controlRoot, root);
    assert.equal(definition.configPath, path.join(root, "ai-native.yaml"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLOUD-AC-05/Tier C: configPath cannot escape the managed control root", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-control-config-"));
  const sourceRoot = path.join(parent, "source");
  const controlRoot = path.join(parent, "control");
  try {
    await Promise.all([
      initializeCodexProject(controlRoot, "Managed control", "Config boundary"),
      mkdir(sourceRoot),
    ]);
    await assert.rejects(
      () => loadDefinition({
        sourceRoot,
        controlRoot,
        configPath: path.join(parent, "outside.yaml"),
      }),
      (error: unknown) => (
        (error as { code?: string }).code === "UNSAFE_CONFIG_PATH"
      ),
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
