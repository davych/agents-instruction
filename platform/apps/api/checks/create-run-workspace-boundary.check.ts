import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ProjectDto, WorkflowRunDto } from "@ai-sdlc/contracts";

import type {
  CreateRunPersistence,
  PgWorkflowStore,
  RunPersistenceSnapshot,
} from "../src/db/store.ts";
import { AppError } from "../src/domain/errors.ts";
import { CodexTerminalRunner } from "../src/services/codex-runner.ts";
import { initializeCodexProject } from "../src/services/project-initializer.ts";
import { ProjectPathPolicy } from "../src/services/project-paths.ts";
import { WorkflowService } from "../src/services/workflow-service.ts";

class CreateRunStore {
  readonly calls: CreateRunPersistence[] = [];

  constructor(readonly project: ProjectDto) {}

  async getProject(projectId: string): Promise<ProjectDto> {
    assert.equal(projectId, this.project.id);
    return this.project;
  }

  async createRun(
    _projectId: string,
    _title: string,
    _objective: string,
    persistence: CreateRunPersistence,
  ): Promise<WorkflowRunDto> {
    this.calls.push(persistence);
    const now = new Date().toISOString();
    return {
      id: persistence.runId,
      projectId: this.project.id,
      title: "unexpected",
      objective: "unexpected",
      changeContract: persistence.changeContract,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
  }
}

class IndeterminateCreateRunStore extends CreateRunStore {
  private snapshot: RunPersistenceSnapshot | null = null;

  constructor(
    project: ProjectDto,
    private readonly confirmation: "committed" | "post-commit-absent" | "unavailable" | "precommit",
  ) {
    super(project);
  }

  override async createRun(
    projectId: string,
    title: string,
    objective: string,
    persistence: CreateRunPersistence,
  ): Promise<WorkflowRunDto> {
    this.calls.push(persistence);
    const now = new Date().toISOString();
    this.snapshot = {
      run: {
        id: persistence.runId,
        projectId,
        title,
        objective,
        changeContract: persistence.changeContract,
        status: "active",
        baseRevision: persistence.baseRevision ?? null,
        definitionVersion: persistence.definitionVersion ?? null,
        workspaceState: persistence.workspaceId ? "busy" : null,
        createdAt: now,
        updatedAt: now,
      },
      artifactPaths: persistence.artifactPaths,
      workspaceId: persistence.workspaceId ?? null,
      agentSessionRun: persistence.agentSessionRun
        ? {
            ...persistence.agentSessionRun,
            workflowRunId: persistence.runId,
            createdAt: now,
          }
        : null,
    };
    if (this.confirmation === "precommit") {
      throw new Error("deterministic failure before COMMIT");
    }
    throw new AppError(
      "Run COMMIT 结果无法确认",
      503,
      "RUN_COMMIT_OUTCOME_UNKNOWN",
      { runId: persistence.runId },
    );
  }

  async findRunPersistence(runId: string): Promise<RunPersistenceSnapshot | null> {
    assert.equal(runId, this.calls.at(-1)?.runId);
    if (this.confirmation === "unavailable") throw new Error("database unavailable");
    if (this.confirmation === "post-commit-absent") return null;
    return this.snapshot;
  }
}

test("AC5/Tier A: createRun rejects an output-parent symlink before creating any external workspace state", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-create-run-boundary-"));
  const requestedRoot = path.join(parent, "project");
  const outside = path.join(parent, "outside");
  try {
    await Promise.all([
      initializeCodexProject(requestedRoot, "Workspace boundary", "Tier A symlink fixture"),
      mkdir(outside),
    ]);
    const rootPath = await realpath(requestedRoot);
    await symlink(outside, path.join(rootPath, "docs"));
    const now = new Date().toISOString();
    const project: ProjectDto = {
      id: randomUUID(),
      name: "Workspace boundary",
      summary: "Tier A symlink fixture",
      rootPath,
      configPath: path.join(rootPath, "ai-native.yaml"),
      runCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    const store = new CreateRunStore(project);
    const service = new WorkflowService(
      store as unknown as PgWorkflowStore,
      new ProjectPathPolicy([parent]),
      new CodexTerminalRunner({ fake: true }),
    );

    await assert.rejects(
      () => service.createRun(project.id, {
        title: "外部目录不能写入",
        objective: "拒绝 outputRoot 祖先符号链接。",
      }),
      /允许范围|symbolic|symlink|链接|路径/i,
    );
    assert.equal(store.calls.length, 0, "persistence must not begin after path validation fails");
    assert.deepEqual(await readdir(outside), [], "an external symlink target must remain untouched");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

for (const scenario of [
  { confirmation: "committed" as const, expectedCode: null, filePresent: true },
  {
    confirmation: "post-commit-absent" as const,
    expectedCode: "RUN_CREATE_OUTCOME_UNKNOWN",
    filePresent: true,
  },
  { confirmation: "unavailable" as const, expectedCode: "RUN_CREATE_OUTCOME_UNKNOWN", filePresent: true },
  { confirmation: "precommit" as const, expectedCode: "original", filePresent: false },
]) {
  test(`createRun COMMIT confirmation ${scenario.confirmation} preserves only potentially committed Change Contracts`, async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-create-run-commit-"));
    const requestedRoot = path.join(parent, "project");
    try {
      await initializeCodexProject(requestedRoot, "Commit outcome", "Indeterminate COMMIT fixture");
      const rootPath = await realpath(requestedRoot);
      const now = new Date().toISOString();
      const project: ProjectDto = {
        id: randomUUID(),
        name: "Commit outcome",
        summary: "Indeterminate COMMIT fixture",
        rootPath,
        configPath: path.join(rootPath, "ai-native.yaml"),
        runCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      const store = new IndeterminateCreateRunStore(project, scenario.confirmation);
      const service = new WorkflowService(
        store as unknown as PgWorkflowStore,
        new ProjectPathPolicy([parent]),
        new CodexTerminalRunner({ fake: true }),
      );

      const operation = service.createRun(project.id, {
        title: `Commit ${scenario.confirmation}`,
        objective: "Never delete state that may already be committed.",
      });
      if (scenario.expectedCode === null) {
        const run = await operation;
        assert.equal(run.id, store.calls[0]?.runId);
      } else if (scenario.expectedCode === "original") {
        await assert.rejects(operation, /deterministic failure before COMMIT/u);
      } else {
        await assert.rejects(
          operation,
          (error: unknown) => (error as { code?: string }).code === scenario.expectedCode,
        );
      }

      const relativePath = store.calls[0]?.changeContractArtifact?.filePath;
      assert.ok(relativePath);
      const absolutePath = path.join(rootPath, relativePath);
      if (scenario.filePresent) {
        assert.match(await readFile(absolutePath, "utf8"), /Change Contract/u);
      } else {
        await assert.rejects(
          () => readFile(absolutePath, "utf8"),
          (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
        );
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
}
