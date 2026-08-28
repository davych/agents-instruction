import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  runCloudStartupPreflight,
  verifyManagedWorkspaceRoot,
} from "../src/services/cloud-startup-preflight.js";

test("Cloud startup verifies managed-root create/read/delete without leaving a sentinel", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-preflight-"));
  const root = path.join(parent, "managed");
  try {
    assert.equal(await verifyManagedWorkspaceRoot(root), await realpath(root));
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("Cloud startup rejects the repository example managed-root sentinel", async () => {
  await assert.rejects(
    () => verifyManagedWorkspaceRoot("/absolute/path/to/ai-sdlc-cloud-workspaces"),
    /示例路径/u,
  );
});

test("real Cloud startup verifies Docker version and the approved Worker label", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-preflight-"));
  const calls: string[][] = [];
  try {
    const result = await runCloudStartupPreflight({
      managedRoot: path.join(parent, "managed"),
      dockerBinary: "docker",
      workerImage: "ai-sdlc-worker:test",
      fakeCodex: false,
      dockerCommand: async (_binary, args) => {
        calls.push([...args]);
        if (args[0] === "version") return "27.5.1\n";
        if (args[0] === "image") return `sha256:${"a".repeat(64)}|true\n`;
        if (args[0] === "ps") return "";
        throw new Error(`unexpected Docker call: ${args.join(" ")}`);
      },
    });
    assert.equal(result.docker.checked, true);
    assert.equal(result.docker.serverVersion, "27.5.1");
    assert.equal(result.docker.workerImage, `sha256:${"a".repeat(64)}`);
    assert.match(result.docker.deploymentId, /^[a-f0-9]{32}$/u);
    assert.equal(result.docker.recoveredContainers, 0);
    assert.equal(calls.length, 3);
    assert.deepEqual(await readdir(result.managedRoot), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("real Cloud startup removes only orphan Workers from the same deployment", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-preflight-recovery-"));
  const calls: string[][] = [];
  try {
    const result = await runCloudStartupPreflight({
      managedRoot: path.join(parent, "managed"),
      workerImage: "ai-sdlc-worker:test",
      fakeCodex: false,
      dockerCommand: async (_binary, args) => {
        calls.push([...args]);
        if (args[0] === "version") return "27.5.1";
        if (args[0] === "image") return `sha256:${"b".repeat(64)}|true`;
        if (args[0] === "ps") return "a".repeat(64);
        if (args[0] === "rm") return "a".repeat(64);
        throw new Error("unexpected Docker call");
      },
    });
    assert.equal(result.docker.recoveredContainers, 1);
    const list = calls.find(([command]) => command === "ps");
    assert.ok(list);
    assert.ok(list.some((entry) => entry === `label=ai-sdlc.deployment=${result.docker.deploymentId}`));
    assert.deepEqual(calls.at(-1)?.slice(0, 2), ["rm", "--force"]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("real Cloud startup fails closed when Docker is skipped or its image is not approved", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-preflight-"));
  try {
    await assert.rejects(
      () => runCloudStartupPreflight({
        managedRoot: path.join(parent, "skip"),
        workerImage: "ai-sdlc-worker:test",
        fakeCodex: false,
        skipDocker: true,
      }),
      /不允许跳过/u,
    );
    await assert.rejects(
      () => runCloudStartupPreflight({
        managedRoot: path.join(parent, "image"),
        workerImage: "ai-sdlc-worker:test",
        fakeCodex: false,
        dockerCommand: async (_binary, args) => args[0] === "version"
          ? "27.5.1"
          : `sha256:${"a".repeat(64)}|false`,
      }),
      /缺少 com\.ai-sdlc\.worker=true/u,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("fake Cloud mode may explicitly skip Docker but still checks the managed root", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-preflight-"));
  try {
    const root = path.join(parent, "managed");
    const result = await runCloudStartupPreflight({
      managedRoot: root,
      fakeCodex: true,
      skipDocker: true,
    });
    assert.equal(result.docker.checked, false);
    await assert.rejects(() => readFile(path.join(root, ".ai-sdlc-startup")), /ENOENT/u);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
