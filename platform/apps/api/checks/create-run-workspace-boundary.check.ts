import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ProjectDto, WorkflowRunDto } from "@ai-sdlc/contracts";

import type { CreateRunPersistence, PgWorkflowStore } from "../src/db/store.ts";
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
