import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  ChangeContractDto,
  ProjectDto,
  WorkflowRunDto,
} from "@ai-sdlc/contracts";

import type { CreateRunPersistence, PgWorkflowStore } from "../src/db/store.ts";
import { CodexTerminalRunner } from "../src/services/codex-runner.ts";
import { initializeCodexProject } from "../src/services/project-initializer.ts";
import { ProjectPathPolicy } from "../src/services/project-paths.ts";
import { WorkflowService } from "../src/services/workflow-service.ts";

test("AC2/AC5: API creation persists every selected source and inherited downstream context", async () => {
  const fixture = await linkedTaskFixture();
  try {
    const selectedSourceRunIds = [fixture.sources[1]!.id, fixture.sources[0]!.id];
    const created = await fixture.service.createRun(fixture.project.id, {
      title: "修复订单导出回归",
      workType: "bug",
      sourceRunIds: selectedSourceRunIds,
      expectedBehavior: "重复导出请求只生成一个结果文件。",
    });

    assert.deepEqual(fixture.store.listRunsProjectIds, [fixture.project.id]);
    assert.equal(fixture.store.createRunCalls.length, 1);
    const persisted = fixture.store.createRunCalls[0]?.persistence.changeContract;
    assert.ok(persisted);
    assert.deepEqual(persisted.sourceRunIds, selectedSourceRunIds);
    assert.deepEqual(created.changeContract?.sourceRunIds, selectedSourceRunIds);
    assert.equal(persisted.expectedBehavior, "重复导出请求只生成一个结果文件。");

    assertInheritedOnce(persisted.inScope, "订单列表导出");
    assertInheritedOnce(persisted.inScope, "导出幂等处理");
    assertInheritedOnce(persisted.outOfScope, "历史导出文件清洗");
    assertInheritedOnce(persisted.acceptanceCriteria, "导出内容与筛选条件一致");
    assertInheritedOnce(persisted.acceptanceCriteria, "重复请求复用同一导出结果");
    assertInheritedOnce(persisted.regressionScope, "订单筛选与分页");
    assertInheritedOnce(persisted.riskFlags, "data-export");
    assertInheritedOnce(persisted.riskFlags, "idempotency");
    assertInheritedOnce(persisted.evidenceRefs, "TICKET-142");
    assertInheritedOnce(persisted.evidenceRefs, "BUG-203");

    const rendered = fixture.store.createRunCalls[0]?.persistence.changeContractArtifact?.content;
    assert.ok(rendered);
    for (const sourceRunId of selectedSourceRunIds) {
      assert.match(rendered, new RegExp(sourceRunId, "u"));
    }
    assert.match(rendered, /重复请求复用同一导出结果/u);
    assert.match(rendered, /idempotency/u);
    assert.match(rendered, /BUG-203/u);
  } finally {
    await fixture.cleanup();
  }
});

test("AC4: API creation rejects missing and cross-project original Run IDs", async (context) => {
  const fixture = await linkedTaskFixture();
  try {
    const sameProjectSourceId = fixture.sources[0]!.id;
    const foreignSourceId = randomUUID();
    fixture.store.allRuns.push(sourceRun(
      foreignSourceId,
      randomUUID(),
      "另一个项目的任务",
      sourceContract("FOREIGN-1", "另一个项目范围"),
    ));

    await context.test("AC4: rejects an existing Run owned by another project", async () => {
      await assert.rejects(() => fixture.service.createRun(fixture.project.id, {
        title: "跨项目来源",
        workType: "technical",
        sourceRunIds: [sameProjectSourceId, foreignSourceId],
        expectedBehavior: "来源只能属于当前项目。",
      }));
      assert.equal(fixture.store.createRunCalls.length, 0);
    });

    await context.test("AC4: rejects a Run ID that does not exist", async () => {
      await assert.rejects(() => fixture.service.createRun(fixture.project.id, {
        title: "不存在的来源",
        workType: "change",
        sourceRunIds: [randomUUID()],
        expectedBehavior: "必须找到原始任务。",
      }));
      assert.equal(fixture.store.createRunCalls.length, 0);
    });

    await context.test("AC4: validates source IDs carried by a complete Change Contract", async () => {
      const linkedContract: ChangeContractDto = {
        ...sourceContract("BUG-FULL-1", "完整合同的修复范围"),
        workType: "bug",
        sourceRunIds: [sameProjectSourceId, foreignSourceId],
      };
      await assert.rejects(() => fixture.service.createRun(fixture.project.id, {
        title: "完整合同也不能跨项目",
        objective: "验证完整合同中的来源",
        changeContract: linkedContract,
      }));
      assert.equal(fixture.store.createRunCalls.length, 0);
    });
  } finally {
    await fixture.cleanup();
  }
});

test("AC5: inherited unique list overflow rejects clearly instead of dropping a later source", async () => {
  const fixture = await linkedTaskFixture();
  try {
    const firstContract = fixture.sources[0]!.changeContract;
    const laterContract = fixture.sources[1]!.changeContract;
    assert.ok(firstContract);
    assert.ok(laterContract);
    firstContract.inScope = Array.from({ length: 60 }, (_, index) => `来源一范围-${index}`);
    laterContract.inScope = Array.from({ length: 60 }, (_, index) => `来源二范围-${index}`);

    await assert.rejects(
      () => fixture.service.createRun(fixture.project.id, {
        title: "继承范围超过合同上限",
        workType: "change",
        sourceRunIds: fixture.sources.map(({ id }) => id),
        expectedBehavior: "所有来源都必须参与合同派生。",
      }),
      (error: unknown) => hasClearValidationFor(error, "inScope"),
    );
    assert.equal(fixture.store.createRunCalls.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("AC5: maximum-length source expected behavior creates bounded current-behavior context", async () => {
  const fixture = await linkedTaskFixture();
  try {
    const firstContract = fixture.sources[0]!.changeContract;
    const secondContract = fixture.sources[1]!.changeContract;
    assert.ok(firstContract);
    assert.ok(secondContract);
    firstContract.expectedBehavior = "甲".repeat(5_000);
    secondContract.expectedBehavior = "乙".repeat(5_000);

    const created = await fixture.service.createRun(fixture.project.id, {
      title: "长当前行为边界",
      workType: "technical",
      sourceRunIds: fixture.sources.map(({ id }) => id),
      expectedBehavior: "派生合同保持合法且可以创建。",
    });

    const persisted = fixture.store.createRunCalls[0]?.persistence.changeContract;
    assert.ok(persisted);
    assert.equal(persisted.currentBehavior.length > 0, true);
    assert.equal(persisted.currentBehavior.length <= 5_000, true);
    assert.deepEqual(created.changeContract?.sourceRunIds, fixture.sources.map(({ id }) => id));
  } finally {
    await fixture.cleanup();
  }
});

test("AC6/AC7: complete and legacy feature contracts persist and render without source links", async () => {
  const fixture = await linkedTaskFixture();
  try {
    const legacyFeatureContract: ChangeContractDto = {
      workType: "feature",
      summary: "增加订单导出",
      currentBehavior: "客户只能逐页查看订单。",
      expectedBehavior: "客户可以导出筛选后的订单。",
      inScope: ["订单列表导出"],
      outOfScope: ["定时邮件"],
      acceptanceCriteria: ["导出内容与筛选条件一致"],
      regressionScope: ["订单筛选与分页"],
      riskFlags: ["data-export"],
      evidenceRefs: ["TICKET-142"],
    };
    const created = await fixture.service.createRun(fixture.project.id, {
      title: "订单导出",
      objective: "让客户导出订单",
      changeContract: legacyFeatureContract,
    });

    const call = fixture.store.createRunCalls[0];
    assert.ok(call);
    assert.deepEqual(call.persistence.changeContract, legacyFeatureContract);
    assert.equal(call.persistence.changeContract?.sourceRunIds, undefined);
    assert.equal(created.changeContract?.sourceRunIds, undefined);
    assert.equal(fixture.store.listRunsProjectIds.length, 0);
    assert.ok(call.persistence.changeContractArtifact?.content.includes("订单列表导出"));
    assert.doesNotMatch(call.persistence.changeContractArtifact?.content ?? "", /undefined/u);
  } finally {
    await fixture.cleanup();
  }
});

class LinkedTaskMemoryStore {
  readonly listRunsProjectIds: string[] = [];
  readonly createRunCalls: Array<{
    projectId: string;
    title: string;
    objective: string;
    persistence: CreateRunPersistence;
  }> = [];

  constructor(
    readonly project: ProjectDto,
    readonly allRuns: WorkflowRunDto[],
  ) {}

  async getProject(projectId: string): Promise<ProjectDto> {
    assert.equal(projectId, this.project.id);
    return this.project;
  }

  async listRuns(projectId: string): Promise<WorkflowRunDto[]> {
    this.listRunsProjectIds.push(projectId);
    return this.allRuns.filter((run) => run.projectId === projectId);
  }

  async createRun(
    projectId: string,
    title: string,
    objective: string,
    persistence: CreateRunPersistence,
  ): Promise<WorkflowRunDto> {
    this.createRunCalls.push({ projectId, title, objective, persistence });
    const now = new Date().toISOString();
    return {
      id: persistence.runId,
      projectId,
      title,
      objective,
      changeContract: persistence.changeContract,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
  }
}

async function linkedTaskFixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-linked-intake-"));
  const requestedRoot = path.join(parent, "project");
  await initializeCodexProject(
    requestedRoot,
    "Linked intake test",
    "Independent acceptance-test fixture",
  );
  const rootPath = await realpath(requestedRoot);
  const now = new Date().toISOString();
  const project: ProjectDto = {
    id: randomUUID(),
    name: "Linked intake test",
    summary: "Independent acceptance-test fixture",
    rootPath,
    configPath: path.join(rootPath, "ai-native.yaml"),
    runCount: 2,
    createdAt: now,
    updatedAt: now,
  };
  const sources = [
    sourceRun(
      randomUUID(),
      project.id,
      "订单导出基线",
      sourceContract("TICKET-142", "订单列表导出"),
    ),
    sourceRun(
      randomUUID(),
      project.id,
      "订单导出幂等缺陷",
      {
        ...sourceContract("BUG-203", "导出幂等处理"),
        acceptanceCriteria: [
          "导出内容与筛选条件一致",
          "重复请求复用同一导出结果",
        ],
        riskFlags: ["data-export", "idempotency"],
      },
    ),
  ];
  const store = new LinkedTaskMemoryStore(project, [...sources]);
  const service = new WorkflowService(
    store as unknown as PgWorkflowStore,
    new ProjectPathPolicy([parent]),
    new CodexTerminalRunner({ fake: true }),
  );

  return {
    project,
    service,
    sources,
    store,
    cleanup: () => rm(parent, { recursive: true, force: true }),
  };
}

function sourceRun(
  id: string,
  projectId: string,
  title: string,
  changeContract: ChangeContractDto,
): WorkflowRunDto {
  const now = new Date().toISOString();
  return {
    id,
    projectId,
    title,
    objective: changeContract.summary,
    changeContract,
    status: "completed",
    createdAt: now,
    updatedAt: now,
  };
}

function sourceContract(evidenceRef: string, inScope: string): ChangeContractDto {
  return {
    workType: "feature",
    summary: `来源 ${evidenceRef}`,
    currentBehavior: "已有行为已记录。",
    expectedBehavior: "来源任务的预期行为已确认。",
    inScope: [inScope],
    outOfScope: ["历史导出文件清洗"],
    acceptanceCriteria: ["导出内容与筛选条件一致"],
    regressionScope: ["订单筛选与分页"],
    riskFlags: ["data-export"],
    evidenceRefs: [evidenceRef],
  };
}

function assertInheritedOnce(values: string[], expected: string): void {
  assert.equal(
    values.filter((value) => value === expected).length,
    1,
    `expected inherited value exactly once: ${expected}`,
  );
}

function hasClearValidationFor(error: unknown, field: string): boolean {
  const issues = (error as {
    issues?: Array<{ path?: Array<PropertyKey> }>;
  }).issues;
  const hasFieldIssue = Array.isArray(issues)
    && issues.some(({ path }) => path?.at(-1) === field);
  const message = error instanceof Error ? error.message : "";
  return hasFieldIssue || message.includes(field);
}
