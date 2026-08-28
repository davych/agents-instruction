import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runnerPath = fileURLToPath(new URL("../src/services/codex-runner.ts", import.meta.url));
const sharedWorkflowPath = fileURLToPath(
  new URL("../../../../templates/shared/.ai-sdlc/workflows/default.md", import.meta.url),
);

test("every phase prompt requires a plain-language, answer-first artifact without weakening evidence", async () => {
  const [runner, workflow] = await Promise.all([
    readFile(runnerPath, "utf8"),
    readFile(sharedWorkflowPath, "utf8"),
  ]);

  assert.match(runner, /所有阶段产物先写结论、当前状态和下一步人工动作/u);
  assert.match(runner, /短段落、具体动词/u);
  assert.match(runner, /专业词第一次出现时，用一句白话解释/u);
  assert.match(runner, /易读不等于降低门禁/u);
  assert.match(workflow, /Human-readable output contract/u);
  assert.match(workflow, /Start with the conclusion, current status, and the next human action/u);
  assert.match(workflow, /Keep canonical headings, IDs, hashes, paths, commands, thresholds/u);
});
