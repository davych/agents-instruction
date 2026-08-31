import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { AskProjectInput, ProjectDto } from "@ai-sdlc/contracts";

import { AskService } from "../src/services/ask/ask-service.js";
import { CloudProjectService } from "../src/services/cloud-project-service.js";
import { GitBroker } from "../src/services/git-broker.js";
import { createGitCredentialRegistryFromEnv } from "../src/services/git-credential-registry.js";
import { presentAppError } from "../src/services/http-error-presenter.js";
import { RepositoryPolicy } from "../src/services/repository-policy.js";
import { AppError } from "../src/domain/errors.js";

const question = {
  providerId: "openai",
  question: "这个项目如何启动？",
} satisfies AskProjectInput;

test("Cloud remote project rejects the stateless Ask surface before reading a host path", async () => {
  const project = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "remote",
    summary: "remote",
    rootPath: "/private/PATH_MARKER/project",
    configPath: "/private/PATH_MARKER/control/ai-native.yaml",
    sourceKind: "remote-git",
    runCount: 0,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  } satisfies ProjectDto;
  const paths = {
    resolveProjectPath: async () => {
      throw new Error("remote stateless Ask must not resolve a host path");
    },
  };
  const service = new AskService(
    { getProject: async () => project },
    paths as never,
    {} as never,
  );

  await assert.rejects(
    () => service.answer(project.id, question),
    (error: unknown) => (error as { code?: string }).code === "ASK_THREAD_REQUIRED",
  );
});

test("Cloud Control Pack initialization publishes one fixed failure without CLI path or secret output", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-init-public-"));
  const cliPath = path.join(parent, "failing-cli.mjs");
  const pathMarker = path.join(parent, "PATH_MARKER");
  const tokenMarker = "TOKEN_MARKER_secret";
  try {
    await writeFile(
      cliPath,
      `export async function run() { throw new Error(${JSON.stringify(`${pathMarker} ${tokenMarker}`)}); }\n`,
      "utf8",
    );
    const credentials = createGitCredentialRegistryFromEnv({});
    const policy = new RepositoryPolicy({
      allowedOrigins: ["https://git.example.test"],
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    });
    const service = await CloudProjectService.create({
      store: {
        createRemoteProject: async () => {
          throw new Error("persistence must not run after initializer failure");
        },
      } as never,
      managedRoot: path.join(parent, "managed"),
      repositoryPolicy: policy,
      credentials,
      gitBroker: new GitBroker({ policy, credentials }),
      cliPath,
    });
    let caught: unknown;
    try {
      await service.createRemoteProject({
        sourceKind: "remote-git",
        name: "safe-project",
        summary: "safe summary",
        repositoryUrl: "https://git.example.test/team/repository.git",
        requestedRef: "HEAD",
        credentialProfileId: null,
      });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof AppError);
    assert.equal(caught.code, "CONTROL_PACK_INITIALIZATION_FAILED");
    const response = JSON.stringify(presentAppError(caught));
    assert.doesNotMatch(response, /PATH_MARKER|TOKEN_MARKER/u);
    assert.equal(response.includes(parent), false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("CLOUD-AC-07/15: ready DeepWiki routes publish only the strict public snapshot DTO", async () => {
  const managedRoot = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-knowledge-public-"));
  const projectId = "11111111-1111-4111-8111-111111111111";
  const knowledgeId = "22222222-2222-4222-8222-222222222222";
  const workspaceId = "33333333-3333-4333-8333-333333333333";
  const revision = "a".repeat(40);
  const now = new Date("2026-08-28T00:00:00.000Z");
  const internalMarker = "INTERNAL_DEEPWIKI_INDEX_MUST_NOT_LEAK";
  const projectRow = {
    id: projectId,
    name: "Public knowledge fixture",
    summary: "Ready remote project",
    root_path: path.join(managedRoot, "projects", projectId, "snapshots", workspaceId),
    config_path: path.join(managedRoot, "projects", projectId, "control", "ai-native.yaml"),
    source_kind: "remote_git",
    repository_url: "https://git.example.test/team/repository.git",
    repository_host: "git.example.test",
    requested_ref: "refs/heads/main",
    credential_profile_id: null,
    repository_state: "ready",
    active_revision: revision,
    definition_mode: "managed",
    definition_version: "control-v1",
    last_synced_at: now,
    run_count: 0,
    created_at: now,
    updated_at: now,
  };
  const knowledgeRow = {
    id: knowledgeId,
    project_id: projectId,
    workspace_id: workspaceId,
    status: "ready",
    revision,
    indexed_at: now,
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
    manifest_hash: "b".repeat(64),
    index_data: { internalMarker, files: [{ path: "/private/server/path" }] },
    error_message: null,
    created_at: now,
    updated_at: now,
  };
  const pool = {
    query: async (query: string) => {
      if (query.includes("JOIN knowledge_snapshots ks")) return { rows: [knowledgeRow] };
      if (query.includes("FROM projects p") && query.includes("LEFT JOIN workflow_runs")) {
        return { rows: [projectRow] };
      }
      if (query.includes("SELECT * FROM projects WHERE id = $1")) {
        return { rows: [projectRow] };
      }
      return { rows: [] };
    },
  } as never;
  const policy = new RepositoryPolicy({
    allowedOrigins: ["https://git.example.test"],
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
  });
  const app = await (await import("../src/app.js")).buildApp({
    pool,
    fakeCodex: true,
    cloud: {
      managedRoot,
      repositoryPolicy: policy,
      credentials: createGitCredentialRegistryFromEnv({}),
    },
  });
  try {
    const list = await app.inject({ method: "GET", url: "/api/projects" });
    assert.equal(list.statusCode, 200);
    const listedKnowledge = list.json().projects[0].knowledge as Record<string, unknown>;
    assert.deepEqual(Object.keys(listedKnowledge).sort(), [
      "createdAt", "errorMessage", "id", "indexedAt", "revision", "status", "summary", "updatedAt",
    ]);

    const knowledge = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/knowledge`,
    });
    assert.equal(knowledge.statusCode, 200);
    assert.deepEqual(knowledge.json().knowledge, listedKnowledge);
    for (const body of [list.body, knowledge.body]) {
      assert.doesNotMatch(body, /projectId|workspaceId|manifestHash|indexData/u);
      assert.doesNotMatch(body, new RegExp(`${internalMarker}|${workspaceId}|private/server/path`, "u"));
    }
  } finally {
    await app.close();
    await rm(managedRoot, { recursive: true, force: true });
  }
});
