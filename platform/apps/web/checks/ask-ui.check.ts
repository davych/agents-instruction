import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const askPagePath = fileURLToPath(new URL("../src/pages/ask-page.tsx", import.meta.url));
const providerSettingsPath = fileURLToPath(new URL("../src/components/provider-settings-dialog.tsx", import.meta.url));
const appPath = fileURLToPath(new URL("../src/App.tsx", import.meta.url));
const projectPagePath = fileURLToPath(new URL("../src/pages/project-page.tsx", import.meta.url));

test("Ask is a project-level route and does not reuse the Run view", async () => {
  const [app, projectPage] = await Promise.all([
    readFile(appPath, "utf8"),
    readFile(projectPagePath, "utf8"),
  ]);

  assert.match(app, /projectView\?: "workspace" \| "overview" \| "ask"/u);
  assert.match(app, /params\.set\("projectView", next\.projectView\)/u);
  assert.match(projectPage, /onOpenAsk/u);
  assert.match(projectPage, />\s*问项目\s*</u);
});

test("Ask displays all four Provider classes and opens the global credential dialog", async () => {
  const [source, providerSettings] = await Promise.all([
    readFile(askPagePath, "utf8"),
    readFile(providerSettingsPath, "utf8"),
  ]);

  for (const provider of ["OpenAI", "LM Studio", "Ollama", "Custom"]) {
    assert.match(source, new RegExp(`\\b${provider.replace(" ", "\\s+")}\\b`, "u"));
  }
  assert.match(source, /PROVIDER_SERVER_HINT/u);
  assert.match(source, /onOpenProviderSettings/u);
  assert.doesNotMatch(source, /API_KEY/u);
  assert.doesNotMatch(source, /type=["']password["']/u);
  assert.match(providerSettings, /type=["']password["']/u);
  assert.match(providerSettings, /永不回显/u);
});

test("Ask citations expand verified plain-text excerpts and work items require confirmation", async () => {
  const source = await readFile(askPagePath, "utf8");

  assert.match(source, /aria-expanded=\{open\}/u);
  assert.match(source, /\{citation\.excerpt \|\| "这条依据没有附带源码片段。"\}/u);
  assert.doesNotMatch(source, /file:\/\//u);
  assert.match(source, /确认并创建交付任务/u);
  assert.match(source, /不会自动执行任何阶段/u);
});
