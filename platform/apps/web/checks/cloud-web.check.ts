import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseRemoteRepositoryUrl } from "../src/lib/cloud-project.ts";

const source = (relative: string) => readFile(
  fileURLToPath(new URL(`../src/${relative}`, import.meta.url)),
  "utf8",
);

test("CLOUD-WEB-01: repository intake is host-neutral HTTPS and never accepts embedded credentials", () => {
  for (const url of [
    "https://github.com/acme/product.git",
    "https://gitlab.example.com/team/product",
    "https://gitea.example.net/org/repository.git",
  ]) {
    assert.ok(parseRemoteRepositoryUrl(url), url);
  }
  for (const url of [
    "file:///tmp/product",
    "ssh://git@example.com/product.git",
    "http://git.example.com/product.git",
    "https://token@git.example.com/product.git",
    "https://git.example.com/product.git?token=secret",
    "https://git.example.com/product.git#main",
  ]) {
    assert.equal(parseRemoteRepositoryUrl(url), null, url);
  }
});

test("CLOUD-WEB-02: project views use repository snapshots, import polling, knowledge, and sync instead of a browser path", async () => {
  const [list, detail] = await Promise.all([
    source("pages/projects-page.tsx"),
    source("pages/project-page.tsx"),
  ]);
  assert.match(list, /sourceKind: "remote-git"/u);
  assert.match(list, /repository\?\.operation/u);
  assert.match(list, /1_500/u);
  assert.match(list, /api\.listRepositoryCredentials/u);
  assert.match(detail, /api\.syncProjectRepository/u);
  assert.match(detail, /api\.getProjectKnowledge/u);
  assert.match(detail, /activeSnapshot\?\.revision/u);
  assert.match(detail, /availableActions\.ask/u);
  assert.match(detail, /availableActions\.createRun/u);
  assert.doesNotMatch(`${list}\n${detail}`, /project\.rootPath|本地代码目录|\/Users\/you/u);
});

test("CLOUD-WEB-03: remote Ask uses server threads and never uploads browser history", async () => {
  const ask = await source("pages/ask-page.tsx");
  assert.match(ask, /api\.listAskThreads/u);
  assert.match(ask, /api\.createAskThread/u);
  assert.match(ask, /api\.askThread/u);
  assert.match(ask, /历史由服务端保存和组装/u);
  const remoteBranchStart = ask.indexOf("if (remoteProject) {");
  const legacyAskStart = ask.indexOf("const answer = await api.askProject", remoteBranchStart);
  assert.ok(remoteBranchStart >= 0 && legacyAskStart > remoteBranchStart);
  assert.doesNotMatch(ask.slice(remoteBranchStart, legacyAskStart), /askHistory\(/u);
});

test("CLOUD-WEB-04: runs expose pinned revisions and authenticated Patch download without a remote path dialog", async () => {
  const [run, api] = await Promise.all([
    source("pages/run-page.tsx"),
    source("lib/api.ts"),
  ]);
  assert.match(run, /run\.baseRevision/u);
  assert.match(run, /api\.getRunChangeset/u);
  assert.match(run, /api\.downloadRunPatch/u);
  assert.match(run, /project\.sourceKind === "legacy-local"[\s\S]*?<E2eWorkspaceDialog/u);
  assert.doesNotMatch(run, /project\.rootPath/u);
  assert.match(api, /changeset\/patch/u);
  assert.match(api, /Authorization: `Bearer \$\{accessToken\}`/u);
});

test("CLOUD-WEB-05: access token is checked by the Cloud API and stored only in sessionStorage", async () => {
  const [app, api, gate, shell] = await Promise.all([
    source("App.tsx"),
    source("lib/api.ts"),
    source("components/access-token-gate.tsx"),
    source("components/app-shell.tsx"),
  ]);
  assert.match(app, /authentication\?\.required/u);
  assert.match(app, /<AccessTokenGate/u);
  assert.match(api, /aiSdlcAccessToken/u);
  assert.match(api, /window\.sessionStorage/u);
  assert.doesNotMatch(`${api}\n${gate}`, /window\.localStorage/u);
  assert.match(api, /\/api\/auth\/check/u);
  assert.match(gate, /type="password"/u);
  assert.match(shell, /Cloud control plane/u);
  assert.doesNotMatch(shell, /Local runtime/u);
});

test("CLOUD-WEB-06: Work Item MCP is server-mediated and its normalized evidence is validated", async () => {
  const [project, api] = await Promise.all([
    source("pages/project-page.tsx"),
    source("lib/api.ts"),
  ]);
  assert.match(project, /api\.listWorkItemAdapters/u);
  assert.match(project, /api\.resolveWorkItem/u);
  assert.match(project, /workItem:\s*workItem\.source/u);
  assert.match(api, /\/api\/work-item-adapters/u);
  assert.match(api, /\/api\/work-items\/resolve/u);
  assert.match(api, /workItem\.source\.adapterId !== input\.adapterId/u);
  assert.doesNotMatch(project, /command|toolName|secretEnv/u);
});

test("CLOUD-WEB-07: remote Verification stays usable without requesting legacy Linked E2E", async () => {
  const run = await source("pages/run-page.tsx");
  assert.match(
    run,
    /queryFn: \(\) => api\.getVerificationE2eFlow\(runId\),[\s\S]{0,160}enabled: runQuery\.data\?\.project\.sourceKind === "legacy-local"/u,
  );
  assert.match(
    run,
    /sourceKind === "remote-git"[\s\S]{0,180}standardTesterLocked: false/u,
  );
  assert.match(run, /<CloudVerificationBoundary/u);
  assert.match(run, /尚未提供独立、可复用的云端真实浏览器 Linked E2E/u);
  assert.doesNotMatch(run, /cloudManaged=/u);
});

test("CLOUD-WEB-08: Run summary keeps frozen external Work Item provenance visible", async () => {
  const run = await source("pages/run-page.tsx");
  assert.match(run, /contract\.workItem \? <ContractWorkItem source=\{contract\.workItem\}/u);
  assert.match(run, /source\.adapterLabel/u);
  assert.match(run, /source\.externalId/u);
  assert.match(run, /source\.reference/u);
  assert.match(run, /source\.fetchedAt/u);
  assert.match(run, /source\.fingerprint/u);
  assert.match(run, /rel="noreferrer"/u);
});
