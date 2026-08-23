import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { PhaseDefinition, ProjectDto, WorkflowRunDto } from "@ai-sdlc/contracts";

import { buildTaskEnvelope, CodexTerminalRunner } from "../src/services/codex-runner.ts";
import type { LoadedDefinition } from "../src/services/definition-loader.ts";
import { captureVerificationGitState } from "../src/services/verification-git-state.ts";
import {
  captureVerificationWorkspaceRevision,
  withVerificationWorkspaceProtected,
} from "../src/services/verification-workspace.ts";

const roots: string[] = [];
const executionConfig = { model: "gpt-5.6-sol", reasoningEffort: "high" as const };
const execFileAsync = promisify(execFile);

test.after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

test("Verification envelope makes source, tests, and control files read-only", async () => {
  const fixture = await verificationFixture();
  const prompt = buildTaskEnvelope({
    executionId: crypto.randomUUID(),
    ...fixture,
    selectedArtifacts: [],
    selectedOutputKeys: ["test-report"],
    ...executionConfig,
  });

  assert.match(prompt, /Verification.*not.*implementation|Verification.*不是实现/iu);
  assert.match(prompt, /tracked.*生产源码.*测试源码.*只读/iu);
  assert.match(prompt, /不得.*tests\/e2e\/\*\.spec\.ts/iu);
  assert.match(prompt, /test-results\/.*playwright-report\/.*blob-report\//iu);
  assert.match(prompt, /workspaceRevisionToken/iu);
  assert.match(prompt, /tracked\/untracked/iu);
  assert.match(prompt, /node_modules.*\.yarn\/cache.*规避保护/isu);
  assert.match(prompt, /\.git.*HEAD\/config\/index\/refs/isu);
  assert.match(prompt, /后台\/分离.*disposable|后台\/分离.*可恢复/isu);
});

test("Verification selected output cannot create a write hole in protected or ephemeral trees", async (context) => {
  const fixture = await verificationFixture();
  const root = fixture.project.rootPath;
  const unsafeOutputs = [
    ".git/HEAD",
    "node_modules/attacker/report.md",
    "playwright-report/report.md",
    ".ai-sdlc/workflows/default.md",
    ".codex/agents/tester.toml",
    ".env.local",
    "ai-native.yaml",
    "src/app.ts",
  ];
  for (const relativePath of unsafeOutputs) {
    await context.test(relativePath, async () => {
      let invoked = false;
      await assert.rejects(
        () => withVerificationWorkspaceProtected(
          {
            projectRoot: root,
            selectedOutputPaths: [path.join(root, ...relativePath.split("/"))],
          },
          async () => {
            invoked = true;
          },
        ),
        (error: unknown) => {
          assert.equal(
            (error as { code?: string }).code,
            "VERIFICATION_WORKSPACE_SNAPSHOT_FAILED",
          );
          assert.match(
            String((error as { details?: { cause?: string } }).details?.cause),
            /不能与|selected output/iu,
          );
          return true;
        },
      );
      assert.equal(invoked, false);
    });
  }

  await context.test("ordinary docs report remains writable", async () => {
    await withVerificationWorkspaceProtected(
      {
        projectRoot: root,
        selectedOutputPaths: [fixture.report.absolutePath],
      },
      async () => {
        await mkdir(path.dirname(fixture.report.absolutePath), { recursive: true });
        await writeFile(fixture.report.absolutePath, "# Safe report\n", "utf8");
      },
    );
    assert.equal(await readFile(fixture.report.absolutePath, "utf8"), "# Safe report\n");
  });
});

test("Verification rejects and restores a newly authored E2E spec", async () => {
  const fixture = await verificationFixture();
  const root = fixture.project.rootPath;
  const existingSpec = path.join(root, "tests", "e2e", "existing.spec.ts");
  const newSpec = path.join(root, "tests", "e2e", "new.spec.ts");
  await mkdir(path.dirname(existingSpec), { recursive: true });
  await writeFile(existingSpec, "// approved E2E baseline\n", "utf8");
  const reportBefore = "# Existing test report\n";
  await mkdir(path.dirname(fixture.report.absolutePath), { recursive: true });
  await writeFile(fixture.report.absolutePath, reportBefore, "utf8");

  const stub = await writeRunnerStub(root, "verification-new-spec-stub.mjs", [
    'mkdirSync(path.join(process.cwd(), "tests", "e2e"), { recursive: true });',
    'writeFileSync(path.join(process.cwd(), "tests", "e2e", "new.spec.ts"), "// authored during Verification\\n", "utf8");',
    `writeFileSync(path.join(process.cwd(), ${JSON.stringify(fixture.report.relativePath)}), "# Mutated report\\n", "utf8");`,
  ]);

  await assert.rejects(
    () => runVerification(fixture, stub),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "UNSELECTED_OUTPUTS_CHANGED");
      assert.equal((error as { details?: { restored?: boolean } }).details?.restored, true);
      assert.match(
        JSON.stringify((error as { details?: { changed?: string[] } }).details?.changed),
        /verification-workspace:tests/iu,
      );
      return true;
    },
  );

  assert.equal(await readFile(existingSpec, "utf8"), "// approved E2E baseline\n");
  await assert.rejects(() => readFile(newSpec, "utf8"), /ENOENT/u);
  assert.equal(await readFile(fixture.report.absolutePath, "utf8"), reportBefore);
});

test("Verification rejects and restores source and project-control mutations", async () => {
  const fixture = await verificationFixture();
  const root = fixture.project.rootPath;
  const sourcePath = path.join(root, "src", "checkout.ts");
  const sourceBefore = "export const checkout = 'approved';\n";
  const controlBefore = "version: 1\nproject:\n  name: Verification fixture\n";
  const reportBefore = "# Existing test report\n";
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await mkdir(path.dirname(fixture.report.absolutePath), { recursive: true });
  await writeFile(sourcePath, sourceBefore, "utf8");
  await writeFile(path.join(root, "ai-native.yaml"), controlBefore, "utf8");
  await writeFile(fixture.report.absolutePath, reportBefore, "utf8");

  const stub = await writeRunnerStub(root, "verification-source-control-stub.mjs", [
    'writeFileSync(path.join(process.cwd(), "src", "checkout.ts"), "export const checkout = \'mutated\';\\n", "utf8");',
    'writeFileSync(path.join(process.cwd(), "ai-native.yaml"), "version: 999\\n", "utf8");',
    `writeFileSync(path.join(process.cwd(), ${JSON.stringify(fixture.report.relativePath)}), "# Mutated report\\n", "utf8");`,
  ]);

  await assert.rejects(
    () => runVerification(fixture, stub),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "UNSELECTED_OUTPUTS_CHANGED");
      const changed = JSON.stringify((error as { details?: { changed?: string[] } }).details?.changed);
      assert.match(changed, /verification-workspace:src/iu);
      assert.match(changed, /verification-workspace:ai-native\.yaml/iu);
      return true;
    },
  );

  assert.equal(await readFile(sourcePath, "utf8"), sourceBefore);
  assert.equal(await readFile(path.join(root, "ai-native.yaml"), "utf8"), controlBefore);
  assert.equal(await readFile(fixture.report.absolutePath, "utf8"), reportBefore);
});

test("Verification rejects and restores a tracked file outside conventional code roots", async () => {
  const fixture = await verificationFixture();
  const root = fixture.project.rootPath;
  const trackedPath = path.join(root, "product-assets", "checkout-copy.txt");
  const trackedBefore = "approved checkout copy\n";
  const reportBefore = "# Existing test report\n";
  await mkdir(path.dirname(trackedPath), { recursive: true });
  await mkdir(path.dirname(fixture.report.absolutePath), { recursive: true });
  await writeFile(trackedPath, trackedBefore, "utf8");
  await writeFile(fixture.report.absolutePath, reportBefore, "utf8");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await execFileAsync("git", ["add", "product-assets/checkout-copy.txt"], { cwd: root });

  const stub = await writeRunnerStub(root, "verification-tracked-file-stub.mjs", [
    'writeFileSync(path.join(process.cwd(), "product-assets", "checkout-copy.txt"), "mutated copy\\n", "utf8");',
    `writeFileSync(path.join(process.cwd(), ${JSON.stringify(fixture.report.relativePath)}), "# Mutated report\\n", "utf8");`,
  ]);

  await assert.rejects(
    () => runVerification(fixture, stub),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "UNSELECTED_OUTPUTS_CHANGED");
      assert.match(
        JSON.stringify((error as { details?: { changed?: string[] } }).details?.changed),
        /verification-workspace:product-assets\/checkout-copy\.txt/iu,
      );
      return true;
    },
  );

  assert.equal(await readFile(trackedPath, "utf8"), trackedBefore);
  assert.equal(await readFile(fixture.report.absolutePath, "utf8"), reportBefore);
});

test("Verification rejects deletion of the project-root .git directory and restores its bytes", async () => {
  const fixture = await verificationFixture();
  const root = fixture.project.rootPath;
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await writeFile(path.join(root, "tracked.txt"), "tracked baseline\n", "utf8");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: root });
  await mkdir(path.dirname(fixture.report.absolutePath), { recursive: true });
  await writeFile(fixture.report.absolutePath, "# Existing test report\n", "utf8");
  const gitPaths = ["HEAD", "config", "index"];
  const before = new Map(await Promise.all(gitPaths.map(async (relativePath) => [
    relativePath,
    await readFile(path.join(root, ".git", relativePath)),
  ] as const)));
  const stub = await writeRunnerStub(root, "verification-delete-git-stub.mjs", [
    'rmSync(path.join(process.cwd(), ".git"), { recursive: true, force: true });',
    `writeFileSync(path.join(process.cwd(), ${JSON.stringify(fixture.report.relativePath)}), "# Mutated report\\n", "utf8");`,
  ]);

  await assert.rejects(
    () => runVerification(fixture, stub),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "UNSELECTED_OUTPUTS_CHANGED");
      assert.match(
        JSON.stringify((error as { details?: { changed?: string[] } }).details?.changed),
        /verification-workspace:\.git/iu,
      );
      return true;
    },
  );

  for (const [relativePath, content] of before) {
    assert.deepEqual(await readFile(path.join(root, ".git", relativePath)), content);
  }
  const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: root,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  assert.equal(stdout.trim(), "true");
  assert.equal(await readFile(fixture.report.absolutePath, "utf8"), "# Existing test report\n");
});

test("Verification rejects and restores corruption of Git HEAD, config, index, and refs", async () => {
  const fixture = await verificationFixture();
  const root = fixture.project.rootPath;
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await writeFile(path.join(root, "tracked.txt"), "tracked baseline\n", "utf8");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: root });
  await execFileAsync("git", [
    "-c", "user.name=Verification Guard",
    "-c", "user.email=verification@example.invalid",
    "commit", "--quiet", "-m", "baseline",
  ], { cwd: root });
  await mkdir(path.dirname(fixture.report.absolutePath), { recursive: true });
  await writeFile(fixture.report.absolutePath, "# Existing test report\n", "utf8");
  const headBefore = await readFile(path.join(root, ".git", "HEAD"), "utf8");
  const refRelativePath = headBefore.trim().replace(/^ref:\s*/u, "");
  assert.match(refRelativePath, /^refs\/heads\//u);
  const gitPaths = ["HEAD", "config", "index", refRelativePath];
  const before = new Map(await Promise.all(gitPaths.map(async (relativePath) => [
    relativePath,
    await readFile(path.join(root, ".git", ...relativePath.split("/"))),
  ] as const)));
  const stub = await writeRunnerStub(root, "verification-corrupt-git-stub.mjs", [
    'writeFileSync(path.join(process.cwd(), ".git", "HEAD"), "ref: refs/heads/attacker\\n", "utf8");',
    'writeFileSync(path.join(process.cwd(), ".git", "config"), "[attacker]\\nvalue=true\\n", "utf8");',
    'writeFileSync(path.join(process.cwd(), ".git", "index"), "corrupted index", "utf8");',
    `writeFileSync(path.join(process.cwd(), ".git", ...${JSON.stringify(refRelativePath.split("/"))}), "0000000000000000000000000000000000000000\\n", "utf8");`,
    `writeFileSync(path.join(process.cwd(), ${JSON.stringify(fixture.report.relativePath)}), "# Mutated report\\n", "utf8");`,
  ]);

  await assert.rejects(() => runVerification(fixture, stub), {
    code: "UNSELECTED_OUTPUTS_CHANGED",
  });

  for (const [relativePath, content] of before) {
    assert.deepEqual(
      await readFile(path.join(root, ".git", ...relativePath.split("/"))),
      content,
    );
  }
  assert.equal(await readFile(fixture.report.absolutePath, "utf8"), "# Existing test report\n");
});

test("Verification rejects a real Git commit and restores the original HEAD", async () => {
  const fixture = await verificationFixture();
  const root = fixture.project.rootPath;
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await execFileAsync("git", [
    "-c", "user.name=Verification Guard",
    "-c", "user.email=verification@example.invalid",
    "commit", "--quiet", "--allow-empty", "-m", "baseline",
  ], { cwd: root });
  const headBefore = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  await mkdir(path.dirname(fixture.report.absolutePath), { recursive: true });
  await writeFile(fixture.report.absolutePath, "# Existing test report\n", "utf8");
  const stub = await writeRunnerStub(root, "verification-git-commit-stub.mjs", [
    'execFileSync("git", ["-c", "user.name=Attacker", "-c", "user.email=attacker@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "unauthorized"], { cwd: process.cwd() });',
    `writeFileSync(path.join(process.cwd(), ${JSON.stringify(fixture.report.relativePath)}), "# Mutated report\\n", "utf8");`,
  ]);

  await assert.rejects(() => runVerification(fixture, stub), {
    code: "UNSELECTED_OUTPUTS_CHANGED",
  });

  const headAfter = (await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  })).stdout.trim();
  assert.equal(headAfter, headBefore);
  assert.equal(await readFile(fixture.report.absolutePath, "utf8"), "# Existing test report\n");
});

test("Verification protects a worktree-style .git pointer and blocks external metadata before runner execution", async () => {
  const fixture = await verificationFixture();
  const root = fixture.project.rootPath;
  const externalGitDir = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-external-gitdir-"));
  roots.push(externalGitDir);
  await execFileAsync("git", [
    "init", "--quiet", `--separate-git-dir=${externalGitDir}`, root,
  ]);
  const pointerBefore = await readFile(path.join(root, ".git"), "utf8");
  assert.match(pointerBefore, /^gitdir:\s+/u);
  await assert.rejects(
    () => withVerificationWorkspaceProtected(
      {
        projectRoot: root,
        selectedOutputPaths: [fixture.report.absolutePath],
      },
      async () => {
        await writeFile(path.join(root, ".git"), "gitdir: /private/tmp/attacker\n", "utf8");
      },
    ),
    { code: "UNSELECTED_OUTPUTS_CHANGED" },
  );

  assert.equal(await readFile(path.join(root, ".git"), "utf8"), pointerBefore);
  await assert.rejects(
    () => captureVerificationGitState(root),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "VERIFICATION_GIT_STATE_FAILED");
      assert.match((error as Error).message, /linked worktree|git-dir/iu);
      return true;
    },
  );

  const invocationMarker = path.join(root, "runner-was-invoked.txt");
  const stub = await writeRunnerStub(root, "verification-linked-worktree-stub.mjs", [
    'writeFileSync(path.join(process.cwd(), "runner-was-invoked.txt"), "unsafe\n", "utf8");',
    `writeFileSync(path.join(process.cwd(), ${JSON.stringify(fixture.report.relativePath)}), "# Unsafe report\\n", "utf8");`,
  ]);
  await assert.rejects(
    () => runVerification(fixture, stub),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "VERIFICATION_GIT_STATE_FAILED");
      assert.match((error as Error).message, /linked worktree|git-dir/iu);
      return true;
    },
  );
  await assert.rejects(() => readFile(invocationMarker, "utf8"), /ENOENT/u);
  await assert.rejects(() => readFile(fixture.report.absolutePath, "utf8"), /ENOENT/u);
  assert.equal(await readFile(path.join(root, ".git"), "utf8"), pointerBefore);
});

test("Verification blocks a selected report inside an in-project nonstandard Git directory", async () => {
  const fixture = await verificationFixture();
  const root = fixture.project.rootPath;
  const internalGitDirectory = path.join(root, ".vcs-store", "repository");
  await mkdir(path.dirname(internalGitDirectory), { recursive: true });
  await execFileAsync("git", [
    "init", "--quiet", `--separate-git-dir=${internalGitDirectory}`, root,
  ]);
  fixture.report.relativePath = ".vcs-store/repository/HEAD";
  fixture.report.absolutePath = path.join(root, ".vcs-store", "repository", "HEAD");
  const invocationMarker = path.join(root, "runner-was-invoked.txt");
  const stub = await writeRunnerStub(root, "verification-internal-git-hole-stub.mjs", [
    'writeFileSync(path.join(process.cwd(), "runner-was-invoked.txt"), "unsafe\n", "utf8");',
  ]);

  await assert.rejects(
    () => runVerification(fixture, stub),
    (error: unknown) => {
      assert.equal(
        (error as { code?: string }).code,
        "VERIFICATION_WORKSPACE_SNAPSHOT_FAILED",
      );
      assert.match(
        String((error as { details?: { cause?: string } }).details?.cause),
        /Git 元数据|Git metadata/iu,
      );
      return true;
    },
  );
  await assert.rejects(() => readFile(invocationMarker, "utf8"), /ENOENT/u);
  assert.match(await readFile(path.join(root, ".git"), "utf8"), /^gitdir:\s+/u);
  assert.match(await readFile(path.join(internalGitDirectory, "HEAD"), "utf8"), /^ref:\s+/u);
});

test("Verification protects nested .git metadata components too", async () => {
  const fixture = await verificationFixture();
  const root = fixture.project.rootPath;
  const nestedConfig = path.join(root, "packages", "nested", ".git", "config");
  await mkdir(path.dirname(nestedConfig), { recursive: true });
  await mkdir(path.dirname(fixture.report.absolutePath), { recursive: true });
  await writeFile(nestedConfig, "[nested]\nvalue=approved\n", "utf8");
  await writeFile(fixture.report.absolutePath, "# Existing test report\n", "utf8");
  const stub = await writeRunnerStub(root, "verification-nested-git-stub.mjs", [
    'writeFileSync(path.join(process.cwd(), "packages", "nested", ".git", "config"), "[nested]\\nvalue=mutated\\n", "utf8");',
    `writeFileSync(path.join(process.cwd(), ${JSON.stringify(fixture.report.relativePath)}), "# Mutated report\\n", "utf8");`,
  ]);

  await assert.rejects(() => runVerification(fixture, stub), {
    code: "UNSELECTED_OUTPUTS_CHANGED",
  });

  assert.equal(await readFile(nestedConfig, "utf8"), "[nested]\nvalue=approved\n");
  assert.equal(await readFile(fixture.report.absolutePath, "utf8"), "# Existing test report\n");
});

test("Verification read-only Git discovery does not mutate the protected index", async () => {
  const fixture = await verificationFixture();
  const root = fixture.project.rootPath;
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await writeFile(path.join(root, "tracked.txt"), "tracked baseline\n", "utf8");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: root });
  await mkdir(path.dirname(fixture.report.absolutePath), { recursive: true });
  await writeFile(fixture.report.absolutePath, "# Existing test report\n", "utf8");
  const stub = await writeRunnerStub(root, "verification-read-only-git-stub.mjs", [
    'if (process.env.GIT_OPTIONAL_LOCKS !== "0") throw new Error("missing GIT_OPTIONAL_LOCKS=0");',
    'execFileSync("git", ["status", "--short"], { cwd: process.cwd(), stdio: "ignore" });',
    `writeFileSync(path.join(process.cwd(), ${JSON.stringify(fixture.report.relativePath)}), "# Passing report\\n", "utf8");`,
  ]);

  const result = await runVerification(fixture, stub);

  assert.deepEqual(result.artifacts.map((artifact) => artifact.artifactKey), ["test-report"]);
  assert.match(await readFile(fixture.report.absolutePath, "utf8"), /Passing report/u);
});

test("Verification keeps the selected report and explicit Playwright runtime evidence", async () => {
  const fixture = await verificationFixture();
  const root = fixture.project.rootPath;
  await mkdir(path.dirname(fixture.report.absolutePath), { recursive: true });
  await writeFile(fixture.report.absolutePath, "# Existing test report\n", "utf8");

  const stub = await writeRunnerStub(root, "verification-safe-evidence-stub.mjs", [
    'mkdirSync(path.join(process.cwd(), "test-results"), { recursive: true });',
    'mkdirSync(path.join(process.cwd(), "playwright-report"), { recursive: true });',
    'mkdirSync(path.join(process.cwd(), "blob-report"), { recursive: true });',
    'writeFileSync(path.join(process.cwd(), "test-results", "trace.zip"), "trace", "utf8");',
    'writeFileSync(path.join(process.cwd(), "playwright-report", "index.html"), "report", "utf8");',
    'writeFileSync(path.join(process.cwd(), "blob-report", "report.zip"), "blob", "utf8");',
    `writeFileSync(path.join(process.cwd(), ${JSON.stringify(fixture.report.relativePath)}), "# Passing test report\\n\\nplaywright test: passed\\n", "utf8");`,
  ]);

  const result = await runVerification(fixture, stub);

  assert.deepEqual(result.artifacts.map((artifact) => artifact.artifactKey), ["test-report"]);
  assert.match(await readFile(fixture.report.absolutePath, "utf8"), /playwright test: passed/u);
  assert.equal(await readFile(path.join(root, "test-results", "trace.zip"), "utf8"), "trace");
  assert.equal(await readFile(path.join(root, "playwright-report", "index.html"), "utf8"), "report");
  assert.equal(await readFile(path.join(root, "blob-report", "report.zip"), "utf8"), "blob");
});

test("Verification restores an arbitrary nested existing untracked user file", async () => {
  const fixture = await verificationFixture();
  const root = fixture.project.rootPath;
  const userPath = path.join(root, "packages", "foo", "fixtures", "user-owned.bin");
  const before = "user-owned-untracked-content\n";
  await mkdir(path.dirname(userPath), { recursive: true });
  await mkdir(path.dirname(fixture.report.absolutePath), { recursive: true });
  await writeFile(userPath, before, "utf8");
  await writeFile(fixture.report.absolutePath, "# Existing test report\n", "utf8");

  const stub = await writeRunnerStub(root, "verification-untracked-user-file-stub.mjs", [
    'writeFileSync(path.join(process.cwd(), "packages", "foo", "fixtures", "user-owned.bin"), "mutated\\n", "utf8");',
    `writeFileSync(path.join(process.cwd(), ${JSON.stringify(fixture.report.relativePath)}), "# Mutated report\\n", "utf8");`,
  ]);

  await assert.rejects(
    () => runVerification(fixture, stub),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "UNSELECTED_OUTPUTS_CHANGED");
      assert.match(
        JSON.stringify((error as { details?: { changed?: string[] } }).details?.changed),
        /verification-workspace:packages\/foo\/fixtures\/user-owned\.bin/iu,
      );
      return true;
    },
  );

  assert.equal(await readFile(userPath, "utf8"), before);
});

test("Verification removes arbitrary new top-level, nested, and role-control files", async () => {
  const fixture = await verificationFixture();
  const root = fixture.project.rootPath;
  const topLevelPath = path.join(root, "rogue.txt");
  const nestedSpecPath = path.join(root, "packages", "foo", "new.spec.ts");
  const nestedGoPath = path.join(root, "cmd", "new.go");
  const roleControlPath = path.join(root, ".ai-sdlc", "roles", "tester", "injected.md");
  await mkdir(path.dirname(fixture.report.absolutePath), { recursive: true });
  await writeFile(fixture.report.absolutePath, "# Existing test report\n", "utf8");

  const stub = await writeRunnerStub(root, "verification-arbitrary-new-paths-stub.mjs", [
    'mkdirSync(path.join(process.cwd(), "packages", "foo"), { recursive: true });',
    'mkdirSync(path.join(process.cwd(), "cmd"), { recursive: true });',
    'writeFileSync(path.join(process.cwd(), "rogue.txt"), "rogue\\n", "utf8");',
    'writeFileSync(path.join(process.cwd(), "packages", "foo", "new.spec.ts"), "// unauthorized spec\\n", "utf8");',
    'writeFileSync(path.join(process.cwd(), "cmd", "new.go"), "package main\\n", "utf8");',
    'writeFileSync(path.join(process.cwd(), ".ai-sdlc", "roles", "tester", "injected.md"), "# injected\\n", "utf8");',
    `writeFileSync(path.join(process.cwd(), ${JSON.stringify(fixture.report.relativePath)}), "# Mutated report\\n", "utf8");`,
  ]);

  await assert.rejects(
    () => runVerification(fixture, stub),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "UNSELECTED_OUTPUTS_CHANGED");
      const changed = JSON.stringify((error as { details?: { changed?: string[] } }).details?.changed);
      assert.match(changed, /verification-workspace:rogue\.txt/iu);
      assert.match(changed, /verification-workspace:packages\/foo\/new\.spec\.ts/iu);
      assert.match(changed, /verification-workspace:cmd\/new\.go/iu);
      assert.match(changed, /verification-workspace:\.ai-sdlc\/roles\/tester\/injected\.md/iu);
      return true;
    },
  );

  for (const candidate of [topLevelPath, nestedSpecPath, nestedGoPath, roleControlPath]) {
    await assert.rejects(() => readFile(candidate, "utf8"), /ENOENT/u);
  }
});

test("Verification protects a non-Git workspace when git is unavailable", async () => {
  const fixture = await verificationFixture();
  const root = fixture.project.rootPath;
  const sourcePath = path.join(root, "cmd", "existing.go");
  const before = "package approved\n";
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await mkdir(path.dirname(fixture.report.absolutePath), { recursive: true });
  await writeFile(sourcePath, before, "utf8");
  await writeFile(fixture.report.absolutePath, "# Existing test report\n", "utf8");
  await assert.rejects(() => readFile(path.join(root, ".git", "HEAD"), "utf8"), /ENOENT/u);

  const stub = await writeRunnerStub(root, "verification-no-git-stub.mjs", [
    'writeFileSync(path.join(process.cwd(), "cmd", "existing.go"), "package mutated\\n", "utf8");',
    `writeFileSync(path.join(process.cwd(), ${JSON.stringify(fixture.report.relativePath)}), "# Mutated report\\n", "utf8");`,
  ]);
  const previousPath = process.env.PATH;
  process.env.PATH = path.join(root, "intentionally-missing-bin");
  try {
    await assert.rejects(
      () => runVerification(fixture, stub),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "UNSELECTED_OUTPUTS_CHANGED");
        assert.match(
          JSON.stringify((error as { details?: { changed?: string[] } }).details?.changed),
          /verification-workspace:cmd\/existing\.go/iu,
        );
        return true;
      },
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }

  assert.equal(await readFile(sourcePath, "utf8"), before);
});

test("Verification Git discovery fails closed when an unavailable or corrupt repository marker exists above the project", async (context) => {
  await context.test("self-contained project-root repository is supported", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-verification-root-git-"));
    roots.push(root);
    await execFileAsync("git", ["init", "--quiet"], { cwd: root });

    const state = await captureVerificationGitState(root);
    assert.equal(state.kind, "unborn");
    if (state.kind === "unborn") assert.equal(state.repositoryRoot, await realpath(root));
  });

  await context.test("nested project under a parent repository", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-verification-nested-parent-git-"));
    roots.push(parent);
    await execFileAsync("git", ["init", "--quiet"], { cwd: parent });
    const child = path.join(parent, "packages", "nested-project");
    await mkdir(child, { recursive: true });

    await assert.rejects(
      () => captureVerificationGitState(child),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "VERIFICATION_GIT_STATE_FAILED");
        assert.match((error as Error).message, /Git worktree/iu);
        return true;
      },
    );
  });

  await context.test("git binary unavailable under a parent repository", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-verification-parent-git-"));
    roots.push(parent);
    await execFileAsync("git", ["init", "--quiet"], { cwd: parent });
    const child = path.join(parent, "packages", "nested-project");
    await mkdir(child, { recursive: true });

    const previousPath = process.env.PATH;
    process.env.PATH = path.join(child, "intentionally-missing-bin");
    try {
      await assert.rejects(
        () => captureVerificationGitState(child),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "VERIFICATION_GIT_STATE_FAILED");
          return true;
        },
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  await context.test("corrupt parent repository marker", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-verification-corrupt-parent-git-"));
    roots.push(parent);
    await mkdir(path.join(parent, ".git"), { recursive: true });
    const child = path.join(parent, "packages", "nested-project");
    await mkdir(child, { recursive: true });

    await assert.rejects(
      () => captureVerificationGitState(child),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "VERIFICATION_GIT_STATE_FAILED");
        return true;
      },
    );
  });
});

test("Verification runner emits the same workspace revision token used by the guard", async () => {
  const fixture = await verificationFixture();
  const root = fixture.project.rootPath;
  await mkdir(path.dirname(fixture.report.absolutePath), { recursive: true });
  await writeFile(fixture.report.absolutePath, "# Existing test report\n", "utf8");
  const stub = await writeRunnerStub(root, "verification-revision-token-stub.mjs", [
    `writeFileSync(path.join(process.cwd(), ${JSON.stringify(fixture.report.relativePath)}), "# Passing report\\n", "utf8");`,
  ]);
  const baseline = await captureVerificationWorkspaceRevision({
    projectRoot: root,
    selectedOutputPaths: [fixture.report.absolutePath],
  });
  const events: Array<{ eventType: string; payload: unknown }> = [];

  await runVerification(fixture, stub, async (eventType, payload) => {
    events.push({ eventType, payload });
  });

  const started = events.find((event) => event.eventType === "runner.started");
  assert.equal(
    (started?.payload as { workspaceRevisionToken?: string } | undefined)?.workspaceRevisionToken,
    baseline.token,
  );
});

test("first Verification keeps one revision token when selected-report parents are newly created", async () => {
  const fixture = await verificationFixture();
  const root = fixture.project.rootPath;
  const stub = await writeRunnerStub(root, "verification-first-report-token-stub.mjs", [
    `mkdirSync(path.join(process.cwd(), ${JSON.stringify(path.dirname(fixture.report.relativePath))}), { recursive: true });`,
    `writeFileSync(path.join(process.cwd(), ${JSON.stringify(fixture.report.relativePath)}), "# First passing report\\n", "utf8");`,
  ]);
  const baseline = await captureVerificationWorkspaceRevision({
    projectRoot: root,
    selectedOutputPaths: [fixture.report.absolutePath],
  });
  const events: Array<{ eventType: string; payload: unknown }> = [];

  await runVerification(fixture, stub, async (eventType, payload) => {
    events.push({ eventType, payload });
  });
  const after = await captureVerificationWorkspaceRevision({
    projectRoot: root,
    selectedOutputPaths: [fixture.report.absolutePath],
  });
  const started = events.find((event) => event.eventType === "runner.started");
  const emittedToken = (started?.payload as {
    workspaceRevisionToken?: string;
  } | undefined)?.workspaceRevisionToken;

  assert.equal(emittedToken, baseline.token);
  assert.equal(after.token, baseline.token);
  assert.match(await readFile(fixture.report.absolutePath, "utf8"), /First passing report/u);
});

test("Verification restores selected-report ancestor mode mutations", async () => {
  const fixture = await verificationFixture();
  const root = fixture.project.rootPath;
  const ancestor = path.dirname(fixture.report.absolutePath);
  await mkdir(ancestor, { recursive: true });
  await writeFile(fixture.report.absolutePath, "# Existing test report\n", "utf8");
  await chmod(ancestor, 0o755);
  const stub = await writeRunnerStub(root, "verification-report-ancestor-mode-stub.mjs", [
    `chmodSync(path.join(process.cwd(), ${JSON.stringify(path.dirname(fixture.report.relativePath))}), 0o700);`,
    `writeFileSync(path.join(process.cwd(), ${JSON.stringify(fixture.report.relativePath)}), "# Mutated report\\n", "utf8");`,
  ]);

  await assert.rejects(
    () => runVerification(fixture, stub),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "UNSELECTED_OUTPUTS_CHANGED");
      assert.match(
        JSON.stringify((error as { details?: { changed?: string[] } }).details?.changed),
        /verification-workspace:docs\/ai-native\/testing/iu,
      );
      return true;
    },
  );

  assert.equal((await lstat(ancestor)).mode & 0o777, 0o755);
  assert.equal(await readFile(fixture.report.absolutePath, "utf8"), "# Existing test report\n");
});

test("Verification blindly restores a protected file after chmod 000 breaks the post-scan", async () => {
  const fixture = await verificationFixture();
  const root = fixture.project.rootPath;
  const protectedPath = path.join(root, "packages", "foo", "user-owned.txt");
  const before = "protected user bytes\n";
  await mkdir(path.dirname(protectedPath), { recursive: true });
  await mkdir(path.dirname(fixture.report.absolutePath), { recursive: true });
  await writeFile(protectedPath, before, "utf8");
  await chmod(protectedPath, 0o644);
  await writeFile(fixture.report.absolutePath, "# Existing test report\n", "utf8");
  const stub = await writeRunnerStub(root, "verification-chmod-zero-file-stub.mjs", [
    'chmodSync(path.join(process.cwd(), "packages", "foo", "user-owned.txt"), 0o000);',
    `writeFileSync(path.join(process.cwd(), ${JSON.stringify(fixture.report.relativePath)}), "# Mutated report\\n", "utf8");`,
  ]);

  await assert.rejects(
    () => runVerification(fixture, stub),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "VERIFICATION_WORKSPACE_SNAPSHOT_FAILED");
      assert.equal((error as { details?: { restored?: boolean } }).details?.restored, true);
      return true;
    },
  );

  assert.equal(await readFile(protectedPath, "utf8"), before);
  assert.equal((await lstat(protectedPath)).mode & 0o777, 0o644);
  assert.equal(await readFile(fixture.report.absolutePath, "utf8"), "# Existing test report\n");
});

test("Verification blindly restores an unreadable protected directory", async () => {
  const fixture = await verificationFixture();
  const root = fixture.project.rootPath;
  const protectedDirectory = path.join(root, "packages", "foo", "private-data");
  const protectedPath = path.join(protectedDirectory, "state.txt");
  await mkdir(protectedDirectory, { recursive: true });
  await mkdir(path.dirname(fixture.report.absolutePath), { recursive: true });
  await writeFile(protectedPath, "approved state\n", "utf8");
  await chmod(protectedDirectory, 0o755);
  await writeFile(fixture.report.absolutePath, "# Existing test report\n", "utf8");
  const stub = await writeRunnerStub(root, "verification-chmod-zero-directory-stub.mjs", [
    'chmodSync(path.join(process.cwd(), "packages", "foo", "private-data"), 0o000);',
    `writeFileSync(path.join(process.cwd(), ${JSON.stringify(fixture.report.relativePath)}), "# Mutated report\\n", "utf8");`,
  ]);

  await assert.rejects(
    () => runVerification(fixture, stub),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "VERIFICATION_WORKSPACE_SNAPSHOT_FAILED");
      assert.equal((error as { details?: { restored?: boolean } }).details?.restored, true);
      return true;
    },
  );

  assert.equal((await lstat(protectedDirectory)).mode & 0o777, 0o755);
  assert.equal(await readFile(protectedPath, "utf8"), "approved state\n");
  assert.equal(await readFile(fixture.report.absolutePath, "utf8"), "# Existing test report\n");
});

test("Verification restores a protected regular file replaced by a symlink", async () => {
  const fixture = await verificationFixture();
  const root = fixture.project.rootPath;
  const protectedPath = path.join(root, "cmd", "existing.go");
  await mkdir(path.dirname(protectedPath), { recursive: true });
  await mkdir(path.dirname(fixture.report.absolutePath), { recursive: true });
  await writeFile(protectedPath, "package approved\n", "utf8");
  await writeFile(fixture.report.absolutePath, "# Existing test report\n", "utf8");
  const stub = await writeRunnerStub(root, "verification-file-to-symlink-stub.mjs", [
    'rmSync(path.join(process.cwd(), "cmd", "existing.go"), { force: true });',
    'symlinkSync("/private/tmp", path.join(process.cwd(), "cmd", "existing.go"));',
    `writeFileSync(path.join(process.cwd(), ${JSON.stringify(fixture.report.relativePath)}), "# Mutated report\\n", "utf8");`,
  ]);

  await assert.rejects(() => runVerification(fixture, stub), {
    code: "UNSELECTED_OUTPUTS_CHANGED",
  });

  assert.equal((await lstat(protectedPath)).isFile(), true);
  assert.equal(await readFile(protectedPath, "utf8"), "package approved\n");
  assert.equal(await readFile(fixture.report.absolutePath, "utf8"), "# Existing test report\n");
});

test("Verification restores a selected-report ancestor replaced with a file", async () => {
  const fixture = await verificationFixture();
  const root = fixture.project.rootPath;
  const ancestor = path.dirname(fixture.report.absolutePath);
  await mkdir(ancestor, { recursive: true });
  await writeFile(fixture.report.absolutePath, "# Existing test report\n", "utf8");
  const stub = await writeRunnerStub(root, "verification-report-ancestor-type-stub.mjs", [
    `rmSync(path.join(process.cwd(), ${JSON.stringify(path.dirname(fixture.report.relativePath))}), { recursive: true, force: true });`,
    `writeFileSync(path.join(process.cwd(), ${JSON.stringify(path.dirname(fixture.report.relativePath))}), "not a directory\\n", "utf8");`,
  ]);

  await assert.rejects(() => runVerification(fixture, stub));

  assert.equal((await lstat(ancestor)).isDirectory(), true);
  assert.equal(await readFile(fixture.report.absolutePath, "utf8"), "# Existing test report\n");
});

test("Verification removes newly materialized report ancestors when a guarded run is rejected", async () => {
  const fixture = await verificationFixture();
  const root = fixture.project.rootPath;
  const docsRoot = path.join(root, "docs");
  const stub = await writeRunnerStub(root, "verification-new-report-ancestors-stub.mjs", [
    `mkdirSync(path.join(process.cwd(), ${JSON.stringify(path.dirname(fixture.report.relativePath))}), { recursive: true });`,
    'mkdirSync(path.join(process.cwd(), "cmd"), { recursive: true });',
    `writeFileSync(path.join(process.cwd(), ${JSON.stringify(fixture.report.relativePath)}), "# New report\\n", "utf8");`,
    'writeFileSync(path.join(process.cwd(), "cmd", "new.go"), "package main\\n", "utf8");',
  ]);

  await assert.rejects(() => runVerification(fixture, stub), {
    code: "UNSELECTED_OUTPUTS_CHANGED",
  });

  await assert.rejects(() => lstat(fixture.report.absolutePath), /ENOENT/u);
  await assert.rejects(() => lstat(docsRoot), /ENOENT/u);
  await assert.rejects(() => lstat(path.join(root, "cmd", "new.go")), /ENOENT/u);
});

test("Verification removes selected-report parents created by a failed runner before the report", async () => {
  const fixture = await verificationFixture();
  const root = fixture.project.rootPath;
  const docsRoot = path.join(root, "docs");
  const stub = await writeRunnerStub(root, "verification-parent-only-failure-stub.mjs", [
    `mkdirSync(path.join(process.cwd(), ${JSON.stringify(path.dirname(fixture.report.relativePath))}), { recursive: true });`,
    "process.exitCode = 1;",
  ]);

  await assert.rejects(() => runVerification(fixture, stub), {
    code: "CODEX_EXEC_FAILED",
  });

  await assert.rejects(() => lstat(fixture.report.absolutePath), /ENOENT/u);
  await assert.rejects(() => lstat(docsRoot), /ENOENT/u);
});

test("Verification workspace discovery errors fail closed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-verification-missing-root-"));
  const report = path.join(root, "docs", "test-report.md");
  await rm(root, { recursive: true, force: true });

  await assert.rejects(
    () => captureVerificationWorkspaceRevision({
      projectRoot: root,
      selectedOutputPaths: [report],
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "VERIFICATION_WORKSPACE_SNAPSHOT_FAILED");
      return true;
    },
  );
});

async function runVerification(
  fixture: Awaited<ReturnType<typeof verificationFixture>>,
  binary: string,
  onEvent: (eventType: string, payload: unknown) => Promise<void> = async () => undefined,
) {
  return new CodexTerminalRunner({ binary, fake: false }).run(
    {
      executionId: crypto.randomUUID(),
      ...fixture,
      selectedArtifacts: [],
      selectedOutputKeys: ["test-report"],
      ...executionConfig,
    },
    onEvent,
  );
}

async function writeRunnerStub(root: string, name: string, actions: string[]): Promise<string> {
  const stub = path.join(root, name);
  await writeFile(stub, [
    `#!${process.execPath}`,
    'import { execFileSync } from "node:child_process";',
    'import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";',
    'import path from "node:path";',
    "for await (const _chunk of process.stdin) {}",
    ...actions,
    'process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "verification-stub" })}\\n`);',
    "",
  ].join("\n"), "utf8");
  await chmod(stub, 0o755);
  return stub;
}

async function verificationFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-verification-workspace-"));
  roots.push(root);
  await mkdir(path.join(root, ".codex", "agents"), { recursive: true });
  await mkdir(path.join(root, ".ai-sdlc", "roles", "tester"), { recursive: true });
  await writeFile(path.join(root, ".codex", "agents", "tester.toml"), 'name = "tester"\n', "utf8");
  await writeFile(
    path.join(root, ".ai-sdlc", "roles", "tester", "workflow.md"),
    "# Tester workflow\n",
    "utf8",
  );

  const now = new Date().toISOString();
  const run: WorkflowRunDto = {
    id: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    title: "Checkout verification",
    objective: "Execute approved E2E tests without changing implementation",
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  const phase: PhaseDefinition = {
    id: "verification",
    owner: "tester",
    inputs: ["implementation-notes"],
    outputs: ["test-report"],
    gate: "human review",
  };
  const reportRelativePath = `docs/ai-native/testing/checkout--${run.id}-test-report.md`;
  const report = {
    id: "test-report",
    owner: "tester",
    relativePath: reportRelativePath,
    absolutePath: path.join(root, reportRelativePath),
  };
  const implementationNotesRelativePath = `docs/ai-native/engineering/checkout--${run.id}-implementation-notes.md`;
  const definition: LoadedDefinition = {
    version: 1,
    project: { name: "Verification fixture", summary: "Workspace mutation guard" },
    roles: [{ id: "tester", name: "Tester", mission: "Verify", responsibilities: [] }],
    phases: [phase],
    agentClient: "codex",
    agentDirectory: ".codex/agents",
    outputRoot: path.join(root, "docs"),
    artifacts: [
      report,
      {
        id: "implementation-notes",
        owner: "software-engineer",
        relativePath: implementationNotesRelativePath,
        absolutePath: path.join(root, implementationNotesRelativePath),
      },
    ],
    configPath: path.join(root, "ai-native.yaml"),
  };
  const project: ProjectDto = {
    id: run.projectId,
    name: "Verification fixture",
    summary: "Workspace mutation guard",
    rootPath: root,
    configPath: definition.configPath,
    runCount: 1,
    createdAt: now,
    updatedAt: now,
  };
  return { project, run, phase, definition, report };
}
