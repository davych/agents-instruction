import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  TESTER_FLOW_STEPS,
  TEST_REPORT_REVIEW_POINTS,
} from "../src/lib/tester-workflow.js";

const runPagePath = fileURLToPath(new URL("../src/pages/run-page.tsx", import.meta.url));

test("AC-TESTER-011: Web guidance separates intake and the three E2E stages", () => {
  assert.equal(TESTER_FLOW_STEPS.length, 4);
  assert.deepEqual(TESTER_FLOW_STEPS.map(({ number }) => number), [0, 1, 2, 3]);
  assert.match(TESTER_FLOW_STEPS[0]?.description ?? "", /实现说明.*独立测试证据.*工程七镜.*revision/iu);
  assert.match(TESTER_FLOW_STEPS[1]?.description ?? "", /Playwright MCP.*草稿.*不能.*验收.*CI/iu);
  assert.match(TESTER_FLOW_STEPS[2]?.description ?? "", /spec.*旧 Run.*已批准.*独立 E2E workspace.*人工审核.*整套.*全部内容.*hash/iu);
  assert.match(TESTER_FLOW_STEPS[2]?.description ?? "", /不用手写特殊评论或 Markdown/iu);
  assert.doesNotMatch(TESTER_FLOW_STEPS[2]?.description ?? "", /E2E crystallization request:/iu);
  assert.match(TESTER_FLOW_STEPS[3]?.description ?? "", /playwright test.*不再使用 MCP.*test-report/iu);
});

test("AC-TESTER-011: test-report review points reject exploration-only evidence", () => {
  assert.equal(TEST_REPORT_REVIEW_POINTS.length, 3);
  assert.match(TEST_REPORT_REVIEW_POINTS.join(" "), /非门禁.*新会话.*独立项目.*完整可执行脚本基线.*standalone\/CI.*report\/trace.*owner/iu);
});

test("AC-TESTER-011: Verification page renders the Tester guide before execution and review", async () => {
  const source = await readFile(runPagePath, "utf8");
  assert.match(source, /TesterFlowGuide/iu);
  assert.match(source, /phase\.phaseId === "verification"[\s\S]{0,180}<TesterFlowGuide/iu);
  assert.match(source, /开始 Tester 独立验证/iu);
  assert.match(source, /MCP 跑通不等于通过/iu);
  assert.match(source, /探索 → 固化 → 独立执行/iu);
});
