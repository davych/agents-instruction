import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { AgentSandboxDto } from "@ai-sdlc/contracts";
import type pg from "pg";

import {
  PgWorkflowStore,
  type ManagedWorkspaceRecord,
  type RuntimeProject,
} from "../src/db/store.ts";
import { buildApp } from "../src/app.ts";
import { CloudProjectService } from "../src/services/cloud-project-service.ts";
import type { GitBroker } from "../src/services/git-broker.ts";
import { createGitCredentialRegistryFromEnv } from "../src/services/git-credential-registry.ts";
import { RepositoryPolicy } from "../src/services/repository-policy.ts";

const oldRevision = "a".repeat(40);
const currentRevision = "b".repeat(40);
const now = "2026-08-28T10:00:00.000Z";

test("CHAT-AC-03/05/18/Tier A: Cloud build wires the real Chat-first catalogs and filtered Session list without injected test ports", async () => {
  const managedRoot = await mkdtemp(path.join(os.tmpdir(), "chat-first-default-ports-"));
  const projectId = crypto.randomUUID();
  const pool = {
    query: async () => ({ rows: [] }),
  } as unknown as pg.Pool;
  const policy = new RepositoryPolicy({
    allowedOrigins: ["https://git.example.test"],
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
  });
  try {
    const app = await buildApp({
      pool,
      fakeCodex: true,
      cloud: {
        managedRoot,
        repositoryPolicy: policy,
        credentials: createGitCredentialRegistryFromEnv({}),
      },
    });
    try {
      const blueprints = await app.inject({ method: "GET", url: "/api/sandbox-blueprints" });
      assert.equal(blueprints.statusCode, 200);
      assert.equal(JSON.parse(blueprints.body).blueprints[0]?.configured, true);

      const mcp = await app.inject({ method: "GET", url: "/api/mcp/installations" });
      assert.equal(mcp.statusCode, 200);
      assert.deepEqual(JSON.parse(mcp.body).installations, []);

      const sessions = await app.inject({
        method: "GET",
        url: `/api/agent-sessions?projectId=${projectId}`,
      });
      assert.equal(sessions.statusCode, 200);
      assert.deepEqual(JSON.parse(sessions.body).sessions, []);
    } finally {
      await app.close();
    }
  } finally {
    await rm(managedRoot, { recursive: true, force: true });
  }
});

test("CHAT-AC-16/Tier A: publishing a new source snapshot stales older ready DeepWiki in the same transaction", async () => {
  const projectId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const knowledgeSnapshotId = crypto.randomUUID();
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  const projectRow = runtimeProjectRow(projectId, currentRevision);
  const client = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql.includes("SELECT * FROM projects") && sql.includes("FOR UPDATE")) {
        return { rows: [projectRow] };
      }
      if (sql.includes("SELECT * FROM managed_workspaces")) {
        return { rows: [{ id: workspaceId, root_path: "/managed/new-snapshot" }] };
      }
      if (sql.includes("SELECT id FROM knowledge_snapshots")) {
        return { rows: [{ id: knowledgeSnapshotId }] };
      }
      if (sql.includes("UPDATE projects") && sql.includes("RETURNING *")) {
        return { rows: [projectRow] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const store = new PgWorkflowStore({
    connect: async () => client,
  } as unknown as pg.Pool);

  await store.activateRemoteProjectSnapshot({
    projectId,
    workspaceId,
    knowledgeSnapshotId,
    revision: currentRevision,
    configPath: "/managed/control/ai-native.yaml",
    definitionVersion: "c".repeat(64),
  });

  const projectPublishIndex = queries.findIndex(({ sql }) => (
    sql.includes("UPDATE projects") && sql.includes("RETURNING *")
  ));
  const staleIndex = queries.findIndex(({ sql }) => sql.includes("UPDATE deepwiki_generations"));
  const commitIndex = queries.findIndex(({ sql }) => sql === "COMMIT");
  assert.ok(projectPublishIndex >= 0, "the source snapshot must be published");
  assert.ok(staleIndex > projectPublishIndex, "stale marking must accompany the published revision");
  assert.ok(commitIndex > staleIndex, "source publish and stale marking must commit atomically");
  assert.match(
    queries[staleIndex]!.sql,
    /status = 'ready' AND revision <> \$2/u,
    "only older ready generations become stale; no model regeneration is scheduled",
  );
  assert.deepEqual(queries[staleIndex]!.values, [projectId, currentRevision]);
});

test("CHAT-AC-10/16/Tier A: an old Session restores its Sandbox from the pinned historical revision after repository sync", async () => {
  const managedRoot = await mkdtemp(path.join(os.tmpdir(), "chat-first-history-sandbox-"));
  const projectId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const sourceWorkspaceId = crypto.randomUUID();
  const sandboxWorkspaceId = crypto.randomUUID();
  const project = runtimeProject(projectId, currentRevision, managedRoot);
  const sourceWorkspace: ManagedWorkspaceRecord = {
    id: sourceWorkspaceId,
    projectId,
    purpose: "project_snapshot",
    rootPath: path.join(managedRoot, "historical-source"),
    state: "ready",
    revision: oldRevision,
    active: false,
    generation: 1,
    errorMessage: null,
    expiresAt: null,
    createdAt: now,
    updatedAt: now,
  };
  let materializedRevision: string | undefined;
  let sandboxInput: {
    sessionId: string;
    projectId: string;
    workspaceId: string;
    sourceRevision: string;
  } | undefined;
  const store = {
    getAgentSandbox: async () => null,
    getProject: async () => project,
    getKnowledgeWorkspaceByRevision: async (requestedProjectId: string, revision: string) => {
      assert.equal(requestedProjectId, projectId);
      assert.equal(revision, oldRevision, "the Session revision, not current project revision, owns recovery");
      return sourceWorkspace;
    },
    createManagedWorkspace: async (input: {
      id: string;
      projectId: string;
      purpose: "sandbox";
      rootPath: string;
    }) => ({
      id: sandboxWorkspaceId,
      projectId: input.projectId,
      purpose: input.purpose,
      rootPath: input.rootPath,
      state: "provisioning" as const,
      revision: null,
      active: false,
      generation: 1,
      errorMessage: null,
      expiresAt: null,
      createdAt: now,
      updatedAt: now,
    }),
    markManagedWorkspaceReady: async (_workspaceId: string, revision: string) => ({
      id: sandboxWorkspaceId,
      projectId,
      purpose: "sandbox" as const,
      rootPath: path.join(managedRoot, "sandbox"),
      state: "ready" as const,
      revision,
      active: false,
      generation: 1,
      errorMessage: null,
      expiresAt: null,
      createdAt: now,
      updatedAt: now,
    }),
    createAgentSandbox: async (input: {
      sessionId: string;
      projectId: string;
      workspaceId: string;
      sourceRevision: string;
    }) => {
      sandboxInput = input;
      return sandboxDto(sessionId, projectId, oldRevision);
    },
  } as unknown as PgWorkflowStore;
  const gitBroker = {
    materializeFromSnapshot: async (input: { revision: string; destination: string }) => {
      materializedRevision = input.revision;
      return {
        rootPath: input.destination,
        revision: input.revision,
        fileCount: 1,
        totalBytes: 1,
      };
    },
  } as unknown as GitBroker;
  const policy = new RepositoryPolicy({
    allowedOrigins: ["https://git.example.test"],
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
  });

  try {
    const service = await CloudProjectService.create({
      store,
      managedRoot,
      repositoryPolicy: policy,
      credentials: createGitCredentialRegistryFromEnv({}),
      gitBroker,
    });
    const result = await service.prepareAgentSandbox({
      sessionId,
      projectId,
      sourceRevision: oldRevision,
    });

    assert.equal(project.currentRevision, currentRevision, "the repository has already advanced");
    assert.equal(materializedRevision, oldRevision);
    assert.deepEqual(sandboxInput, {
      sessionId,
      projectId,
      workspaceId: sandboxWorkspaceId,
      sourceRevision: oldRevision,
    });
    assert.equal(result.sandbox.sourceRevision, oldRevision);
  } finally {
    await rm(managedRoot, { recursive: true, force: true });
  }
});

function runtimeProject(id: string, revision: string, managedRoot: string): RuntimeProject {
  return {
    id,
    name: "Remote project",
    summary: "Cloud project",
    rootPath: path.join(managedRoot, "current-source"),
    configPath: path.join(managedRoot, "control", "ai-native.yaml"),
    sourceKind: "remote-git",
    repositoryUrl: "https://git.example.test/team/repo.git",
    repositoryHost: "git.example.test",
    requestedRef: "main",
    credentialProfileId: null,
    repositoryState: "ready",
    currentRevision: revision,
    definitionMode: "managed",
    definitionVersion: "c".repeat(64),
    operation: null,
    lastSyncedAt: now,
    repositoryErrorMessage: null,
    runCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function runtimeProjectRow(id: string, revision: string): Record<string, unknown> {
  return {
    id,
    name: "Remote project",
    summary: "Cloud project",
    root_path: "/managed/new-snapshot",
    config_path: "/managed/control/ai-native.yaml",
    source_kind: "remote_git",
    repository_url: "https://git.example.test/team/repo.git",
    repository_host: "git.example.test",
    requested_ref: "main",
    credential_profile_id: null,
    repository_state: "ready",
    active_revision: revision,
    definition_mode: "managed",
    definition_version: "c".repeat(64),
    operation_id: null,
    last_synced_at: new Date(now),
    repository_error_message: null,
    run_count: 0,
    created_at: new Date(now),
    updated_at: new Date(now),
  };
}

function sandboxDto(sessionId: string, projectId: string, revision: string): AgentSandboxDto {
  return {
    id: crypto.randomUUID(),
    sessionId,
    projectId,
    sourceRevision: revision,
    blueprintId: "default",
    blueprintVersion: "1",
    state: "ready",
    expiresAt: null,
    createdAt: now,
    updatedAt: now,
  };
}
