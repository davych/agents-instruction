import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { schemaSql } from "../src/db/schema.ts";
import { publicProjectFromRuntime, type RuntimeProject } from "../src/db/store.ts";
import { DeepWikiLiteIndexer } from "../src/services/deepwiki-lite.ts";
import { GitBroker } from "../src/services/git-broker.ts";
import { createGitCredentialRegistryFromEnv } from "../src/services/git-credential-registry.ts";
import { RepositoryPolicy, isPublicNetworkAddress } from "../src/services/repository-policy.ts";

const execFile = promisify(execFileCallback);
const sha = "a".repeat(40);

test("CLOUD-AC-04/07/08/09/12: incremental DDL pins cloud state without rewriting legacy rows", () => {
  assert.match(schemaSql, /source_kind text NOT NULL DEFAULT 'legacy_local'/u);
  assert.match(schemaSql, /CREATE TABLE IF NOT EXISTS managed_workspaces/u);
  assert.match(schemaSql, /base_revision text/u);
  assert.match(schemaSql, /CREATE TABLE IF NOT EXISTS knowledge_snapshots/u);
  assert.match(schemaSql, /UNIQUE \(project_id, revision\)/u);
  assert.match(schemaSql, /CREATE TABLE IF NOT EXISTS ask_threads/u);
  assert.match(schemaSql, /regexp_match\([\s\S]*revision/u);
  assert.match(schemaSql, /download_available boolean NOT NULL DEFAULT false/u);
});

test("CLOUD-AC-03/04/15: repository policy enforces exact HTTPS origins, safe refs, and public DNS", async () => {
  const policy = new RepositoryPolicy({
    allowedOrigins: ["https://git.example.test"],
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
  });
  const validated = await policy.validate(
    "https://git.example.test/team/repository.git",
    "refs/heads/main",
  );
  assert.equal(validated.origin, "https://git.example.test");
  assert.deepEqual(validated.addresses, [{ address: "8.8.8.8", family: 4 }]);

  await assert.rejects(
    policy.validate("https://sub.git.example.test/team/repository.git", "HEAD"),
    /origin/u,
  );
  await assert.rejects(
    policy.validate("https://git.example.test/team/repository.git", "--upload-pack=evil"),
  );
  await assert.rejects(new RepositoryPolicy({
    allowedOrigins: ["https://git.example.test"],
    lookup: async () => [{ address: "127.0.0.1", family: 4 }],
  }).validate("https://git.example.test/repository.git", "HEAD"), /私网|保留/u);
  assert.equal(isPublicNetworkAddress("10.0.0.1"), false);
  assert.equal(isPublicNetworkAddress("169.254.169.254"), false);
  assert.equal(isPublicNetworkAddress("192.88.99.1"), false);
  assert.equal(isPublicNetworkAddress("2001:2::1"), false);
  assert.equal(isPublicNetworkAddress("3fff::1"), false);
  assert.equal(isPublicNetworkAddress("8.8.8.8"), true);
  assert.equal(isPublicNetworkAddress("2606:4700:4700::1111"), true);
});

test("CLOUD-AC-05/15: credential profiles expose only metadata and bind secrets to one exact origin", () => {
  const secret = "not-visible-in-public-output";
  const registry = createGitCredentialRegistryFromEnv({
    AI_SDLC_GIT_CREDENTIAL_PROFILES: JSON.stringify([{
      id: "example",
      label: "Example Git",
      origin: "https://git.example.test",
      username: "git-user",
      secretEnv: "EXAMPLE_GIT_TOKEN",
    }]),
    EXAMPLE_GIT_TOKEN: secret,
  });
  const summaries = registry.summaries();
  assert.deepEqual(summaries, [{
    id: "example",
    label: "Example Git",
    host: "git.example.test",
    available: true,
  }]);
  assert.equal(JSON.stringify(summaries).includes(secret), false);
  assert.equal(registry.resolve("example", { origin: "https://git.example.test" })?.secret, secret);
  assert.throws(
    () => registry.resolve("example", { origin: "https://other.example.test" }),
    /origin/u,
  );
});

test("CLOUD-AC-03/04/05/15: Git Broker uses fixed argv, disables redirects, pins DNS, and keeps secret out of argv", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-git-broker-check-"));
  try {
    const fakeGit = path.join(fixture, "fake-git.sh");
    const logPath = path.join(fixture, "calls.log");
    const destination = path.join(fixture, "managed", "repo");
    await writeFile(fakeGit, [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}`,
      "command_name=''",
      "destination=''",
      "previous=''",
      "for argument in \"$@\"; do",
      "  if [ \"$previous\" = '-C' ]; then destination=\"$argument\"; fi",
      "  case \"$argument\" in init|remote|fetch|ls-tree|checkout|rev-parse|status) command_name=\"$argument\"; break ;; esac",
      "  previous=\"$argument\"",
      "done",
      "if [ \"$command_name\" = 'init' ]; then",
      "  for argument in \"$@\"; do destination=\"$argument\"; done",
      "  mkdir -p \"$destination/.git\"",
      "fi",
      "if [ \"$command_name\" = 'checkout' ]; then printf 'source\\n' > \"$destination/main.ts\"; fi",
      `if [ \"$command_name\" = 'rev-parse' ]; then printf '${sha}\\n'; fi`,
      "if [ \"$command_name\" = 'ls-tree' ]; then",
      "  index=0",
      "  while [ \"$index\" -lt 40 ]; do printf 'src/streamed-path-%03d.ts\\0' \"$index\"; index=$((index + 1)); done",
      "fi",
      "exit 0",
      "",
    ].join("\n"), { mode: 0o700 });
    const secret = "broker-secret-must-not-be-an-argument";
    const credentials = createGitCredentialRegistryFromEnv({
      AI_SDLC_GIT_CREDENTIAL_PROFILES: JSON.stringify([{
        id: "example",
        label: "Example Git",
        origin: "https://git.example.test",
        secretEnv: "EXAMPLE_GIT_TOKEN",
      }]),
      EXAMPLE_GIT_TOKEN: secret,
    });
    const broker = new GitBroker({
      gitBinary: fakeGit,
      credentials,
      maxOutputBytes: 64,
      policy: new RepositoryPolicy({
        allowedOrigins: ["https://git.example.test"],
        lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      }),
    });
    const result = await broker.materialize({
      repositoryUrl: "https://git.example.test/team/repository.git",
      requestedRef: "refs/heads/main",
      credentialProfileId: "example",
      destination,
    });
    assert.equal(result.revision, sha);
    const log = await readFile(logPath, "utf8");
    assert.match(log, /http\.followRedirects=false/u);
    assert.match(log, /http\.curloptResolve=git\.example\.test:443:8\.8\.8\.8/u);
    assert.match(log, /fetch --quiet --no-tags --depth=1 --filter=blob:none origin refs\/heads\/main/u);
    assert.match(log, /ls-tree -r --name-only -z FETCH_HEAD/u);
    assert.doesNotMatch(log, new RegExp(secret, "u"));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("CLOUD-AC-06/07: DeepWiki Lite is deterministic, revision-bound, and excludes sensitive contents", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-deepwiki-check-"));
  try {
    await git(root, ["init", "--initial-branch=main"]);
    await git(root, ["config", "user.name", "AI SDLC Check"]);
    await git(root, ["config", "user.email", "check@example.invalid"]);
    await writeFile(path.join(root, "README.md"), "# Example\n", "utf8");
    await writeFile(path.join(root, "main.ts"), "export const main = true;\n", "utf8");
    await writeFile(path.join(root, ".env"), "TOKEN=deepwiki-secret\n", "utf8");
    await mkdir(path.join(root, ".aws"));
    await mkdir(path.join(root, ".ssh"));
    await writeFile(path.join(root, ".aws", "credentials"), "aws_secret_access_key=secret\n", "utf8");
    await writeFile(path.join(root, ".ssh", "id_ed25519"), "ssh-private-secret\n", "utf8");
    await writeFile(
      path.join(root, "misleading.txt"),
      "-----BEGIN PRIVATE KEY-----\nprivate-key-secret\n-----END PRIVATE KEY-----\n",
      "utf8",
    );
    await git(root, ["add", "--", "."]);
    await git(root, ["commit", "-m", "fixture"]);
    const revision = await git(root, ["rev-parse", "HEAD"]);
    const indexer = new DeepWikiLiteIndexer();
    const first = await indexer.build({ workspaceRoot: root, revision });
    await writeFile(path.join(root, "main.ts"), "dirty worktree must be ignored\n", "utf8");
    const second = await indexer.build({ workspaceRoot: root, revision });
    assert.deepEqual(second, first);
    assert.equal(first.files.some((file) => file.path === ".env"), false);
    assert.equal(first.files.some((file) => file.path === ".aws/credentials"), false);
    assert.equal(first.files.some((file) => file.path === ".ssh/id_ed25519"), false);
    assert.equal(first.files.some((file) => file.path === "misleading.txt"), false);
    assert.equal(JSON.stringify(first).includes("deepwiki-secret"), false);
    assert.equal(first.summary.documents.some((signal) => signal.path === "README.md"), true);
    await assert.rejects(
      indexer.build({ workspaceRoot: root, revision: "b".repeat(40) }),
      /revision/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLOUD-AC-06: DeepWiki Lite bounds unfamiliar languages and long path signals", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-deepwiki-bounds-check-"));
  try {
    await git(root, ["init", "--initial-branch=main"]);
    await git(root, ["config", "user.name", "AI SDLC Check"]);
    await git(root, ["config", "user.email", "check@example.invalid"]);
    for (let index = 0; index < 70; index += 1) {
      await writeFile(
        path.join(root, `file-${index}.mystery-${index.toString().padStart(3, "0")}`),
        `fixture ${index}\n`,
        "utf8",
      );
    }
    await writeFile(path.join(root, `long.${"x".repeat(100)}`), "long extension\n", "utf8");
    const nested = path.join(
      root,
      "src",
      ...Array.from({ length: 15 }, (_value, index) => `${index}-${"segment".repeat(5)}`),
    );
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, "main.ts"), "export const main = true;\n", "utf8");
    await git(root, ["add", "--", "."]);
    await git(root, ["commit", "-m", "bounds fixture"]);
    const revision = await git(root, ["rev-parse", "HEAD"]);

    const index = await new DeepWikiLiteIndexer().build({ workspaceRoot: root, revision });
    const other = index.summary.languages.find(({ language }) => language === "Other");
    const signalSummaries = [
      ...index.summary.entryPoints,
      ...index.summary.keyPaths,
    ].map(({ summary }) => summary);
    assert.ok(index.summary.languages.length <= 64);
    assert.equal(other?.files, 71);
    assert.ok(signalSummaries.some((summary) => summary.endsWith("…")));
    assert.ok(signalSummaries.every((summary) => summary.length <= 500));
    assert.equal(index.summary.truncated, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLOUD-AC-06: DeepWiki streams a tree larger than the old 16 MiB buffer before file truncation", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-deepwiki-stream-check-"));
  try {
    const workspace = path.join(fixture, "workspace");
    const fakeGit = path.join(fixture, "fake-git.mjs");
    const revision = "c".repeat(40);
    const excludedPath = `node_modules/${"x".repeat(4_000)}`;
    const excludedRecord = `100644 blob ${revision} 1\t${excludedPath}\0`;
    const excludedRecords = 4_200;
    assert.ok(
      Buffer.byteLength(excludedRecord) * excludedRecords > 16 * 1024 * 1024,
      "fixture must cross the former aggregate stdout ceiling",
    );
    await mkdir(workspace);
    await writeFile(fakeGit, [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      `const revision = ${JSON.stringify(revision)};`,
      "if (args.includes('rev-parse')) {",
      "  process.stdout.write(`${revision}\\n`);",
      "} else if (args.includes('ls-tree')) {",
      `  const excluded = ${JSON.stringify(excludedRecord)};`,
      `  for (let index = 0; index < ${excludedRecords}; index += 1) process.stdout.write(excluded);`,
      "  process.stdout.write(`100644 blob ${revision} 1\\tREADME.md\\0`);",
      "  process.stdout.write(`100644 blob ${revision} 1\\tsrc/main.ts\\0`);",
      "} else if (args.includes('cat-file')) {",
      "  process.stdout.write('x');",
      "} else {",
      "  process.exitCode = 1;",
      "}",
      "",
    ].join("\n"), { mode: 0o700 });

    const index = await new DeepWikiLiteIndexer({
      gitBinary: fakeGit,
      gitMaxBufferBytes: 1_024,
      gitTimeoutMs: 30_000,
      maxFiles: 1,
    }).build({ workspaceRoot: workspace, revision });

    assert.equal(index.summary.fileCount, 1);
    assert.equal(index.files[0]?.path, "README.md");
    assert.equal(index.summary.truncated, true);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("CLOUD-AC-08: exact-revision Run materialization creates isolated clean workspaces", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-run-snapshot-check-"));
  const managed = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-run-workspaces-check-"));
  try {
    await git(root, ["init", "--initial-branch=main"]);
    await git(root, ["config", "user.name", "AI SDLC Check"]);
    await git(root, ["config", "user.email", "check@example.invalid"]);
    await writeFile(path.join(root, "main.ts"), "export const version = 1;\n", "utf8");
    await git(root, ["add", "--", "."]);
    await git(root, ["commit", "-m", "fixture"]);
    const revision = await git(root, ["rev-parse", "HEAD"]);
    const broker = new GitBroker({
      credentials: createGitCredentialRegistryFromEnv({}),
      policy: new RepositoryPolicy({ allowedOrigins: [] }),
    });
    const first = await broker.materializeFromSnapshot({
      sourceRoot: root,
      revision,
      destination: path.join(managed, "run-one"),
    });
    const second = await broker.materializeFromSnapshot({
      sourceRoot: root,
      revision,
      destination: path.join(managed, "run-two"),
    });
    assert.equal(first.revision, revision);
    assert.equal(second.revision, revision);
    assert.notEqual(first.rootPath, second.rootPath);
    await writeFile(path.join(first.rootPath, "main.ts"), "changed in run one\n", "utf8");
    assert.equal(await readFile(path.join(second.rootPath, "main.ts"), "utf8"), "export const version = 1;\n");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(managed, { recursive: true, force: true });
  }
});

test("CLOUD-AC-08/15: public project mapper drops runtime paths and credential identifiers", () => {
  const now = "2026-08-27T10:00:00.000Z";
  const runtime = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Cloud project",
    summary: "Server managed",
    rootPath: "/srv/private/project",
    configPath: "/srv/private/control/ai-native.yaml",
    runCount: 0,
    createdAt: now,
    updatedAt: now,
    sourceKind: "remote-git",
    repositoryUrl: "https://git.example.test/team/repository.git",
    repositoryHost: "git.example.test",
    requestedRef: "refs/heads/main",
    credentialProfileId: "example",
    repositoryState: "ready",
    currentRevision: sha,
    definitionMode: "managed",
    definitionVersion: "v1",
    operation: null,
    lastSyncedAt: now,
    repositoryErrorMessage: null,
  } satisfies RuntimeProject;
  const publicProject = publicProjectFromRuntime(runtime, {
    credentialProfile: {
      id: "example",
      label: "Example Git",
      host: "git.example.test",
      available: true,
    },
    knowledge: {
      id: "22222222-2222-4222-8222-222222222222",
      status: "ready",
      revision: sha,
      indexedAt: now,
      summary: {
        fileCount: 0,
        totalBytes: 0,
        languages: [], entryPoints: [], documents: [], tests: [], builds: [], keyPaths: [],
        truncated: false,
      },
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    },
  });
  const encoded = JSON.stringify(publicProject);
  assert.equal(encoded.includes("/srv/private"), false);
  assert.equal("rootPath" in publicProject, false);
  assert.equal(publicProject.availableActions.ask, true);
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return stdout.trim();
}
