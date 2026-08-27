import assert from "node:assert/strict";
import test from "node:test";

import {
  RELEASE_COMPLETION_BOUNDARY,
  RELEASE_FLOW_STEPS,
  RELEASE_REVIEW_POINTS,
} from "../src/lib/release-workflow.ts";
import { readRunUiSource } from "./support/run-ui-source.ts";

test("release UI defines preparation, review, handoff, and an explicit no-release boundary", () => {
  assert.equal(RELEASE_FLOW_STEPS.length, 4);
  assert.match(RELEASE_FLOW_STEPS[0]?.description ?? "", /Verification.*证据/u);
  assert.match(RELEASE_FLOW_STEPS[1]?.description ?? "", /监控.*回滚/u);
  assert.match(RELEASE_FLOW_STEPS[2]?.description ?? "", /可执行.*可观察.*可回滚/u);
  assert.match(RELEASE_FLOW_STEPS[3]?.description ?? "", /部署.*发布.*推送.*合并.*另行授权/u);
  assert.ok(RELEASE_REVIEW_POINTS.length >= 5);
  assert.match(RELEASE_COMPLETION_BOUNDARY, /只确认.*准备材料.*没有执行部署、发布、推送、合并.*环境变更/u);
});

test("release actions and terminal state never claim deployment or release completion", async () => {
  const source = await readRunUiSource();

  assert.match(source, /生成发布准备手册/u);
  assert.match(source, /审核发布准备材料/u);
  assert.match(source, /确认发布准备已就绪/u);
  assert.match(source, /工作流审核完成/u);
  assert.match(source, /准备就绪 ≠ 已发布/u);
  assert.doesNotMatch(source, /run\.status === "completed" \? "交付完成"/u);
});
