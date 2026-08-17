import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  prepareArtifactRevision,
  readArtifactContent,
  withProtectedArtifactPaths,
} from "../src/services/artifact-workspace.ts";

const roots: string[] = [];
test.after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

test("a human file revision is materialized exactly and can be committed", async () => {
  const root = await temporaryProject();
  const target = path.join(root, "docs", "prd.md");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "# Original\n", "utf8");

  const prepared = await prepareArtifactRevision({
    projectRoot: root,
    absolutePath: target,
    previousContentHash: hash("# Original\n"),
    nextContent: "# Human revision\n",
    maxBytes: 2_000_000,
  });
  assert.equal(await readFile(target, "utf8"), "# Human revision\n");
  assert.equal(prepared.contentHash, hash("# Human revision\n"));
  await prepared.commit();
  assert.equal(await readFile(target, "utf8"), "# Human revision\n");
});

test("a failed DB save can roll a materialized file back", async () => {
  const root = await temporaryProject();
  const target = path.join(root, "docs", "spec.md");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "before", "utf8");

  const prepared = await prepareArtifactRevision({
    projectRoot: root,
    absolutePath: target,
    previousContentHash: hash("before"),
    nextContent: "after",
    maxBytes: 2_000_000,
  });
  await prepared.rollback();
  assert.equal(await readFile(target, "utf8"), "before");
});

test("directory revisions preserve the registered file list and write each section", async () => {
  const root = await temporaryProject();
  const target = path.join(root, "docs", "stories");
  await mkdir(path.join(target, "checkout"), { recursive: true });
  await writeFile(path.join(target, "US-001.md"), "first", "utf8");
  await writeFile(path.join(target, "checkout", "US-002.md"), "second", "utf8");
  const before = await readArtifactContent(target, 2_000_000);
  const after = before.replace("first", "human first").replace("second", "human second");

  const prepared = await prepareArtifactRevision({
    projectRoot: root,
    absolutePath: target,
    previousContentHash: hash(before),
    nextContent: after,
    maxBytes: 2_000_000,
  });
  await prepared.commit();

  assert.equal(await readFile(path.join(target, "US-001.md"), "utf8"), "human first");
  assert.equal(await readFile(path.join(target, "checkout", "US-002.md"), "utf8"), "human second");
  assert.equal(await readArtifactContent(target, 2_000_000), after);
});

test("directory revisions reject removed file headers without touching the workspace", async () => {
  const root = await temporaryProject();
  const target = path.join(root, "docs", "adrs");
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "ADR-001.md"), "decision", "utf8");
  const before = await readArtifactContent(target, 2_000_000);

  await assert.rejects(
    () => prepareArtifactRevision({
      projectRoot: root,
      absolutePath: target,
      previousContentHash: hash(before),
      nextContent: "decision without its file header",
      maxBytes: 2_000_000,
    }),
    (error: unknown) => (error as { code?: string }).code === "ARTIFACT_DIRECTORY_FORMAT_INVALID",
  );
  assert.equal(await readArtifactContent(target, 2_000_000), before);
});

test("a partial rerun restores unselected bytes before reporting a scope violation", async () => {
  const root = await temporaryProject();
  const target = path.join(root, "docs", "unselected.md");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "keep me", "utf8");

  await assert.rejects(
    () => withProtectedArtifactPaths(
      root,
      [{ id: "unselected", absolutePath: target }],
      2_000_000,
      async () => {
        await writeFile(target, "bad mutation", "utf8");
        return 1;
      },
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "UNSELECTED_OUTPUTS_CHANGED");
      assert.equal((error as { details?: { restored?: boolean } }).details?.restored, true);
      return true;
    },
  );
  assert.equal(await readFile(target, "utf8"), "keep me");
});

test("a failed partial rerun restores both changed and newly created unselected outputs", async () => {
  const root = await temporaryProject();
  const existing = path.join(root, "docs", "baseline.md");
  const absent = path.join(root, "docs", "optional.md");
  await mkdir(path.dirname(existing), { recursive: true });
  await writeFile(existing, "baseline", "utf8");
  const originalError = new Error("runner exited 7");

  await assert.rejects(
    () => withProtectedArtifactPaths(
      root,
      [
        { id: "baseline", absolutePath: existing },
        { id: "optional", absolutePath: absent },
      ],
      2_000_000,
      async () => {
        await writeFile(existing, "mutated", "utf8");
        await writeFile(absent, "created", "utf8");
        throw originalError;
      },
    ),
    (error: unknown) => error === originalError,
  );
  assert.equal(await readFile(existing, "utf8"), "baseline");
  await assert.rejects(() => readFile(absent, "utf8"), /ENOENT/u);
});

async function temporaryProject(): Promise<string> {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-"));
  roots.push(root);
  return root;
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
