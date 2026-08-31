import assert from "node:assert/strict";
import test from "node:test";

import {
  PHASE_IDS,
  changesetSchema,
  createAskThreadSchema,
  createProjectSchema,
  publicProjectSchema,
  sendAskThreadMessageSchema,
} from "../src/index.ts";

const sha = "a".repeat(40);
const now = "2026-08-27T10:00:00.000Z";

test("CLOUD-AC-01/02: project creation is a strict remote-or-legacy union", () => {
  assert.equal(createProjectSchema.safeParse({
    sourceKind: "remote-git",
    name: "Cloud project",
    summary: "Server managed",
    repositoryUrl: "https://git.example.test/team/repository.git",
    requestedRef: "refs/heads/main",
    credentialProfileId: "git-example",
  }).success, true);
  assert.equal(createProjectSchema.safeParse({
    name: "Existing local project",
    summary: "Compatibility only",
    rootPath: "/srv/existing",
    initialize: false,
    agentClient: "codex",
  }).success, true);

  for (const invalid of [
    {
      sourceKind: "remote-git",
      name: "No local path override",
      repositoryUrl: "https://git.example.test/repository.git",
      rootPath: "/etc",
    },
    {
      sourceKind: "remote-git",
      name: "No browser credential",
      repositoryUrl: "https://token@git.example.test/repository.git",
      token: "secret",
    },
    {
      sourceKind: "remote-git",
      name: "HTTPS only",
      repositoryUrl: "ssh://git@git.example.test/repository.git",
    },
    {
      sourceKind: "remote-git",
      name: "Safe ref only",
      repositoryUrl: "https://git.example.test/repository.git",
      requestedRef: "--upload-pack=evil",
    },
  ]) {
    assert.equal(createProjectSchema.safeParse(invalid).success, false);
  }
});

test("CLOUD-AC-07/08/09: public project is strict, revision-bound, and cannot expose server paths or secrets", () => {
  const project = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Cloud project",
    summary: "Server managed",
    sourceKind: "remote-git",
    repository: {
      url: "https://git.example.test/team/repository.git",
      host: "git.example.test",
      requestedRef: "refs/heads/main",
      credentialProfile: {
        id: "git-example",
        label: "Example Git",
        host: "git.example.test",
        available: true,
      },
      activeSnapshot: { revision: sha, resolvedRef: "refs/heads/main", indexedAt: now },
      operation: null,
    },
    knowledge: {
      id: "22222222-2222-4222-8222-222222222222",
      status: "ready",
      revision: sha,
      indexedAt: now,
      summary: {
        fileCount: 1,
        totalBytes: 10,
        languages: [{ language: "TypeScript", files: 1, bytes: 10 }],
        entryPoints: [],
        documents: [],
        tests: [],
        builds: [],
        keyPaths: [],
        truncated: false,
      },
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    },
    availableActions: { ask: true, createRun: true, sync: true },
    runCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  assert.equal(publicProjectSchema.safeParse(project).success, true);
  assert.equal(publicProjectSchema.safeParse({ ...project, rootPath: "/srv/private" }).success, false);
  assert.equal(publicProjectSchema.safeParse({
    ...project,
    repository: { ...project.repository, credentialToken: "secret" },
  }).success, false);
  assert.equal(publicProjectSchema.safeParse({
    ...project,
    knowledge: { ...project.knowledge, revision: "b".repeat(40) },
  }).success, true, "schema allows history; mapper/service owns active-revision equality");
});

test("CLOUD-AC-13/14: Ask thread inputs are server-owned and changeset output is bounded/strict", () => {
  assert.equal(createAskThreadSchema.safeParse({ providerId: "openai" }).success, true);
  assert.equal(createAskThreadSchema.safeParse({
    providerId: "openai",
    sourceRevision: sha,
  }).success, false);
  assert.equal(sendAskThreadMessageSchema.safeParse({
    question: "Where is the entry point?",
    expectedRevision: `git:${sha}:clean`,
  }).success, true);
  assert.equal(changesetSchema.safeParse({
    runId: "33333333-3333-4333-8333-333333333333",
    baseRevision: sha,
    headRevision: sha,
    dirty: true,
    files: [{ path: "src/main.ts", status: "modified", oldPath: null, binary: false }],
    patchBytes: 42,
    patchSha256: "c".repeat(64),
    generatedAt: now,
    downloadAvailable: true,
  }).success, true);
  assert.equal(changesetSchema.safeParse({
    runId: "33333333-3333-4333-8333-333333333333",
    baseRevision: sha,
    headRevision: sha,
    dirty: true,
    files: [{ path: "../secret", status: "modified", oldPath: null, binary: false }],
    patchBytes: 42,
    patchSha256: "c".repeat(64),
    generatedAt: now,
    downloadAvailable: true,
  }).success, false);
  assert.equal(changesetSchema.safeParse({
    runId: "33333333-3333-4333-8333-333333333333",
    baseRevision: sha,
    headRevision: sha,
    dirty: false,
    files: [],
    patchBytes: 1,
    patchSha256: "c".repeat(64),
    generatedAt: now,
    downloadAvailable: true,
  }).success, false, "clean manifests cannot claim a patch");
  assert.equal(changesetSchema.safeParse({
    runId: "33333333-3333-4333-8333-333333333333",
    baseRevision: sha,
    headRevision: sha,
    dirty: true,
    files: [],
    patchBytes: 0,
    patchSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    generatedAt: now,
    downloadAvailable: false,
  }).success, false, "dirty manifests cannot omit the file list");
});

test("CLOUD-AC-18: cloud contracts do not change the canonical six-stage workflow", () => {
  assert.deepEqual(PHASE_IDS, [
    "discovery",
    "design",
    "architecture",
    "implementation",
    "verification",
    "release",
  ]);
});
