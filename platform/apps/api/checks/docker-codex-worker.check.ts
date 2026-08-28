import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { ProjectDto, WorkflowRunDto } from "@ai-sdlc/contracts";

import {
  buildDockerRunSpec,
  buildTaskEnvelope,
  CodexTerminalRunner,
  type CodexRunRequest,
} from "../src/services/codex-runner.ts";
import type { LoadedDefinition } from "../src/services/definition-loader.ts";

const execFile = promisify(execFileCallback);

test("CLOUD-AC-10/Tier C: Docker argv fixes the non-root, read-only and exact-mount boundary", () => {
  const spec = buildDockerRunSpec({
    executionId: randomUUID(),
    deploymentId: "test-deployment",
    workspaceRoot: "/srv/ai-sdlc/runs/run-1/repo",
    controlRoot: "/srv/ai-sdlc/control/v1",
    image: "registry.example.invalid/ai-sdlc-worker:0.1.0",
    network: "ai-sdlc-egress",
    user: "10001:10001",
    cpus: 2,
    memory: "4g",
    pidsLimit: 256,
    tmpfsSize: "512m",
    workerCodexBinary: "codex",
    codexArgs: ["exec", "--json", "-C", "/workspace", "-"],
    environment: {
      PATH: "/usr/bin",
      HOME: "/host/home",
      OPENAI_API_KEY: "model-secret",
      CODEX_HOME: "/host/private-codex",
      AI_SDLC_GIT_TOKEN: "git-secret",
      DATABASE_URL: "postgres://secret",
    },
  });

  assert.equal(spec.containerName.startsWith("ai-sdlc-"), true);
  assert.equal(spec.args.includes("--read-only"), true);
  assert.equal(spec.args.includes("ai-sdlc.deployment=test-deployment"), true);
  assert.deepEqual(argumentValue(spec.args, "--user"), "10001:10001");
  assert.deepEqual(argumentValue(spec.args, "--cap-drop"), "ALL");
  assert.deepEqual(argumentValue(spec.args, "--security-opt"), "no-new-privileges:true");
  assert.deepEqual(argumentValue(spec.args, "--pids-limit"), "256");
  assert.deepEqual(argumentValue(spec.args, "--cpus"), "2");
  assert.deepEqual(argumentValue(spec.args, "--memory"), "4g");
  assert.equal(spec.args.filter((value) => value === "--tmpfs").length, 3);
  const tmpfs = repeatedArgumentValues(spec.args, "--tmpfs");
  assert.deepEqual(tmpfs, [
    "/tmp:rw,noexec,nosuid,nodev,size=512m,mode=1777",
    "/home/worker:rw,noexec,nosuid,nodev,size=512m,mode=0777",
    "/home/worker/.codex:rw,noexec,nosuid,nodev,size=512m,mode=0777",
  ]);
  assert.equal(tmpfs.some((value) => /(?:uid|gid)=/u.test(value)), false);
  const mounts = repeatedArgumentValues(spec.args, "--mount");
  assert.equal(mounts.length, 3);
  assert.match(mounts[0]!, /src=\/srv\/ai-sdlc\/runs\/run-1\/repo,dst=\/workspace,/u);
  assert.doesNotMatch(mounts[0]!, /readonly/u);
  assert.match(mounts[1]!, /src=\/srv\/ai-sdlc\/runs\/run-1\/repo\/\.git,dst=\/workspace\/\.git,readonly/u);
  assert.match(mounts[2]!, /src=\/srv\/ai-sdlc\/control\/v1,dst=\/opt\/ai-sdlc\/control,readonly/u);
  assert.equal(spec.args.includes("HOME=/home/worker"), true);
  assert.equal(spec.args.includes("CODEX_HOME=/home/worker/.codex"), true);
  assert.equal(argumentValue(spec.args, "--workdir"), "/home/worker");
  assert.equal(spec.args.includes("--privileged"), false);
  assert.equal(spec.args.some((value) => value.includes("docker.sock")), false);
  assert.equal(spec.env.OPENAI_API_KEY, "model-secret");
  assert.equal(spec.env.CODEX_HOME, undefined);
  assert.equal(spec.env.AI_SDLC_GIT_TOKEN, undefined);
  assert.equal(spec.env.DATABASE_URL, undefined);
  assert.equal(JSON.stringify(spec).includes("git-secret"), false);
  assert.equal(JSON.stringify(spec).includes("postgres://secret"), false);
});

test("CLOUD-AC-10/Tier C: Docker boundary rejects root users, host networks and ambiguous bind paths", () => {
  const base = {
    executionId: randomUUID(),
    deploymentId: "test-deployment",
    workspaceRoot: "/srv/workspace",
    controlRoot: "/srv/control",
    image: "ai-sdlc-worker:0.1.0",
    network: "bridge",
    user: "10001:10001",
    cpus: 1,
    memory: "1g",
    pidsLimit: 64,
    tmpfsSize: "64m",
    workerCodexBinary: "codex",
    codexArgs: ["exec", "-"],
    environment: {},
  };
  assert.throws(
    () => buildDockerRunSpec({ ...base, user: "0:0" }),
    (error: unknown) => (error as { code?: string }).code === "DOCKER_WORKER_CONFIG_INVALID",
  );
  assert.throws(
    () => buildDockerRunSpec({ ...base, network: "host" }),
    (error: unknown) => (error as { code?: string }).code === "DOCKER_WORKER_CONFIG_INVALID",
  );
  assert.throws(
    () => buildDockerRunSpec({ ...base, workspaceRoot: "/srv/bad,workspace" }),
    (error: unknown) => (error as { code?: string }).code === "DOCKER_WORKER_MOUNT_INVALID",
  );
});

test("CLOUD-AC-05/07/Tier C: remote envelope references only container control paths", () => {
  const request = remoteRequest();
  const prompt = buildTaskEnvelope(request);

  assert.match(prompt, /\/opt\/ai-sdlc\/control\/ai-native\.yaml/u);
  assert.match(prompt, /\/opt\/ai-sdlc\/control\/\.codex\/agents\/software-engineer\.toml/u);
  assert.match(prompt, /平台挂载的只读控制包/u);
  assert.match(prompt, /Codex 的主目录故意设在 \/home\/worker/u);
  assert.match(prompt, /所有源码读取、修改、Git 与测试命令都必须把 \/workspace 设为明确工作目录/u);
  assert.doesNotMatch(prompt, /\/server\/private\/run-workspace/u);
  assert.doesNotMatch(prompt, /\/server\/private\/control-pack/u);
});

test("CLOUD-AC-11/Tier C: remote real execution without a Worker fails closed before host execution", async () => {
  const runner = new CodexTerminalRunner({
    binary: "/definitely/must/not/run/codex",
    dockerImage: "",
    fake: false,
  });
  await assert.rejects(
    () => runner.run(remoteRequest(), async () => undefined),
    (error: unknown) => (
      (error as { code?: string }).code === "DOCKER_WORKER_NOT_CONFIGURED"
    ),
  );
});

test("CLOUD-AC-10/Tier C: real execution requires an exact administrator-trusted repository URL", async () => {
  const request = remoteRequest();
  const runner = new CodexTerminalRunner({
    dockerBinary: "/definitely/must/not/run/docker",
    dockerImage: "ai-sdlc-worker:test",
    fake: false,
  });
  await assert.rejects(
    () => runner.run(request, async () => undefined),
    (error: unknown) => (
      (error as { code?: string }).code === "REMOTE_REAL_EXECUTION_NOT_TRUSTED"
    ),
  );
});

test("CLOUD-AC-07/Tier C: remote runner events never persist host workspace or control paths", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-docker-events-"));
  const sourceRoot = path.join(parent, "workspace");
  const controlRoot = path.join(parent, "control");
  const dockerStub = path.join(parent, "docker-stub.mjs");
  const dockerArgsLog = path.join(parent, "docker-args.json");
  try {
    await Promise.all([mkdir(sourceRoot), mkdir(controlRoot)]);
    await execFile("git", ["init", "--initial-branch=main"], { cwd: sourceRoot });
    await writeFile(path.join(controlRoot, "ai-native.yaml"), "version: 1\n", "utf8");
    await writeFile(dockerStub, `#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(dockerArgsLog)}, JSON.stringify(args));
const mounts = args.flatMap((value, index) => args[index - 1] === "--mount" ? [value] : []);
const sourceMount = mounts.find((value) => value.includes("dst=/workspace,"));
const controlMount = mounts.find((value) => value.includes("dst=/opt/ai-sdlc/control,"));
const source = /(?:^|,)src=([^,]+),/.exec(sourceMount ?? "")?.[1];
const control = /(?:^|,)src=([^,]+),/.exec(controlMount ?? "")?.[1];
if (!source || !control) process.exit(90);
const prompt = readFileSync(0, "utf8");
mkdirSync(path.join(source, "docs"), { recursive: true });
writeFileSync(path.join(source, "docs", "implementation-notes.md"), "# Worker output\\n");
process.stdout.write(JSON.stringify({
  type: "item.completed",
  cwd: source,
  item: {
    type: "command_execution",
    status: "completed",
    command: \`inspect \${source} \${control}\`,
    text: \`host roots: \${source} \${control}\`,
    arguments: { source, control, prompt },
    result: { source, control },
    exit_code: 0,
  },
}) + "\\n");
`, "utf8");
    await chmod(dockerStub, 0o700);

    const events: Array<{ eventType: string; payload: unknown }> = [];
    const runner = new CodexTerminalRunner({
      dockerBinary: dockerStub,
      dockerImage: "ai-sdlc-worker:test",
      trustedRepositoryUrls: ["https://git.example.test/team/project.git"],
      fake: false,
      timeoutMs: 10_000,
    });
    await runner.run(remoteRequest(sourceRoot, controlRoot), async (eventType, payload) => {
      events.push({ eventType, payload });
    });

    const persisted = JSON.stringify(events);
    assert.doesNotMatch(persisted, new RegExp(escapeRegExp(sourceRoot), "u"));
    assert.doesNotMatch(persisted, new RegExp(escapeRegExp(controlRoot), "u"));
    assert.match(persisted, /repository:\/\/run-workspace/u);
    assert.match(persisted, /"commandRedacted":true/u);
    assert.match(persisted, /"argumentsRedacted":true/u);
    assert.match(persisted, /"resultRedacted":true/u);
    const dockerArgs = JSON.parse(await readFile(dockerArgsLog, "utf8")) as string[];
    assert.equal(dockerArgs.includes("--ignore-user-config"), true);
    assert.equal(dockerArgs.includes("--ignore-rules"), true);
    assert.equal(dockerArgs.includes("--strict-config"), true);
    assert.equal(dockerArgs.includes("project_doc_max_bytes=0"), true);
    assert.equal(dockerArgs.includes("project_doc_fallback_filenames=[]"), true);
    assert.equal(argumentValue(dockerArgs, "--workdir"), "/home/worker");
    assert.equal(argumentValue(dockerArgs, "--add-dir"), "/workspace");
    assert.equal(argumentValue(dockerArgs, "-C"), "/home/worker");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("CLOUD-AC-11/Tier C: an unconfirmed Worker removal fails closed", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-docker-orphan-"));
  const sourceRoot = path.join(parent, "workspace");
  const controlRoot = path.join(parent, "control");
  const dockerStub = path.join(parent, "docker-stub.mjs");
  try {
    await Promise.all([mkdir(sourceRoot), mkdir(controlRoot)]);
    await execFile("git", ["init", "--initial-branch=main"], { cwd: sourceRoot });
    await writeFile(path.join(controlRoot, "ai-native.yaml"), "version: 1\n", "utf8");
    await writeFile(dockerStub, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "run") process.exit(17);
if (args[0] === "rm") process.exit(1);
if (args[0] === "container" && args[1] === "inspect") process.exit(0);
process.exit(99);
`, "utf8");
    await chmod(dockerStub, 0o700);
    const runner = new CodexTerminalRunner({
      dockerBinary: dockerStub,
      dockerImage: "ai-sdlc-worker:test",
      trustedRepositoryUrls: ["https://git.example.test/team/project.git"],
      fake: false,
      timeoutMs: 10_000,
    });
    await assert.rejects(
      () => runner.run(remoteRequest(sourceRoot, controlRoot), async () => undefined),
      (error: unknown) => (error as { code?: string }).code === "DOCKER_WORKER_CLEANUP_FAILED",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

function remoteRequest(
  sourceRoot = "/server/private/run-workspace",
  controlRoot = "/server/private/control-pack",
): CodexRunRequest {
  const now = "2026-08-27T00:00:00.000Z";
  const project = {
    id: randomUUID(),
    name: "Remote project",
    summary: "Cloud fixture",
    rootPath: sourceRoot,
    configPath: path.join(controlRoot, "ai-native.yaml"),
    runCount: 1,
    createdAt: now,
    updatedAt: now,
    sourceKind: "remote-git",
    repositoryUrl: "https://git.example.test/team/project.git",
    repositoryHost: "git.example.test",
  } satisfies ProjectDto;
  const run: WorkflowRunDto = {
    id: randomUUID(),
    projectId: project.id,
    title: "Remote task",
    objective: "Change one bounded behavior",
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  const phase = {
    id: "implementation" as const,
    owner: "software-engineer",
    inputs: [],
    outputs: ["implementation-notes"],
    gate: "human review",
  };
  const definition: LoadedDefinition = {
    version: 1,
    project: { name: project.name, summary: project.summary },
    roles: [{
      id: "software-engineer",
      name: "Software Engineer",
      mission: "Implement",
      responsibilities: [],
    }],
    phases: [phase],
    sourceRoot,
    controlRoot,
    agentClient: "codex",
    agentDirectory: ".codex/agents",
    outputRoot: path.join(sourceRoot, "docs"),
    releaseEvidenceValidationRequired: false,
    artifacts: [{
      id: "implementation-notes",
      owner: "software-engineer",
      relativePath: "docs/implementation-notes.md",
      absolutePath: path.join(sourceRoot, "docs/implementation-notes.md"),
    }],
    configPath: path.join(controlRoot, "ai-native.yaml"),
  };
  return {
    executionId: randomUUID(),
    project,
    run,
    phase,
    definition,
    selectedArtifacts: [],
    selectedOutputKeys: ["implementation-notes"],
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function argumentValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function repeatedArgumentValues(args: string[], name: string): string[] {
  return args.flatMap((value, index) => value === name && args[index + 1]
    ? [args[index + 1]!]
    : []);
}
