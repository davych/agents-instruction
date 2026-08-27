import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { routeTitle } from "../src/lib/navigation.ts";
import { allowAppNavigation, registerNavigationGuard } from "../src/lib/navigation-guard.ts";
import { readRunUiSource } from "./support/run-ui-source.ts";

const appPath = fileURLToPath(new URL("../src/App.tsx", import.meta.url));
const appShellPath = fileURLToPath(new URL("../src/components/app-shell.tsx", import.meta.url));
const projectsPagePath = fileURLToPath(new URL("../src/pages/projects-page.tsx", import.meta.url));
const markdownPath = fileURLToPath(new URL("../src/components/markdown-preview.tsx", import.meta.url));
const stylesPath = fileURLToPath(new URL("../src/index.css", import.meta.url));

test("review dialog contains mobile width constraints and stackable review actions", async () => {
  const [runPage, markdown, styles] = await Promise.all([
    readRunUiSource(),
    readFile(markdownPath, "utf8"),
    readFile(stylesPath, "utf8"),
  ]);

  assert.match(runPage, /grid-cols-\[minmax\(0,1fr\)\].*lg:grid-cols-\[minmax\(0,1fr\)_340px\]/u);
  assert.match(runPage, /min-h-\[280px\].*min-w-0.*max-w-full.*overflow-x-hidden/u);
  assert.match(runPage, /grid grid-cols-1 gap-2 sm:grid-cols-2/u);
  assert.match(runPage, /h-auto min-h-10 whitespace-normal/u);
  assert.match(markdown, /markdown-body min-w-0 max-w-full/u);
  assert.match(styles, /\.markdown-body \.markdown-table-wrapper \{[^}]*max-width: 100%;[^}]*overflow-x: auto;[^}]*width: 100%;/su);
});

test("review dialog guards pending and dirty exits and gates approval on viewed heads", async () => {
  const source = await readRunUiSource();

  assert.match(source, /const hasPendingReviewWork = revisionMutation\.isPending[\s\S]*reviewMutation\.isPending[\s\S]*decisionCaptureMutation\.isPending/u);
  assert.match(source, /const hasUnsavedReviewWork = isDirty[\s\S]*comment\.length > 0[\s\S]*hasDirtyDecisionResponses/u);
  assert.match(source, /window\.confirm\("关闭后将丢弃尚未提交的审核意见、决定回答或人工编辑/u);
  assert.match(source, /closeDisabled=\{hasPendingReviewWork\}/u);
  assert.match(source, /unviewedArtifactHeads\.length > 0/u);
  assert.match(source, /当前版本已查看/u);
  assert.match(source, /registerNavigationGuard\(confirmReviewExit\)/u);
  assert.match(source, /window\.addEventListener\("beforeunload"/u);
});

test("route navigation guard is ownership-safe and fail-closed", () => {
  const releaseFirst = registerNavigationGuard(() => false);
  assert.equal(allowAppNavigation(), false);
  const releaseSecond = registerNavigationGuard(() => true);
  releaseFirst();
  assert.equal(allowAppNavigation(), true, "stale cleanup must not remove the active guard");
  releaseSecond();
  assert.equal(allowAppNavigation(), true);
});

test("push navigation resets context while popstate keeps browser restoration", async () => {
  const [app, shell] = await Promise.all([
    readFile(appPath, "utf8"),
    readFile(appShellPath, "utf8"),
  ]);

  assert.match(app, /navigationKindRef\.current = "pop"/u);
  assert.match(app, /navigationKindRef\.current = "push"/u);
  assert.match(app, /window\.scrollTo\(\{ top: 0, left: 0, behavior: "auto" \}\)/u);
  assert.match(app, /document\.querySelector<HTMLElement>\("main h1"\)/u);
  assert.match(app, /document\.title = routeTitle\(route\)/u);
  assert.match(app, /if \(!allowAppNavigation\(\)\)[\s\S]*window\.history\.go\(historyIndexRef\.current - targetIndex\)/u);
  assert.match(app, /historyIndexKey = "aiSdlcHistoryIndex"/u);
  assert.doesNotMatch(app, /window\.history\.forward\(\)/u);
  assert.match(shell, /aria-current=\{index === crumbs\.length - 1 \? "page" : undefined\}/u);
});

test("route titles identify projects, workflow, and ticket contexts", () => {
  assert.equal(routeTitle({}), "项目 · AI SDLC");
  assert.equal(routeTitle({ projectId: "project-1" }), "项目详情 · AI SDLC");
  assert.equal(
    routeTitle({ projectId: "project-1", runId: "run-1", view: "workflow" }),
    "工作流看板 · AI SDLC",
  );
  assert.equal(
    routeTitle({ projectId: "project-1", runId: "run-1", view: "tickets" }),
    "用户故事 Tickets · AI SDLC",
  );
});

test("project initialization exposes all supported agent clients with Codex default", async () => {
  const source = await readFile(projectsPagePath, "utf8");

  assert.match(source, /agentClient: "codex"/u);
  assert.match(source, /label: "Codex"/u);
  assert.match(source, /label: "Claude Code"/u);
  assert.match(source, /label: "GitHub Copilot"/u);
  assert.match(source, /type="checkbox"[\s\S]*initialize: event\.target\.checked/u);
  assert.match(source, /type="radio"/u);
  assert.doesNotMatch(source, /项目代码不会上传/u);
  assert.match(source, /真实 Codex 执行.*模型服务/u);
  assert.match(source, /createControllerRef\.current\?\.abort/u);
  assert.match(source, /项目创建界面已卸载/u);
  assert.match(source, /api\.createProject\(input, \{ signal: controller\.signal \}\)/u);
  assert.match(source, /刷新项目列表确认状态后再重试/u);
});
