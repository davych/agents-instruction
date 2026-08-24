import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_E2E_PLAYWRIGHT_VERSION,
  E2E_WORKSPACE_SIDECAR_PATH,
  E2eWorkspaceService,
  type E2eSetupProcessRunner,
} from "../src/services/e2e-workspace-service.ts";

const roots: string[] = [];
test.after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

async function fixture(): Promise<{ parent: string; productRoot: string; e2eRoot: string }> {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-e2e-workspace-")));
  roots.push(parent);
  const productRoot = path.join(parent, "product");
  const e2eRoot = path.join(parent, "product-e2e");
  await mkdir(productRoot);
  await writeFile(path.join(productRoot, "package.json"), JSON.stringify({
    scripts: { preview: "vite preview" },
  }), "utf8");
  return { parent, productRoot, e2eRoot };
}

test("initializes only a separate empty sidecar project with pinned Playwright defaults", async () => {
  const { parent, productRoot, e2eRoot } = await fixture();
  const service = new E2eWorkspaceService({ allowedRoots: [parent] });
  const config = await service.initialize({
    productRoot,
    e2eRoot,
    sourceStartScript: "preview",
    baseUrl: "http://127.0.0.1:4173/",
  });

  assert.equal(config.playwrightVersion, DEFAULT_E2E_PLAYWRIGHT_VERSION);
  assert.equal(config.e2eRoot, e2eRoot);
  assert.equal(config.testScript, "test:e2e");
  const sidecar = JSON.parse(await readFile(
    path.join(productRoot, ...E2E_WORKSPACE_SIDECAR_PATH.split("/")),
    "utf8",
  ));
  assert.equal(sidecar.e2eRoot, e2eRoot);
  assert.equal(sidecar.packageManager, "npm");
  const packageJson = JSON.parse(await readFile(path.join(e2eRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["test:e2e"], "playwright test");
  assert.equal(packageJson.devDependencies["@playwright/test"], DEFAULT_E2E_PLAYWRIGHT_VERSION);
  assert.match(await readFile(path.join(e2eRoot, "playwright.config.mjs"), "utf8"), /AI_SDLC_E2E_BASE_URL/u);
});

test("rejects nonempty, nested, symlinked, and out-of-policy E2E roots", async (context) => {
  await context.test("raw traversal", async () => {
    const { parent, productRoot } = await fixture();
    const service = new E2eWorkspaceService({ allowedRoots: [parent] });
    for (const rawTraversal of [
      `${parent}/ghost/../traversed-e2e`,
      String.raw`C:\allowed\ghost\..\traversed-e2e`,
    ]) {
      await assert.rejects(
        () => service.initialize({
          productRoot,
          e2eRoot: rawTraversal,
          sourceStartScript: "preview",
          baseUrl: "http://127.0.0.1:4173/",
        }),
        { code: "E2E_WORKSPACE_PATH_UNSAFE" },
      );
    }
  });

  await context.test("nonempty", async () => {
    const { parent, productRoot, e2eRoot } = await fixture();
    await mkdir(e2eRoot);
    await writeFile(path.join(e2eRoot, "keep.txt"), "owned", "utf8");
    const service = new E2eWorkspaceService({ allowedRoots: [parent] });
    await assert.rejects(
      () => service.initialize({
        productRoot,
        e2eRoot,
        sourceStartScript: "preview",
        baseUrl: "http://127.0.0.1:4173/",
      }),
      { code: "E2E_WORKSPACE_NOT_EMPTY" },
    );
    assert.equal(await readFile(path.join(e2eRoot, "keep.txt"), "utf8"), "owned");
  });

  await context.test("nested", async () => {
    const { parent, productRoot } = await fixture();
    const service = new E2eWorkspaceService({ allowedRoots: [parent] });
    await assert.rejects(
      () => service.initialize({
        productRoot,
        e2eRoot: path.join(productRoot, "e2e"),
        sourceStartScript: "preview",
        baseUrl: "http://127.0.0.1:4173/",
      }),
      { code: "E2E_WORKSPACE_ROOTS_OVERLAP" },
    );
  });

  await context.test("symlink", async () => {
    const { parent, productRoot } = await fixture();
    const target = path.join(parent, "real-e2e");
    const alias = path.join(parent, "alias-e2e");
    await mkdir(target);
    await symlink(target, alias, "dir");
    const service = new E2eWorkspaceService({ allowedRoots: [parent] });
    await assert.rejects(
      () => service.initialize({
        productRoot,
        e2eRoot: alias,
        sourceStartScript: "preview",
        baseUrl: "http://127.0.0.1:4173/",
      }),
      { code: "E2E_WORKSPACE_PATH_UNSAFE" },
    );
  });

  await context.test("outside allowed roots", async () => {
    const first = await fixture();
    const second = await fixture();
    const service = new E2eWorkspaceService({ allowedRoots: [first.parent] });
    await assert.rejects(
      () => service.initialize({
        productRoot: first.productRoot,
        e2eRoot: second.e2eRoot,
        sourceStartScript: "preview",
        baseUrl: "http://127.0.0.1:4173/",
      }),
      { code: "E2E_WORKSPACE_PATH_FORBIDDEN" },
    );
  });
});

test("readiness keeps package, start script, and a real browser launch as separate checks", async () => {
  const { parent, productRoot, e2eRoot } = await fixture();
  let launches = 0;
  const service = new E2eWorkspaceService({
    allowedRoots: [parent],
    browserLaunchProbe: async (cwd) => {
      launches += 1;
      assert.equal(cwd, e2eRoot);
      return { executablePath: "/browser/chromium", version: "130.0" };
    },
  });
  await service.initialize({
    productRoot,
    e2eRoot,
    sourceStartScript: "preview",
    baseUrl: "http://127.0.0.1:4173/",
  });

  const beforeInstall = await service.readiness(productRoot);
  assert.equal(beforeInstall.package.code, "E2E_PACKAGE_LOCK_MISSING");
  assert.equal(beforeInstall.startScript.state, "ready");
  assert.equal(beforeInstall.testScript.state, "ready");
  assert.equal(beforeInstall.browser.state, "not_checked");
  assert.equal(launches, 0);

  await writeFile(path.join(e2eRoot, "package-lock.json"), "{}\n", "utf8");
  const installedPackageRoot = path.join(e2eRoot, "node_modules", "@playwright", "test");
  await mkdir(installedPackageRoot, { recursive: true });
  await writeFile(
    path.join(installedPackageRoot, "package.json"),
    JSON.stringify({ version: DEFAULT_E2E_PLAYWRIGHT_VERSION }),
    "utf8",
  );
  const ready = await service.readiness(productRoot);
  assert.equal(ready.ready, true);
  assert.equal(ready.browser.code, "E2E_BROWSER_READY");
  assert.equal(ready.browser.version, "130.0");
  assert.equal(launches, 1);
});

test("readiness distinguishes a missing browser from an installed package", async () => {
  const { parent, productRoot, e2eRoot } = await fixture();
  const service = new E2eWorkspaceService({
    allowedRoots: [parent],
    browserLaunchProbe: async () => {
      throw new Error("Executable doesn't exist; browser is not installed");
    },
  });
  await service.initialize({
    productRoot,
    e2eRoot,
    sourceStartScript: "preview",
    baseUrl: "http://127.0.0.1:4173/",
  });
  await writeFile(path.join(e2eRoot, "package-lock.json"), "{}\n", "utf8");
  const installedPackageRoot = path.join(e2eRoot, "node_modules", "@playwright", "test");
  await mkdir(installedPackageRoot, { recursive: true });
  await writeFile(
    path.join(installedPackageRoot, "package.json"),
    JSON.stringify({ version: DEFAULT_E2E_PLAYWRIGHT_VERSION }),
    "utf8",
  );

  const readiness = await service.readiness(productRoot);
  assert.equal(readiness.package.state, "ready");
  assert.equal(readiness.browser.state, "missing");
  assert.equal(readiness.browser.code, "E2E_BROWSER_MISSING");
});

test("explicit prepare uses fixed npm argv and the local Playwright binary with shell disabled", async () => {
  const { parent, productRoot, e2eRoot } = await fixture();
  const calls: Array<{ command: string; args: readonly string[]; cwd: string; shell: false }> = [];
  const setupProcessRunner: E2eSetupProcessRunner = async (command, args, options) => {
    calls.push({ command, args: [...args], cwd: options.cwd, shell: options.shell });
    if (command === "npm") {
      const binary = path.join(e2eRoot, "node_modules", ".bin", "playwright");
      await mkdir(path.dirname(binary), { recursive: true });
      await writeFile(binary, "#!/bin/sh\n", { encoding: "utf8", mode: 0o755 });
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const service = new E2eWorkspaceService({
    allowedRoots: [parent],
    setupProcessRunner,
    setupTimeoutMs: 1234,
  });
  await service.initialize({
    productRoot,
    e2eRoot,
    sourceStartScript: "preview",
    baseUrl: "http://127.0.0.1:4173/",
  });

  const result = await service.prepare(productRoot);
  assert.equal(result.prepared, true);
  assert.deepEqual(calls, [
    { command: "npm", args: ["install", "--ignore-scripts"], cwd: e2eRoot, shell: false },
    {
      command: path.join(e2eRoot, "node_modules", ".bin", "playwright"),
      args: ["install", "chromium"],
      cwd: e2eRoot,
      shell: false,
    },
  ]);
});

test("readiness rejects npm pre/post lifecycle hooks around test:e2e", async (context) => {
  for (const hook of ["pretest:e2e", "posttest:e2e"] as const) {
    await context.test(hook, async () => {
      const { parent, productRoot, e2eRoot } = await fixture();
      const service = new E2eWorkspaceService({ allowedRoots: [parent] });
      await service.initialize({
        productRoot,
        e2eRoot,
        sourceStartScript: "preview",
        baseUrl: "http://127.0.0.1:4173/",
      });
      const packagePath = path.join(e2eRoot, "package.json");
      const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
      packageJson.scripts[hook] = "node replace-reviewed-suite.mjs";
      await writeFile(packagePath, `${JSON.stringify(packageJson)}\n`, "utf8");

      const readiness = await service.readiness(productRoot);
      assert.equal(readiness.ready, false);
      assert.equal(readiness.testScript.state, "invalid");
      assert.equal(readiness.testScript.code, "E2E_TEST_LIFECYCLE_HOOK_FORBIDDEN");
    });
  }
});
