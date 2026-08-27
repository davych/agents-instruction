import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ProjectDto } from "@ai-sdlc/contracts";

import {
  VerificationE2eCoordinator,
  captureE2eInputRevisionToken,
} from "../src/services/verification-e2e-coordinator.ts";
import {
  E2eTestAuthorRunner,
  type E2eAutomationRunner,
} from "../src/services/e2e-automation-runner.ts";
import type {
  E2eWorkspaceConfig,
  E2eWorkspaceService,
} from "../src/services/e2e-workspace-service.ts";

const roots: string[] = [];
test.after(async () => Promise.all(
  roots.map((root) => rm(root, { recursive: true, force: true })),
));

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-e2e-token-"));
  roots.push(root);
  await mkdir(path.join(root, "tests"));
  await mkdir(path.join(root, "fixtures"));
  await mkdir(path.join(root, ".ai-sdlc"));
  await mkdir(path.join(root, "node_modules"));
  await mkdir(path.join(root, "test-results"));
  await writeFile(path.join(root, "package.json"), "{\"scripts\":{\"test:e2e\":\"playwright test\"}}\n");
  await writeFile(path.join(root, "playwright.config.mjs"), "export default {};\n");
  await writeFile(path.join(root, "tests", "journey.spec.ts"), "// AC-001\n");
  await writeFile(path.join(root, ".ai-sdlc", "review.json"), "{\"status\":\"pending\"}\n");
  await writeFile(path.join(root, "node_modules", "cache"), "one\n");
  await writeFile(path.join(root, "test-results", "result.json"), "one\n");
  return root;
}

test("linked E2E revision binds the reviewed suite but ignores platform/runtime state", async () => {
  const root = await fixture();
  const initial = await captureE2eInputRevisionToken(root);

  await writeFile(path.join(root, ".ai-sdlc", "review.json"), "{\"status\":\"approved\"}\n");
  await writeFile(path.join(root, "node_modules", "cache"), "two\n");
  await writeFile(path.join(root, "test-results", "result.json"), "two\n");
  assert.equal(await captureE2eInputRevisionToken(root), initial);

  await writeFile(path.join(root, "tests", "journey.spec.ts"), "// AC-001 changed\n");
  assert.notEqual(await captureE2eInputRevisionToken(root), initial);
});

test("linked E2E revision fails closed on suite symlinks", async () => {
  const root = await fixture();
  await symlink(path.join(root, "package.json"), path.join(root, "tests", "escape.spec.ts"));
  await assert.rejects(
    () => captureE2eInputRevisionToken(root),
    { code: "E2E_WORKSPACE_PATH_UNSAFE" },
  );
});

test("coordinator readiness is true only after supervised target preflight", async (context) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-e2e-readiness-"));
  roots.push(parent);
  const productRoot = path.join(parent, "product");
  const e2eRoot = path.join(parent, "product-e2e");
  await mkdir(productRoot);
  await mkdir(e2eRoot);
  const config: E2eWorkspaceConfig = {
    version: 1,
    e2eRoot,
    packageManager: "npm",
    testScript: "test:e2e",
    sourceStartScript: "start:e2e",
    baseUrl: "http://127.0.0.1:4173/",
    browser: "chromium",
    playwrightVersion: "1.62.1",
  };
  const ready = (code: string) => ({ state: "ready" as const, code, detail: "ready" });
  const workspaceService = {
    async load() { return config; },
    async readiness() {
      return {
        ready: true,
        workspace: ready("E2E_WORKSPACE_READY"),
        package: ready("E2E_PACKAGE_READY"),
        startScript: ready("E2E_SOURCE_START_SCRIPT_READY"),
        testScript: ready("E2E_TEST_SCRIPT_READY"),
        browser: {
          ...ready("E2E_BROWSER_READY"),
          executablePath: "/locked/chromium",
          version: "130.0",
        },
      };
    },
  };
  const project = { rootPath: productRoot } as ProjectDto;

  await context.test("ready", async () => {
    const coordinator = new VerificationE2eCoordinator({
      workspaceService: workspaceService as unknown as E2eWorkspaceService,
      authorRunner: {} as unknown as E2eTestAuthorRunner,
      automationRunner: {
        async preflight() {
          return {
            targetProbe: { url: config.baseUrl, status: 200, browserVersion: "130.0" },
            serverExitCode: 0,
            serverCleanup: "sigterm" as const,
          };
        },
      } as unknown as E2eAutomationRunner,
    });
    const result = await coordinator.readiness(project);
    assert.equal(result.ready, true);
    assert.equal(result.target.state, "ready");
  });

  await context.test("unreachable", async () => {
    let authorRan = false;
    const coordinator = new VerificationE2eCoordinator({
      workspaceService: workspaceService as unknown as E2eWorkspaceService,
      authorRunner: {
        async run() {
          authorRan = true;
          throw new Error("must not author");
        },
      } as unknown as E2eTestAuthorRunner,
      automationRunner: {
        async preflight() { throw new Error("target unreachable"); },
      } as unknown as E2eAutomationRunner,
    });
    const result = await coordinator.readiness(project);
    assert.equal(result.ready, false);
    assert.equal(result.target.state, "failed");
    assert.match(result.target.detail ?? "", /target unreachable/u);
    await assert.rejects(
      () => coordinator.author({
        project,
        runId: "00000000-0000-4000-8000-000000000001",
        executionId: "00000000-0000-4000-8000-000000000002",
        intent: {
          criteriaSource: "change_contract",
          criteria: [{ id: "CC-AC-001", text: "Target must be reachable.", kind: "acceptance" }],
          authoritativeArtifacts: [],
        },
        model: null,
        reasoningEffort: null,
        testReportPath: "docs/test-report.md",
      }),
      { code: "E2E_PREFLIGHT_BLOCKED" },
    );
    assert.equal(authorRan, false);
  });
});

test("extra unreviewed linked tests cannot enter script approval or execution", async () => {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-e2e-exact-review-")));
  roots.push(parent);
  const productRoot = path.join(parent, "product");
  const e2eRoot = path.join(parent, "product-e2e");
  await mkdir(productRoot);
  await mkdir(path.join(e2eRoot, "tests"), { recursive: true });
  await mkdir(path.join(e2eRoot, "fixtures"), { recursive: true });
  await writeFile(path.join(e2eRoot, "package.json"), JSON.stringify({
    scripts: { "test:e2e": "playwright test" },
  }));
  await writeFile(path.join(e2eRoot, "playwright.config.mjs"), "export default {};\n");
  const authorStub = path.join(parent, "author.mjs");
  await writeFile(authorStub, [
    "#!/usr/bin/env node",
    'import { readFileSync, writeFileSync } from "node:fs";',
    'import path from "node:path";',
    'readFileSync(0, "utf8");',
    'writeFileSync(path.join(process.cwd(), "tests", "approved.spec.ts"), "// CC-AC-001\\n", "utf8");',
    'process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "exact-review" }) + "\\n");',
    "",
  ].join("\n"));
  await chmod(authorStub, 0o755);

  const config: E2eWorkspaceConfig = {
    version: 1,
    e2eRoot,
    packageManager: "npm",
    testScript: "test:e2e",
    sourceStartScript: "start:e2e",
    baseUrl: "http://127.0.0.1:4173/",
    browser: "chromium",
    playwrightVersion: "1.62.1",
  };
  const ready = (code: string) => ({ state: "ready" as const, code, detail: "ready" });
  const workspaceService = {
    async load() { return config; },
    async readiness() {
      return {
        ready: true,
        workspace: ready("E2E_WORKSPACE_READY"),
        package: ready("E2E_PACKAGE_READY"),
        startScript: ready("E2E_SOURCE_START_SCRIPT_READY"),
        testScript: ready("E2E_TEST_SCRIPT_READY"),
        browser: {
          ...ready("E2E_BROWSER_READY"),
          executablePath: "/locked/chromium",
          version: "130.0",
        },
      };
    },
  };
  let executionCalls = 0;
  const automationRunner = {
    async preflight() {
      return {
        targetProbe: { url: config.baseUrl, status: 200, browserVersion: "130.0" },
        serverExitCode: 0,
        serverCleanup: "sigterm" as const,
      };
    },
    async run() {
      executionCalls += 1;
      throw new Error("must not execute an unreviewed complete suite");
    },
  } as unknown as E2eAutomationRunner;
  const authorRunner = new E2eTestAuthorRunner({ codexBinary: authorStub, timeoutMs: 10_000 });
  const coordinator = new VerificationE2eCoordinator({
    workspaceService: workspaceService as unknown as E2eWorkspaceService,
    authorRunner,
    automationRunner,
  });
  const project = {
    id: "00000000-0000-4000-8000-000000000010",
    rootPath: productRoot,
  } as ProjectDto;
  const runId = "00000000-0000-4000-8000-000000000011";
  const recordRaceExtra = path.join(e2eRoot, "tests", "added-after-linked-collection.spec.ts");
  const recordRaceCoordinator = new VerificationE2eCoordinator({
    workspaceService: workspaceService as unknown as E2eWorkspaceService,
    authorRunner: {
      async run(input) {
        const result = await authorRunner.run(input);
        await writeFile(recordRaceExtra, "// raced the coordinator record\n");
        return result;
      },
    } as unknown as E2eTestAuthorRunner,
    automationRunner,
  });
  await assert.rejects(
    () => recordRaceCoordinator.author({
      project,
      runId,
      executionId: "00000000-0000-4000-8000-000000000009",
      intent: {
        criteriaSource: "change_contract",
        criteria: [{ id: "CC-AC-001", text: "Only reviewed scripts may execute.", kind: "acceptance" }],
        authoritativeArtifacts: [],
      },
      model: null,
      reasoningEffort: null,
      testReportPath: "docs/test-report.md",
    }),
    { code: "E2E_AUTHORING_RECORD_INVALID" },
  );
  await assert.rejects(
    () => readFile(path.join(e2eRoot, "tests", "approved.spec.ts")),
    { code: "ENOENT" },
  );
  assert.equal(await readFile(recordRaceExtra, "utf8"), "// raced the coordinator record\n");
  await rm(recordRaceExtra);

  const authored = await coordinator.author({
    project,
    runId,
    executionId: "00000000-0000-4000-8000-000000000012",
    intent: {
      criteriaSource: "change_contract",
      criteria: [{ id: "CC-AC-001", text: "Only reviewed scripts may execute.", kind: "acceptance" }],
      authoritativeArtifacts: [],
    },
    model: null,
    reasoningEffort: null,
    testReportPath: "docs/test-report.md",
  });

  const unreviewedBeforeApproval = path.join(e2eRoot, "tests", "unreviewed-before-approval.spec.ts");
  await writeFile(unreviewedBeforeApproval, "// not in the complete review manifest\n");
  await assert.rejects(
    () => coordinator.latestAuthoring(project, runId),
    { code: "E2E_AUTHORING_RECORD_INVALID" },
  );
  await assert.rejects(
    () => coordinator.review(project, runId, {
      decision: "approve",
      expectedPatchHash: authored.authoring.patchHash,
      comment: "reviewed",
    }, "docs/test-report.md"),
    { code: "E2E_SCRIPT_APPROVAL_STALE" },
  );

  await rm(unreviewedBeforeApproval);
  const approved = await coordinator.review(project, runId, {
    decision: "approve",
    expectedPatchHash: authored.authoring.patchHash,
    comment: "reviewed exact complete baseline",
  }, "docs/test-report.md");
  assert.equal(approved.status, "approved");

  await writeFile(
    path.join(e2eRoot, "tests", "unreviewed-before-execution.spec.ts"),
    "// not approved for execution\n",
  );
  await assert.rejects(
    () => coordinator.execute({
      project,
      runId,
      executionId: "00000000-0000-4000-8000-000000000013",
      testReportPath: "docs/test-report.md",
      reviewAuthority: {
        decision: "approve",
        authorExecutionId: approved.executionId,
        patchHash: approved.patchHash,
        productRevisionToken: approved.productRevisionToken,
        e2eRevisionToken: approved.e2eRevisionToken,
        commentHash: "f".repeat(64),
        reviewedAt: approved.reviewedAt!,
      },
      onEvent: async () => undefined,
    }),
    { code: "E2E_SCRIPT_APPROVAL_STALE" },
  );
  assert.equal(executionCalls, 0);
});
