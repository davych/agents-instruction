import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  E2eAutomationRunner,
  E2eTestAuthorRunner,
  type E2eProcessSpawner,
} from "../src/services/e2e-automation-runner.ts";
import type { E2eWorkspaceConfig } from "../src/services/e2e-workspace-service.ts";
import { canonicalPlaywrightConfigSource } from "../src/services/e2e-workspace-service.ts";

const roots: string[] = [];
test.after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

async function authorFixture(): Promise<{
  parent: string;
  e2eRoot: string;
  promptLog: string;
  stub: string;
}> {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-e2e-author-check-")));
  roots.push(parent);
  const e2eRoot = path.join(parent, "standalone-e2e");
  await mkdir(path.join(e2eRoot, "tests"), { recursive: true });
  await mkdir(path.join(e2eRoot, "fixtures"), { recursive: true });
  await writeFile(path.join(e2eRoot, "tests", "preexisting.spec.ts"), "// pre-existing executable test\n", "utf8");
  await writeFile(path.join(e2eRoot, "package.json"), JSON.stringify({
    scripts: { "test:e2e": "playwright test" },
  }), "utf8");
  await writeFile(path.join(e2eRoot, "playwright.config.mjs"), "export default {};\n", "utf8");
  const promptLog = path.join(parent, "prompt.txt");
  const stub = path.join(parent, "codex-author-stub.mjs");
  await writeFile(stub, [
    "#!/usr/bin/env node",
    'import { mkdirSync, readFileSync, writeFileSync } from "node:fs";',
    'import path from "node:path";',
    'const prompt = readFileSync(0, "utf8");',
    `writeFileSync(${JSON.stringify(promptLog)}, prompt, "utf8");`,
    'mkdirSync(path.join(process.cwd(), "tests"), { recursive: true });',
    'mkdirSync(path.join(process.cwd(), "fixtures"), { recursive: true });',
    'writeFileSync(path.join(process.cwd(), "tests", "pinyin.spec.ts"), "// US-001-AC-06\\n", "utf8");',
    'writeFileSync(path.join(process.cwd(), "fixtures", "pinyin.json"), "{\\"answer\\":\\"b\\"}\\n", "utf8");',
    'process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "fresh-test-author" }) + "\\n");',
    "",
  ].join("\n"), "utf8");
  await chmod(stub, 0o755);
  return { parent, e2eRoot, promptLog, stub };
}

test("fresh Test Author is ephemeral, spec-only, and applies only tests/fixtures with hashes", async () => {
  const fixture = await authorFixture();
  const calls: Array<{ command: string; args: readonly string[]; cwd: string; shell: false; detached?: boolean }> = [];
  const spawnProcess: E2eProcessSpawner = (command, args, options) => {
    calls.push({ command, args: [...args], cwd: options.cwd, shell: options.shell, detached: options.detached });
    return spawn(command, [...args], options);
  };
  const runner = new E2eTestAuthorRunner({
    codexBinary: fixture.stub,
    spawnProcess,
    timeoutMs: 10_000,
  });
  const result = await runner.run({
    e2eRoot: fixture.e2eRoot,
    executionId: "author-001",
    model: "gpt-test",
    reasoningEffort: "high",
    frozenIntent: {
      scenarioId: "pinyin-responsive",
      acceptanceCriteria: [{
        id: "US-001-AC-06",
        text: "Keyboard and responsive interaction remain observable in a browser.",
      }],
      observableBehavior: "A learner can use the journey at the approved viewports and keyboard path.",
      viewports: [{ width: 320, height: 568 }],
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, fixture.stub);
  assert.equal(calls[0]?.shell, false);
  assert.equal(calls[0]?.detached, process.platform !== "win32");
  assert.notEqual(calls[0]?.cwd, fixture.e2eRoot, "the model authors in an isolated staging copy");
  assert.ok(calls[0]?.args.includes("--ephemeral"));
  assert.ok(calls[0]?.args.includes("--ignore-user-config"));
  assert.ok(calls[0]?.args.includes("workspace-write"));
  assert.equal(result.sessionId, "fresh-test-author");
  assert.deepEqual(result.files.map((file) => file.path), [
    "fixtures/pinyin.json",
    "tests/pinyin.spec.ts",
    "tests/preexisting.spec.ts",
  ]);
  assert.equal(result.files.find(({ path: filePath }) => filePath === "tests/preexisting.spec.ts")?.change, "unchanged");
  assert.match(result.patchHash, /^[a-f0-9]{64}$/u);
  assert.match(result.specIntentHash, /^[a-f0-9]{64}$/u);
  assert.equal(
    await readFile(path.join(fixture.e2eRoot, "tests", "pinyin.spec.ts"), "utf8"),
    "// US-001-AC-06\n",
  );
  for (const file of result.files) {
    const linkedContent = await readFile(path.join(fixture.e2eRoot, ...file.path.split("/")));
    assert.equal(file.afterSha256, createHash("sha256").update(linkedContent).digest("hex"));
    assert.equal(file.bytes, linkedContent.length);
  }
  const manifest = JSON.parse(
    await readFile(path.join(fixture.e2eRoot, result.manifestPath), "utf8"),
  ) as { files: unknown; patchHash: string };
  assert.deepEqual(manifest.files, result.files, "the persisted review result comes from linked-root bytes");
  assert.equal(manifest.patchHash, result.patchHash);
  const prompt = await readFile(fixture.promptLog, "utf8");
  assert.match(prompt, /frozen-e2e-spec-intent/u);
  assert.match(prompt, /US-001-AC-06/u);
  assert.doesNotMatch(prompt, new RegExp(fixture.e2eRoot.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.doesNotMatch(prompt, /src\/App\.tsx/iu);
});

test("a concurrent linked-root test addition invalidates the full pre-promotion baseline", async () => {
  const fixture = await authorFixture();
  const concurrent = path.join(fixture.e2eRoot, "tests", "concurrent-unreviewed.spec.ts");
  const author = path.join(fixture.parent, "concurrent-author.mjs");
  await writeFile(author, [
    "#!/usr/bin/env node",
    'import { readFileSync, writeFileSync } from "node:fs";',
    'import path from "node:path";',
    'readFileSync(0, "utf8");',
    'writeFileSync(path.join(process.cwd(), "tests", "pinyin.spec.ts"), "// US-001-AC-06\\n", "utf8");',
    `writeFileSync(${JSON.stringify(concurrent)}, "// unreviewed concurrent test\\n", "utf8");`,
    'process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "concurrent" }) + "\\n");',
    "",
  ].join("\n"), "utf8");
  await chmod(author, 0o755);

  await assert.rejects(
    () => new E2eTestAuthorRunner({ codexBinary: author, timeoutMs: 10_000 }).run({
      e2eRoot: fixture.e2eRoot,
      executionId: "author-concurrent",
      frozenIntent: {
        scenarioId: "concurrent-baseline",
        acceptanceCriteria: [{
          id: "US-001-AC-06",
          text: "Only the staged and validated complete suite may be promoted.",
        }],
        observableBehavior: "Concurrent linked-root changes invalidate authoring.",
      },
    }),
    { code: "E2E_AUTHOR_TARGET_STALE" },
  );
  await assert.rejects(
    () => readFile(path.join(fixture.e2eRoot, "tests", "pinyin.spec.ts")),
    { code: "ENOENT" },
  );
  assert.equal(await readFile(concurrent, "utf8"), "// unreviewed concurrent test\n");
});

test("a post-promotion author-manifest failure rolls linked files back", async () => {
  const fixture = await authorFixture();
  const runner = new E2eTestAuthorRunner({ codexBinary: fixture.stub, timeoutMs: 10_000 });
  const input = {
    e2eRoot: fixture.e2eRoot,
    executionId: "author-manifest-rollback",
    frozenIntent: {
      scenarioId: "manifest-rollback",
      acceptanceCriteria: [{
        id: "US-001-AC-06",
        text: "A failed review-manifest publication must not retain promoted bytes.",
      }],
      observableBehavior: "The linked root returns to its exact pre-promotion bytes.",
    },
  };
  const first = await runner.run(input);
  const promotedPath = path.join(fixture.e2eRoot, "tests", "pinyin.spec.ts");
  const firstPromoted = await readFile(promotedPath, "utf8");
  const firstManifest = await readFile(path.join(fixture.e2eRoot, first.manifestPath), "utf8");

  await writeFile(fixture.stub, [
    "#!/usr/bin/env node",
    'import { readFileSync, writeFileSync } from "node:fs";',
    'import path from "node:path";',
    'readFileSync(0, "utf8");',
    'writeFileSync(path.join(process.cwd(), "tests", "pinyin.spec.ts"), "// US-001-AC-06 second version\\n", "utf8");',
    'process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "second" }) + "\\n");',
    "",
  ].join("\n"), "utf8");
  await chmod(fixture.stub, 0o755);

  await assert.rejects(() => runner.run(input), { code: "EEXIST" });
  assert.equal(await readFile(promotedPath, "utf8"), firstPromoted);
  assert.equal(
    await readFile(path.join(fixture.e2eRoot, first.manifestPath), "utf8"),
    firstManifest,
  );
});

test("Test Author cannot smuggle package/control edits out of its staging workspace", async () => {
  const fixture = await authorFixture();
  const malicious = path.join(fixture.parent, "malicious-author.mjs");
  await writeFile(malicious, [
    "#!/usr/bin/env node",
    'import { readFileSync, writeFileSync } from "node:fs";',
    'import path from "node:path";',
    'readFileSync(0, "utf8");',
    'writeFileSync(path.join(process.cwd(), "package.json"), "{\\"scripts\\":{\\"pwn\\":\\"true\\"}}\\n", "utf8");',
    'process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "malicious" }) + "\\n");',
    "",
  ].join("\n"), "utf8");
  await chmod(malicious, 0o755);
  const before = await readFile(path.join(fixture.e2eRoot, "package.json"), "utf8");
  const runner = new E2eTestAuthorRunner({ codexBinary: malicious, timeoutMs: 10_000 });

  await assert.rejects(
    () => runner.run({
      e2eRoot: fixture.e2eRoot,
      executionId: "author-malicious",
      frozenIntent: {
        scenarioId: "safe",
        acceptanceCriteria: [{ id: "CC-AC-001", text: "The expected path remains safe." }],
        observableBehavior: "The expected path remains safe.",
      },
    }),
    { code: "E2E_AUTHOR_OUTPUT_SCOPE_VIOLATION" },
  );
  assert.equal(await readFile(path.join(fixture.e2eRoot, "package.json"), "utf8"), before);
});

test("unreviewed importable helpers outside tests/fixtures are rejected before authoring", async () => {
  const fixture = await authorFixture();
  await mkdir(path.join(fixture.e2eRoot, "helpers"));
  await writeFile(path.join(fixture.e2eRoot, "helpers", "hidden.mjs"), "export const hidden = true;\n", "utf8");
  const runner = new E2eTestAuthorRunner({ codexBinary: fixture.stub, timeoutMs: 10_000 });
  await assert.rejects(
    () => runner.run({
      e2eRoot: fixture.e2eRoot,
      executionId: "author-hidden-helper",
      frozenIntent: {
        scenarioId: "managed-inputs",
        acceptanceCriteria: [{ id: "CC-AC-001", text: "Only reviewed inputs execute." }],
        observableBehavior: "Only reviewed inputs execute.",
      },
    }),
    { code: "E2E_INPUT_TREE_UNMANAGED" },
  );
});

async function executionFixture(): Promise<{
  parent: string;
  productRoot: string;
  e2eRoot: string;
  testStub: string;
  config: E2eWorkspaceConfig;
}> {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-e2e-execution-check-")));
  roots.push(parent);
  const productRoot = path.join(parent, "product");
  const e2eRoot = path.join(parent, "product-e2e");
  await mkdir(productRoot);
  await mkdir(e2eRoot);
  await writeFile(path.join(productRoot, "package.json"), JSON.stringify({
    scripts: { "start:e2e": "node server.mjs" },
  }), "utf8");
  await writeFile(path.join(productRoot, "server.mjs"), [
    "setInterval(() => undefined, 1_000);",
    'process.on("SIGTERM", () => process.exit(0));',
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(e2eRoot, "package.json"), JSON.stringify({
    scripts: { "test:e2e": "playwright test" },
  }), "utf8");
  await writeFile(path.join(e2eRoot, "playwright.config.mjs"), canonicalPlaywrightConfigSource(), "utf8");
  const testStub = path.join(e2eRoot, ".ai-sdlc", "test-stub.mjs");
  await mkdir(path.dirname(testStub), { recursive: true });
  await writeFile(testStub, [
    'import { mkdirSync, writeFileSync } from "node:fs";',
    'mkdirSync("playwright-report", { recursive: true });',
    'writeFileSync("playwright-report/index.html", `<p>${process.env.AI_SDLC_E2E_BASE_URL}</p>`, "utf8");',
    'process.stdout.write("1 passed\\n");',
    "",
  ].join("\n"), "utf8");
  return {
    parent,
    productRoot,
    e2eRoot,
    testStub,
    config: {
      version: 1,
      e2eRoot,
      packageManager: "npm",
      testScript: "test:e2e",
      sourceStartScript: "start:e2e",
      baseUrl: "http://127.0.0.1:4173/",
      browser: "chromium",
      playwrightVersion: "1.62.1",
    },
  };
}

test("target preflight starts, probes, and fully reaps only the product server", async () => {
  const fixture = await executionFixture();
  const calls: Array<{ args: readonly string[]; ignoreScripts: string | undefined }> = [];
  let serverProcess: ReturnType<typeof spawn> | undefined;
  const runner = new E2eAutomationRunner({
    spawnProcess: (_command, args, options) => {
      calls.push({ args: [...args], ignoreScripts: options.env.npm_config_ignore_scripts });
      const child = spawn(process.execPath, [path.join(fixture.productRoot, "server.mjs")], options);
      serverProcess = child;
      return child;
    },
    targetVacancyProbe: async () => undefined,
    readinessProbe: async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    },
    browserTargetProbe: async ({ baseUrl, browser }) => ({
      url: baseUrl,
      status: 200,
      browserVersion: browser.version,
    }),
    cleanupTimeoutMs: 2_000,
  });
  const result = await runner.preflight({
    productRoot: fixture.productRoot,
    config: fixture.config,
    browser: { executablePath: "/locked/chromium", version: "130.0" },
  });
  assert.deepEqual(calls, [{ args: ["run", "start:e2e"], ignoreScripts: "true" }]);
  assert.equal(result.targetProbe.status, 200);
  assert.notEqual(result.serverCleanup, "sigkill");
  assert.ok(serverProcess?.exitCode !== null || serverProcess?.signalCode !== null);
});

test("target preflight reports an unreachable target and leaves no product process", async () => {
  const fixture = await executionFixture();
  let serverProcess: ReturnType<typeof spawn> | undefined;
  const runner = new E2eAutomationRunner({
    spawnProcess: (_command, _args, options) => {
      const child = spawn(process.execPath, [path.join(fixture.productRoot, "server.mjs")], options);
      serverProcess = child;
      return child;
    },
    targetVacancyProbe: async () => undefined,
    readinessProbe: async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      throw new Error("target remained unreachable");
    },
    browserTargetProbe: async () => {
      throw new Error("browser probe must not run");
    },
    cleanupTimeoutMs: 2_000,
  });
  await assert.rejects(
    () => runner.preflight({
      productRoot: fixture.productRoot,
      config: fixture.config,
      browser: { executablePath: "/locked/chromium", version: "130.0" },
    }),
    /target remained unreachable/u,
  );
  assert.ok(serverProcess?.exitCode !== null || serverProcess?.signalCode !== null);
});

test("HTTP readiness attempts abort a target that accepts but never returns headers", async () => {
  const fixture = await executionFixture();
  let serverProcess: ReturnType<typeof spawn> | undefined;
  let attempts = 0;
  const neverHeaders = ((_url: string | URL | Request, init?: RequestInit) => {
    attempts += 1;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      const abort = () => reject(signal.reason ?? new Error("aborted"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  }) as typeof fetch;
  const runner = new E2eAutomationRunner({
    spawnProcess: (_command, _args, options) => {
      const child = spawn(process.execPath, [path.join(fixture.productRoot, "server.mjs")], options);
      serverProcess = child;
      return child;
    },
    targetVacancyProbe: async () => undefined,
    httpFetch: neverHeaders,
    browserTargetProbe: async () => {
      throw new Error("browser probe must not run");
    },
    serverReadyTimeoutMs: 80,
    cleanupTimeoutMs: 2_000,
  });
  const startedAt = Date.now();
  await assert.rejects(
    () => runner.preflight({
      productRoot: fixture.productRoot,
      config: fixture.config,
      browser: { executablePath: "/locked/chromium", version: "130.0" },
    }),
    { code: "E2E_SOURCE_SERVER_NOT_READY" },
  );
  assert.ok(Date.now() - startedAt < 1_000, "readiness must honor its bounded deadline");
  assert.ok(attempts >= 1);
  assert.ok(serverProcess?.exitCode !== null || serverProcess?.signalCode !== null);
});

test("target preflight rejects a missing product start script before spawn", async () => {
  const fixture = await executionFixture();
  await writeFile(path.join(fixture.productRoot, "package.json"), JSON.stringify({ scripts: {} }), "utf8");
  let spawned = false;
  const runner = new E2eAutomationRunner({
    spawnProcess: (command, args, options) => {
      spawned = true;
      return spawn(command, [...args], options);
    },
    targetVacancyProbe: async () => undefined,
  });
  await assert.rejects(
    () => runner.preflight({
      productRoot: fixture.productRoot,
      config: fixture.config,
      browser: { executablePath: "/locked/chromium", version: "130.0" },
    }),
    { code: "E2E_SCRIPT_MISSING" },
  );
  assert.equal(spawned, false);
});

test("target preflight fails when cleanup requires SIGKILL and still reaps the server", async () => {
  const fixture = await executionFixture();
  const serverReadyPath = path.join(fixture.parent, "sigterm-handler.ready");
  await writeFile(path.join(fixture.productRoot, "server.mjs"), [
    'import { writeFileSync } from "node:fs";',
    'process.on("SIGTERM", () => undefined);',
    `writeFileSync(${JSON.stringify(serverReadyPath)}, "ready", "utf8");`,
    "setInterval(() => undefined, 1_000);",
    "",
  ].join("\n"), "utf8");
  let serverProcess: ReturnType<typeof spawn> | undefined;
  const runner = new E2eAutomationRunner({
    spawnProcess: (_command, _args, options) => {
      const child = spawn(process.execPath, [path.join(fixture.productRoot, "server.mjs")], options);
      serverProcess = child;
      return child;
    },
    targetVacancyProbe: async () => undefined,
    readinessProbe: async (_url, timeoutMs, signal) => {
      await waitUntilFileReadable(
        serverReadyPath,
        timeoutMs,
        signal,
        "SIGTERM handler did not become ready",
      );
    },
    browserTargetProbe: async ({ baseUrl, browser }) => ({
      url: baseUrl,
      status: 200,
      browserVersion: browser.version,
    }),
    cleanupTimeoutMs: 10,
    serverReadyTimeoutMs: 5_000,
  });
  await assert.rejects(
    () => runner.preflight({
      productRoot: fixture.productRoot,
      config: fixture.config,
      browser: { executablePath: "/locked/chromium", version: "130.0" },
    }),
    { code: "E2E_SOURCE_SERVER_CLEANUP_FAILED" },
  );
  assert.ok(serverProcess?.exitCode !== null || serverProcess?.signalCode !== null);
});

test("cleanup detects an orphan descendant after the npm leader exits and force-reaps the group", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX process-group semantics");
    return;
  }
  const fixture = await executionFixture();
  const childReadyPath = path.join(fixture.parent, "descendant.ready");
  const descendantProgram = [
    'import { writeFileSync } from "node:fs";',
    'process.on("SIGTERM", () => undefined);',
    `writeFileSync(${JSON.stringify(childReadyPath)}, String(process.pid), "utf8");`,
    "setInterval(() => undefined, 1_000);",
  ].join(" ");
  await writeFile(path.join(fixture.productRoot, "server.mjs"), [
    'import { spawn } from "node:child_process";',
    `spawn(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(descendantProgram)}], { stdio: "ignore" });`,
    "setInterval(() => undefined, 1_000);",
    'process.on("SIGTERM", () => process.exit(0));',
    "",
  ].join("\n"), "utf8");
  const runner = new E2eAutomationRunner({
    spawnProcess: (_command, _args, options) => (
      spawn(process.execPath, [path.join(fixture.productRoot, "server.mjs")], options)
    ),
    targetVacancyProbe: async () => undefined,
    readinessProbe: async (_url, timeoutMs, signal) => {
      await waitUntilFileReadable(
        childReadyPath,
        timeoutMs,
        signal,
        "descendant did not start",
      );
    },
    browserTargetProbe: async ({ baseUrl, browser }) => ({
      url: baseUrl,
      status: 200,
      browserVersion: browser.version,
    }),
    cleanupTimeoutMs: 25,
    serverReadyTimeoutMs: 5_000,
  });
  await assert.rejects(
    () => runner.preflight({
      productRoot: fixture.productRoot,
      config: fixture.config,
      browser: { executablePath: "/locked/chromium", version: "130.0" },
    }),
    (error: unknown) => {
      assert.ok(error && typeof error === "object");
      assert.equal((error as { code?: unknown }).code, "E2E_SOURCE_SERVER_CLEANUP_FAILED");
      assert.equal(
        (error as { details?: { serverCleanup?: unknown } }).details?.serverCleanup,
        "sigkill",
      );
      return true;
    },
  );
  const descendantPid = Number(await readFile(childReadyPath, "utf8"));
  assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
  await waitUntilProcessGone(descendantPid, 2_000);
  assert.throws(() => process.kill(descendantPid, 0), { code: "ESRCH" });
});

test("real automation uses fixed npm scripts, supervises the server, and hashes durable evidence", async () => {
  const fixture = await executionFixture();
  const calls: Array<{ command: string; args: readonly string[]; cwd: string; shell: false }> = [];
  const spawnProcess: E2eProcessSpawner = (command, args, options) => {
    calls.push({ command, args: [...args], cwd: options.cwd, shell: options.shell });
    return args[1] === "start:e2e"
      ? spawn(process.execPath, [path.join(fixture.productRoot, "server.mjs")], options)
      : spawn(process.execPath, [fixture.testStub], options);
  };
  const runner = new E2eAutomationRunner({
    spawnProcess,
    targetVacancyProbe: async () => undefined,
    readinessProbe: async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    },
    browserTargetProbe: async ({ baseUrl, browser }) => ({
      url: baseUrl,
      status: 200,
      browserVersion: browser.version,
    }),
    serverReadyTimeoutMs: 10_000,
    testTimeoutMs: 10_000,
    cleanupTimeoutMs: 2_000,
  });
  const result = await runner.run({
    executionId: "verification-001",
    productRoot: fixture.productRoot,
    config: fixture.config,
    browser: { executablePath: "/locked/chromium", version: "130.0" },
  });

  assert.equal(result.passed, true);
  assert.equal(result.testExitCode, 0);
  assert.ok(["sigterm", "already_exited"].includes(result.serverCleanup));
  assert.deepEqual(calls, [
    { command: "npm", args: ["run", "start:e2e"], cwd: fixture.productRoot, shell: false },
    { command: "npm", args: ["run", "test:e2e"], cwd: fixture.e2eRoot, shell: false },
  ]);
  assert.ok(result.evidence.some((file) => file.path === "playwright-report/index.html"));
  assert.ok(result.evidence.some((file) => file.path === result.manifestPath));
  assert.match(result.manifestSha256, /^[a-f0-9]{64}$/u);
  const manifest = JSON.parse(await readFile(path.join(fixture.e2eRoot, result.manifestPath), "utf8"));
  assert.equal(manifest.browser.version, "130.0");
  assert.equal(manifest.targetProbe.status, 200);
  assert.equal(manifest.testCommand.cwd, fixture.e2eRoot);
  assert.notEqual(result.serverExitCode, null, "the source server must be reaped before return");
});

test("automation still cleans up the source server when readiness fails", async () => {
  const fixture = await executionFixture();
  let serverProcess: ReturnType<typeof spawn> | undefined;
  const spawnProcess: E2eProcessSpawner = (command, args, options) => {
    const child = args[1] === "start:e2e"
      ? spawn(process.execPath, [path.join(fixture.productRoot, "server.mjs")], options)
      : spawn(command, [...args], options);
    serverProcess ??= child;
    return child;
  };
  const runner = new E2eAutomationRunner({
    spawnProcess,
    targetVacancyProbe: async () => undefined,
    readinessProbe: async () => {
      throw new Error("forced readiness failure");
    },
    browserTargetProbe: async () => {
      throw new Error("must not run");
    },
    cleanupTimeoutMs: 2_000,
  });

  await assert.rejects(
    () => runner.run({
      executionId: "verification-readiness-fail",
      productRoot: fixture.productRoot,
      config: fixture.config,
      browser: { executablePath: "/locked/chromium", version: "130.0" },
    }),
    /forced readiness failure/u,
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(serverProcess?.exitCode !== null || serverProcess?.signalCode !== null);
});

test("a successful exit cannot reuse stale Playwright evidence from an earlier run", async () => {
  const fixture = await executionFixture();
  await mkdir(path.join(fixture.e2eRoot, "playwright-report"));
  await writeFile(path.join(fixture.e2eRoot, "playwright-report", "index.html"), "stale", "utf8");
  await writeFile(fixture.testStub, "process.exit(0);\n", "utf8");
  const spawnProcess: E2eProcessSpawner = (_command, args, options) => args[1] === "start:e2e"
    ? spawn(process.execPath, [path.join(fixture.productRoot, "server.mjs")], options)
    : spawn(process.execPath, [fixture.testStub], options);
  const runner = new E2eAutomationRunner({
    spawnProcess,
    targetVacancyProbe: async () => undefined,
    readinessProbe: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    },
    browserTargetProbe: async ({ baseUrl, browser }) => ({
      url: baseUrl,
      status: 200,
      browserVersion: browser.version,
    }),
    cleanupTimeoutMs: 2_000,
  });

  await assert.rejects(
    () => runner.run({
      executionId: "verification-stale-evidence",
      productRoot: fixture.productRoot,
      config: fixture.config,
      browser: { executablePath: "/locked/chromium", version: "130.0" },
    }),
    { code: "E2E_EXECUTION_EVIDENCE_MISSING" },
  );
});

test("an HTTP-ready source is not enough when real Chromium target navigation fails", async () => {
  const fixture = await executionFixture();
  let testStarted = false;
  const spawnProcess: E2eProcessSpawner = (_command, args, options) => {
    if (args[1] === "start:e2e") {
      return spawn(process.execPath, [path.join(fixture.productRoot, "server.mjs")], options);
    }
    testStarted = true;
    return spawn(process.execPath, [fixture.testStub], options);
  };
  const runner = new E2eAutomationRunner({
    spawnProcess,
    targetVacancyProbe: async () => undefined,
    readinessProbe: async () => undefined,
    browserTargetProbe: async ({ baseUrl, browser }) => ({
      url: baseUrl,
      status: 503,
      browserVersion: browser.version,
    }),
    cleanupTimeoutMs: 2_000,
  });

  let failure: unknown;
  await assert.rejects(
    async () => {
      try {
        await runner.run({
          executionId: "verification-target-fail",
          productRoot: fixture.productRoot,
          config: fixture.config,
          browser: { executablePath: "/locked/chromium", version: "130.0" },
        });
      } catch (error) {
        failure = error;
        throw error;
      }
    },
    { code: "E2E_BROWSER_TARGET_FAILED" },
  );
  assert.equal(testStarted, false);
  const targetFailure = failureEvidence(failure);
  const manifest = JSON.parse(
    await readFile(path.join(fixture.e2eRoot, targetFailure.path), "utf8"),
  );
  assert.equal(manifest.passed, false);
  assert.equal(manifest.stage, "browser_target_probe");
  assert.equal(manifest.code, "E2E_BROWSER_TARGET_FAILED");
  assert.match(targetFailure.sha256, /^[a-f0-9]{64}$/u);
});

test("a Playwright timeout writes bounded machine failure evidence and cleans the server", async () => {
  const fixture = await executionFixture();
  await writeFile(fixture.testStub, [
    'process.on("SIGTERM", () => undefined);',
    "setInterval(() => undefined, 1_000);",
    "",
  ].join("\n"), "utf8");
  let serverProcess: ReturnType<typeof spawn> | undefined;
  const runner = new E2eAutomationRunner({
    spawnProcess: (_command, args, options) => {
      const child = args[1] === "start:e2e"
        ? spawn(process.execPath, [path.join(fixture.productRoot, "server.mjs")], options)
        : spawn(process.execPath, [fixture.testStub], options);
      if (args[1] === "start:e2e") serverProcess = child;
      return child;
    },
    targetVacancyProbe: async () => undefined,
    readinessProbe: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    },
    browserTargetProbe: async ({ baseUrl, browser }) => ({
      url: baseUrl,
      status: 200,
      browserVersion: browser.version,
    }),
    testTimeoutMs: 40,
    cleanupTimeoutMs: 2_000,
  });
  let failure: unknown;
  await assert.rejects(
    async () => {
      try {
        await runner.run({
          executionId: "verification-test-timeout",
          productRoot: fixture.productRoot,
          config: fixture.config,
          browser: { executablePath: "/locked/chromium", version: "130.0" },
        });
      } catch (error) {
        failure = error;
        throw error;
      }
    },
    { code: "E2E_PROCESS_TIMEOUT" },
  );
  const timeoutFailure = failureEvidence(failure);
  const manifestContent = await readFile(path.join(fixture.e2eRoot, timeoutFailure.path), "utf8");
  const manifest = JSON.parse(manifestContent);
  assert.ok(Buffer.byteLength(manifestContent) < 16_000, "failure manifest stays bounded");
  assert.equal(manifest.stage, "playwright_test");
  assert.equal(manifest.code, "E2E_PROCESS_TIMEOUT");
  assert.equal(manifest.testExitCode, 1);
  assert.match(manifest.testStdoutSha256, /^[a-f0-9]{64}$/u);
  assert.match(manifest.testStderrSha256, /^[a-f0-9]{64}$/u);
  assert.ok(["already_exited", "sigterm"].includes(manifest.serverCleanup));
  assert.ok(serverProcess?.exitCode !== null || serverProcess?.signalCode !== null);
});

test("an already occupied baseUrl is rejected before the product start script", async () => {
  const fixture = await executionFixture();
  let spawned = false;
  const runner = new E2eAutomationRunner({
    spawnProcess: (command, args, options) => {
      spawned = true;
      return spawn(command, [...args], options);
    },
    targetVacancyProbe: async () => {
      throw Object.assign(new Error("stale target is already running"), {
        code: "E2E_TARGET_ALREADY_RUNNING",
      });
    },
    browserTargetProbe: async ({ baseUrl, browser }) => ({
      url: baseUrl,
      status: 200,
      browserVersion: browser.version,
    }),
  });
  await assert.rejects(
    () => runner.run({
      executionId: "verification-occupied-target",
      productRoot: fixture.productRoot,
      config: fixture.config,
      browser: { executablePath: "/locked/chromium", version: "130.0" },
    }),
    /already running/u,
  );
  assert.equal(spawned, false);
});

test("automation refuses unmanaged helper modules before starting any process", async () => {
  const fixture = await executionFixture();
  await mkdir(path.join(fixture.e2eRoot, "helpers"));
  await writeFile(path.join(fixture.e2eRoot, "helpers", "hidden.mjs"), "export const hidden = true;\n", "utf8");
  let spawned = false;
  const runner = new E2eAutomationRunner({
    spawnProcess: (command, args, options) => {
      spawned = true;
      return spawn(command, [...args], options);
    },
    targetVacancyProbe: async () => undefined,
    browserTargetProbe: async ({ baseUrl, browser }) => ({
      url: baseUrl,
      status: 200,
      browserVersion: browser.version,
    }),
  });
  await assert.rejects(
    () => runner.run({
      executionId: "verification-hidden-helper",
      productRoot: fixture.productRoot,
      config: fixture.config,
      browser: { executablePath: "/locked/chromium", version: "130.0" },
    }),
    { code: "E2E_INPUT_TREE_UNMANAGED" },
  );
  assert.equal(spawned, false);
});

test("automation rejects npm pre/post hooks before any lifecycle command can run", async (context) => {
  for (const hook of ["pretest:e2e", "posttest:e2e"] as const) {
    await context.test(hook, async () => {
      const fixture = await executionFixture();
      const packagePath = path.join(fixture.e2eRoot, "package.json");
      const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
      packageJson.scripts[hook] = "node swap-reviewed-test.mjs";
      await writeFile(packagePath, `${JSON.stringify(packageJson)}\n`, "utf8");
      let spawned = false;
      const runner = new E2eAutomationRunner({
        spawnProcess: (command, args, options) => {
          spawned = true;
          return spawn(command, [...args], options);
        },
        targetVacancyProbe: async () => undefined,
        browserTargetProbe: async ({ baseUrl, browser }) => ({
          url: baseUrl,
          status: 200,
          browserVersion: browser.version,
        }),
      });
      await assert.rejects(
        () => runner.run({
          executionId: `verification-${hook.startsWith("pre") ? "pre" : "post"}-hook`,
          productRoot: fixture.productRoot,
          config: fixture.config,
          browser: { executablePath: "/locked/chromium", version: "130.0" },
        }),
        { code: "E2E_TEST_LIFECYCLE_HOOK_FORBIDDEN" },
      );
      assert.equal(spawned, false);
    });
  }
});

test("forced SIGKILL cleanup makes a zero Playwright exit non-passing", async () => {
  const fixture = await executionFixture();
  await writeFile(path.join(fixture.productRoot, "server.mjs"), [
    "setInterval(() => undefined, 1_000);",
    'process.on("SIGTERM", () => undefined);',
    "",
  ].join("\n"), "utf8");
  const spawnProcess: E2eProcessSpawner = (_command, args, options) => args[1] === "start:e2e"
    ? spawn(process.execPath, [path.join(fixture.productRoot, "server.mjs")], options)
    : spawn(process.execPath, [fixture.testStub], options);
  const runner = new E2eAutomationRunner({
    spawnProcess,
    targetVacancyProbe: async () => undefined,
    readinessProbe: async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    },
    browserTargetProbe: async ({ baseUrl, browser }) => ({
      url: baseUrl,
      status: 200,
      browserVersion: browser.version,
    }),
    cleanupTimeoutMs: 10,
  });
  const result = await runner.run({
    executionId: "verification-cleanup-fail",
    productRoot: fixture.productRoot,
    config: fixture.config,
    browser: { executablePath: "/locked/chromium", version: "130.0" },
  });
  assert.equal(result.testExitCode, 0);
  assert.equal(result.serverCleanup, "sigkill");
  assert.equal(result.passed, false);
});

function failureEvidence(error: unknown): { path: string; sha256: string; bytes: number } {
  assert.ok(error && typeof error === "object" && "details" in error);
  const details = (error as { details?: unknown }).details;
  assert.ok(details && typeof details === "object" && "failureEvidence" in details);
  const evidence = (details as { failureEvidence?: unknown }).failureEvidence;
  assert.ok(evidence && typeof evidence === "object");
  assert.equal(typeof (evidence as { path?: unknown }).path, "string");
  assert.equal(typeof (evidence as { sha256?: unknown }).sha256, "string");
  assert.equal(typeof (evidence as { bytes?: unknown }).bytes, "number");
  return evidence as { path: string; sha256: string; bytes: number };
}

async function waitUntilProcessGone(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitUntilFileReadable(
  filePath: string,
  timeoutMs: number,
  signal: AbortSignal,
  timeoutMessage: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error("readiness probe was aborted");
    try {
      await readFile(filePath, "utf8");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const delayMs = Math.min(25, Math.max(0, deadline - Date.now()));
      if (delayMs > 0) await abortableDelay(delayMs, signal);
    }
  }
  throw new Error(timeoutMessage);
}

async function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("readiness probe was aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("readiness probe was aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
