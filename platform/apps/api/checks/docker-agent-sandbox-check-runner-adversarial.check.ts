import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildDockerAgentCheckRunSpec,
  DockerAgentSandboxCheckRunner,
  type DockerAgentCheckRunSpec,
  type DockerAgentSandboxCheck,
} from "../src/services/agent/docker-agent-sandbox-check-runner.ts";

const approvedCheck: DockerAgentSandboxCheck = {
  id: "unit",
  label: "Unit tests",
  timeoutMs: 30_000,
  argv: ["npm", "test", "--", "--runInBand"],
};

test("CHAT-AC-10/20: Docker check spec fixes the isolation boundary without inheriting host Secrets", async () => {
  const fixture = await workspaceFixture();
  try {
    await mkdir(path.join(fixture.root, ".git"));
    const spec = buildSpec(fixture.root, {
      PATH: "/operator/bin",
      HOME: "/operator/home",
      OPENAI_API_KEY: "sk-proj-host-secret-abcdefghijkl",
      GITHUB_TOKEN: "github_pat_host_secret_abcdefghijkl",
      AWS_SECRET_ACCESS_KEY: "host-aws-secret",
      DATABASE_URL: "postgres://secret@database/db",
      HTTP_PROXY: "http://secret-proxy.invalid",
    });

    assertArgPair(spec, "--network", "none");
    assert.ok(spec.args.includes("--read-only"));
    assertArgPair(spec, "--cap-drop", "ALL");
    assertArgPair(spec, "--security-opt", "no-new-privileges:true");
    assertArgPair(spec, "--user", "10001:10001");
    assert.match(argValue(spec, "--tmpfs"), /^\/tmp:rw,noexec,nosuid,nodev,/u);
    assert.deepEqual(spec.environment, {
      PATH: "/operator/bin",
      HOME: "/operator/home",
    });
    const serialized = JSON.stringify(spec);
    assert.doesNotMatch(serialized, /host-secret|host-aws-secret|secret@database|secret-proxy/u);

    const mounts = argValues(spec, "--mount");
    assert.ok(mounts.some((mount) => mount.includes("dst=/workspace") && !mount.includes("readonly")));
    assert.ok(mounts.some((mount) => mount.includes("dst=/workspace/.git") && mount.includes("readonly")));
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-AC-10: only the operator check definition supplies container argv and public definitions hide it", async () => {
  const fixture = await workspaceFixture();
  try {
    const spec = buildSpec(fixture.root, {});
    const imageIndex = spec.args.lastIndexOf("registry.invalid/agent@sha256:abc123");
    assert.notEqual(imageIndex, -1);
    assert.deepEqual(spec.args.slice(imageIndex + 1), approvedCheck.argv);

    const runner = new DockerAgentSandboxCheckRunner({
      dockerBinary: fixture.dockerBinary,
      deploymentId: "test-deployment",
      image: "registry.invalid/agent@sha256:abc123",
      user: "10001:10001",
      cpus: 1,
      memory: "512m",
      pidsLimit: 128,
      tmpfsSize: "64m",
      checks: [approvedCheck],
      dockerEnvironment: {},
    });
    assert.deepEqual(runner.definitions(), [{
      id: "unit",
      label: "Unit tests",
      timeoutMs: 30_000,
    }]);
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-AC-10/19: shell-style check executables fail validation before Docker is invoked", async () => {
  const fixture = await workspaceFixture();
  try {
    for (const executable of ["sh", "SH", "bash", "zsh", "env", "/bin/sh"]) {
      assert.throws(
        () => buildSpec(fixture.root, {}, {
          ...approvedCheck,
          argv: [executable, "-c", "touch /workspace/escaped"],
        }),
        /Sandbox check argv 无效/u,
      );
    }
  } finally {
    await fixture.dispose();
  }
});

test("CHAT-AC-04/10: an out-of-workspace .git symlink is rejected before mount construction", async () => {
  const fixture = await workspaceFixture();
  try {
    const outsideGit = path.join(fixture.parent, "outside-git");
    await mkdir(outsideGit);
    await symlink(outsideGit, path.join(fixture.root, ".git"));
    assert.throws(
      () => buildSpec(fixture.root, {}),
      /Sandbox Git metadata 超出 Workspace/u,
    );
  } finally {
    await fixture.dispose();
  }
});

function buildSpec(
  workspaceRoot: string,
  dockerEnvironment: NodeJS.ProcessEnv,
  check: DockerAgentSandboxCheck = approvedCheck,
): DockerAgentCheckRunSpec {
  return buildDockerAgentCheckRunSpec({
    deploymentId: "test-deployment",
    executionId: "fixed-test-execution",
    workspaceRoot,
    image: "registry.invalid/agent@sha256:abc123",
    user: "10001:10001",
    cpus: 1,
    memory: "512m",
    pidsLimit: 128,
    tmpfsSize: "64m",
    check,
    dockerEnvironment,
  });
}

function assertArgPair(spec: DockerAgentCheckRunSpec, key: string, expected: string): void {
  assert.equal(argValue(spec, key), expected);
}

function argValue(spec: DockerAgentCheckRunSpec, key: string): string {
  const index = spec.args.indexOf(key);
  assert.notEqual(index, -1, `missing ${key}`);
  return spec.args[index + 1] ?? "";
}

function argValues(spec: DockerAgentCheckRunSpec, key: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < spec.args.length; index += 1) {
    if (spec.args[index] === key) values.push(spec.args[index + 1] ?? "");
  }
  return values;
}

async function workspaceFixture(): Promise<{
  parent: string;
  root: string;
  dockerBinary: string;
  dispose(): Promise<void>;
}> {
  const parent = await mkdtemp(path.join(tmpdir(), "docker-agent-runner-adversarial-"));
  const root = path.join(parent, "workspace");
  await mkdir(root);
  const dockerBinary = path.join(parent, "docker");
  await writeFile(dockerBinary, "#!/bin/sh\nexit 99\n", "utf8");
  await chmod(dockerBinary, 0o755);
  return {
    parent,
    root,
    dockerBinary,
    dispose: () => rm(parent, { recursive: true, force: true }),
  };
}
