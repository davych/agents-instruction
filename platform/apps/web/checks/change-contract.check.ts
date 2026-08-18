import assert from "node:assert/strict";
import test from "node:test";

import {
  changeContractMissingFields,
  EMPTY_CHANGE_CONTRACT_DRAFT,
  linkedChangeMissingFields,
  materializeChangeContract,
  parseChangeContractLines,
} from "../src/lib/change-contract.ts";

test("change contract line fields are normalized and de-duplicated", () => {
  assert.deepEqual(
    parseChangeContractLines("- First\n* Second\n First \n\n"),
    ["First", "Second"],
  );
});

test("a complete draft materializes the strict change contract", () => {
  const contract = materializeChangeContract({
    workType: "bug",
    sourceRunIds: [],
    summary: "修复订单重复提交",
    currentBehavior: "网络重试时创建两张订单",
    expectedBehavior: "同一幂等键只创建一张订单",
    inScope: "订单创建接口\n客户端重试",
    outOfScope: "历史订单清洗",
    acceptanceCriteria: "重复请求返回同一订单",
    regressionScope: "正常创建\n超时重试",
    riskFlags: "支付重复扣款",
    evidenceRefs: "BUG-128",
  });

  assert.equal(contract.workType, "bug");
  assert.deepEqual(contract.inScope, ["订单创建接口", "客户端重试"]);
  assert.deepEqual(changeContractMissingFields(contract), []);
});

test("missing required contract evidence is reported", () => {
  const contract = materializeChangeContract({
    workType: "technical",
    sourceRunIds: [],
    summary: "升级依赖",
    currentBehavior: "",
    expectedBehavior: "",
    inScope: "",
    outOfScope: "",
    acceptanceCriteria: "",
    regressionScope: "",
    riskFlags: "",
    evidenceRefs: "",
  });

  assert.deepEqual(changeContractMissingFields(contract), [
    "当前行为",
    "期望行为",
    "范围内事项",
    "验收标准",
    "回归范围",
  ]);
});

test("linked intake mirrors the API source limit before submission", () => {
  assert.deepEqual(linkedChangeMissingFields({
    ...EMPTY_CHANGE_CONTRACT_DRAFT,
    workType: "change",
    sourceRunIds: Array.from({ length: 21 }, (_, index) => `source-${index}`),
    expectedBehavior: "局部调整后保持已有行为正确。",
  }), ["原始任务（最多 20 个）"]);
});
