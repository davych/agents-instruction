import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  changeContractSchema,
  createRunSchema,
} from "../src/index.ts";

const completeFeatureContract = {
  workType: "feature" as const,
  summary: "增加订单导出能力",
  currentBehavior: "客户目前只能逐页查看订单。",
  expectedBehavior: "客户可以按当前筛选条件导出订单。",
  inScope: ["订单列表导出"],
  outOfScope: ["定时发送导出文件"],
  acceptanceCriteria: ["导出内容与当前筛选条件一致"],
  regressionScope: ["订单列表筛选和分页"],
  riskFlags: ["data-export"],
  evidenceRefs: ["TICKET-142"],
};

test("AC2: simplified run creation accepts multiple original Run IDs", () => {
  const sourceRunIds = [randomUUID(), randomUUID()];
  const result = createRunSchema.safeParse({
    title: "修复订单导出回归",
    workType: "bug",
    sourceRunIds,
    expectedBehavior: "导出结果继续遵循当前筛选条件。",
  });

  assert.equal(result.success, true);
  if (result.success) {
    assert.deepEqual(result.data.sourceRunIds, sourceRunIds);
  }
});

test("AC3: simplified run creation identifies missing original tasks clearly", () => {
  const result = createRunSchema.safeParse({
    title: "修复订单导出回归",
    workType: "bug",
    sourceRunIds: [],
    expectedBehavior: "导出结果继续遵循当前筛选条件。",
  });

  assert.equal(result.success, false);
  if (!result.success) {
    const issue = result.error.issues.find(({ path }) => path[0] === "sourceRunIds");
    assert.ok(issue, "sourceRunIds should receive its own validation issue");
    assert.match(issue.message, /原始任务|original task|source run/iu);
  }
});

test("AC3: simplified run creation identifies missing expected behavior clearly", () => {
  const result = createRunSchema.safeParse({
    title: "调整订单导出",
    workType: "change",
    sourceRunIds: [randomUUID()],
    expectedBehavior: "   ",
  });

  assert.equal(result.success, false);
  if (!result.success) {
    const issue = result.error.issues.find(({ path }) => path[0] === "expectedBehavior");
    assert.ok(issue, "expectedBehavior should receive its own validation issue");
    assert.match(issue.message, /期望行为|expected behavior/iu);
  }
});

test("AC6: feature creation keeps the complete contract shape and has no original-task links", () => {
  const result = createRunSchema.safeParse({
    title: "订单导出",
    objective: "让客户导出订单",
    changeContract: completeFeatureContract,
  });

  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.changeContract?.sourceRunIds, undefined);
  }

  assert.equal(createRunSchema.safeParse({
    title: "订单导出",
    workType: "feature",
    sourceRunIds: [randomUUID()],
    expectedBehavior: "客户可以导出订单。",
  }).success, false);
});

test("AC4/AC6: mixed legacy and linked create fields are rejected instead of stripped", () => {
  const result = createRunSchema.safeParse({
    title: "混合格式不能降级",
    objective: "旧格式目标",
    workType: "bug",
    sourceRunIds: [randomUUID()],
    expectedBehavior: "新格式期望行为",
  });

  assert.equal(result.success, false);
});

test("AC6: a complete feature contract cannot carry original-task links", () => {
  const result = createRunSchema.safeParse({
    title: "订单导出",
    objective: "让客户导出订单",
    changeContract: {
      ...completeFeatureContract,
      sourceRunIds: [randomUUID()],
    },
  });

  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(
      result.error.issues.some(({ path }) => (
        path.at(-1) === "sourceRunIds" || path.at(-1) === "changeContract"
      )),
      "feature source links should receive an attributable validation issue",
    );
  }
});

test("AC7: a stored legacy contract without original-task links still parses", () => {
  const legacyContract = {
    ...completeFeatureContract,
    workType: "bug" as const,
  };
  const result = changeContractSchema.safeParse(legacyContract);

  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.sourceRunIds, undefined);
    assert.deepEqual(result.data, legacyContract);
  }
});
