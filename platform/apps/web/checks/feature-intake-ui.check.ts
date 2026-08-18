import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectPagePath = fileURLToPath(
  new URL("../src/pages/project-page.tsx", import.meta.url),
);

test("AC6: feature intake renders no Change Contract fields", async () => {
  const dialogSource = await createRunDialogSource();

  assert.match(
    dialogSource,
    /\{\s*isLinkedWorkType\(draft\.workType\)\s*\?[\s\S]*?<OriginalTaskSelector[\s\S]*?label="期望行为"[\s\S]*?:\s*null\s*\}/u,
    "original-task and expected-behavior controls must render only for linked work types",
  );
  for (const removedLabel of [
    "变更摘要",
    "当前行为",
    "范围内事项",
    "范围外事项",
    "验收标准",
    "回归范围",
    "风险标记",
    "证据引用",
  ]) {
    assert.doesNotMatch(
      dialogSource,
      new RegExp(`label=["']${removedLabel}["']`, "u"),
      `${removedLabel} must not be rendered by the create dialog`,
    );
  }
});

test("AC6: feature intake submits title-derived legacy input without contract validation", async () => {
  const dialogSource = await createRunDialogSource();
  const submitStart = dialogSource.indexOf("const submit =");
  const renderStart = dialogSource.indexOf("\n\n  return (");
  assert.ok(submitStart >= 0 && renderStart > submitStart, "submit source must be discoverable");
  const submitSource = dialogSource.slice(submitStart, renderStart);
  const linkedGuard = dialogSource.indexOf("if (isLinkedWorkType(draft.workType))");
  assert.ok(linkedGuard >= submitStart && linkedGuard < renderStart);
  assert.match(
    submitSource,
    /mutation\.mutate\(\s*\{\s*title:\s*title\.trim\(\),\s*objective:\s*title\.trim\(\),?\s*\}\s*\)/su,
    "feature should use the existing legacy { title, objective: title } API shape",
  );
  assert.doesNotMatch(
    submitSource,
    /changeContractMissingFields|materializeChangeContract/u,
  );
});

async function createRunDialogSource(): Promise<string> {
  const source = await readFile(projectPagePath, "utf8");
  const start = source.indexOf("function CreateRunDialog(");
  const end = source.indexOf("function OriginalTaskSelector(");
  assert.ok(start >= 0 && end > start, "CreateRunDialog source boundary must remain discoverable");
  return source.slice(start, end);
}
