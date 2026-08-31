import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectPagePath = fileURLToPath(
  new URL("../src/pages/project-page.tsx", import.meta.url),
);

test("CLOUD-WORK-UI-01: intake supports honest manual and operator-configured MCP sources", async () => {
  const dialogSource = await createRunDialogSource();

  assert.match(dialogSource, /手工描述/u);
  assert.match(dialogSource, /Jira \/ Linear 等 MCP/u);
  assert.match(dialogSource, /api\.listWorkItemAdapters/u);
  assert.match(dialogSource, /api\.resolveWorkItem/u);
  assert.match(dialogSource, /adapterId/u);
  assert.match(dialogSource, /externalReference/u);
  assert.match(dialogSource, /管理员还没有配置[\s\S]*不会伪装成已连接 Jira 或 Linear/u);
  assert.match(dialogSource, /外部标题和描述只是待确认资料[\s\S]*不能改变阶段顺序/u);
});

test("CLOUD-WORK-UI-02: every Run freezes a complete, plain-language Change Contract", async () => {
  const dialogSource = await createRunDialogSource();
  for (const label of [
    "现在是什么情况",
    "完成后应该怎样",
    "这次具体要做什么",
    "怎样才算完成",
    "至少要回头检查哪些地方",
  ]) {
    assert.match(dialogSource, new RegExp(`label=["']${label}["']`, "u"));
  }
  assert.match(dialogSource, /materializeChangeContract/u);
  assert.match(dialogSource, /changeContractMissingFields/u);
  assert.match(dialogSource, /changeContract:\s*contract/u);
  assert.match(dialogSource, /baseRevision/u);
});

test("CLOUD-WORK-UI-03: MCP evidence is preserved while the human remains the confirmation gate", async () => {
  const dialogSource = await createRunDialogSource();
  assert.match(dialogSource, /workItem:\s*workItem\.source/u);
  assert.match(dialogSource, /fingerprint\.slice/u);
  assert.match(dialogSource, /点击创建就是人工确认/u);
  assert.equal(
    (dialogSource.match(/mutation\.mutate\(\{/gu) ?? []).length,
    1,
    "only the explicit form submit may create a Run",
  );
});

async function createRunDialogSource(): Promise<string> {
  const source = await readFile(projectPagePath, "utf8");
  const start = source.indexOf("function CreateRunDialog(");
  const end = source.indexOf("function OriginalTaskSelector(");
  assert.ok(start >= 0 && end > start, "CreateRunDialog source boundary must remain discoverable");
  return source.slice(start, end);
}
