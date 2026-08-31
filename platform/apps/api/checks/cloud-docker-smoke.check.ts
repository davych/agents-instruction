import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { buildDockerRunSpec } from "../src/services/codex-runner.js";

const execFile = promisify(execFileCallback);
const enabled = process.env.AI_SDLC_RUN_DOCKER_SMOKE === "1";

test("CLOUD-AC-10/Tier D: real Worker reads Control, writes Run, and keeps protected mounts read-only", {
  skip: enabled ? false : "set AI_SDLC_RUN_DOCKER_SMOKE=1 to run the explicit real-Docker tier",
}, async () => {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    throw new Error("Tier-D Docker smoke currently requires a POSIX host");
  }
  const uid = process.getuid();
  const gid = process.getgid();
  if (uid === 0 || gid === 0) throw new Error("Tier-D Docker smoke refuses a root uid or gid");

  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-tier-d-"));
  const workspaceRoot = path.join(parent, "run");
  const controlRoot = path.join(parent, "control");
  const gitRoot = path.join(workspaceRoot, ".git");
  const nonce = randomUUID();
  const maliciousMarker = `REPOSITORY_AUTHORITY_MUST_NOT_LOAD_${randomUUID()}`;
  const dockerBinary = process.env.AI_SDLC_DOCKER_BIN?.trim() || "docker";
  const workerImage = process.env.AI_SDLC_WORKER_IMAGE?.trim() || "ai-sdlc-worker:local";
  try {
    await Promise.all([
      mkdir(gitRoot, { recursive: true }),
      mkdir(controlRoot, { recursive: true }),
      mkdir(path.join(workspaceRoot, ".agents", "skills", "evil"), { recursive: true }),
      mkdir(path.join(workspaceRoot, ".codex"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(controlRoot, "ai-native.yaml"), `probe: ${nonce}\n`, { mode: 0o644 }),
      writeFile(path.join(gitRoot, "HEAD"), "ref: refs/heads/main\n", { mode: 0o644 }),
      writeFile(path.join(workspaceRoot, "AGENTS.md"), maliciousMarker, { mode: 0o644 }),
      writeFile(path.join(workspaceRoot, "CLAUDE.md"), maliciousMarker, { mode: 0o644 }),
      writeFile(
        path.join(workspaceRoot, ".agents", "skills", "evil", "SKILL.md"),
        `---\nname: evil\ndescription: ${maliciousMarker}\n---\n${maliciousMarker}\n`,
        { mode: 0o644 },
      ),
      writeFile(
        path.join(workspaceRoot, ".codex", "config.toml"),
        `model = ${JSON.stringify(maliciousMarker)}\n`,
        { mode: 0o644 },
      ),
    ]);

    const probe = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const expected = process.env.AI_SDLC_SMOKE_NONCE;
const control = fs.readFileSync("/opt/ai-sdlc/control/ai-native.yaml", "utf8").trim();
let controlReadonly = false;
let gitReadonly = false;
try { fs.appendFileSync("/opt/ai-sdlc/control/ai-native.yaml", "mutate"); } catch { controlReadonly = true; }
try { fs.writeFileSync("/workspace/.git/probe", "mutate"); } catch { gitReadonly = true; }
if (control !== "probe: " + expected || !controlReadonly || !gitReadonly) process.exit(41);
fs.writeFileSync(path.join("/workspace", "worker-result.json"), JSON.stringify({
  nonce: expected,
  controlReadonly,
  gitReadonly,
  dockerSocketVisible: fs.existsSync("/var/run/docker.sock")
}));
`;
    const inspected = await execFile(dockerBinary, [
      "image",
      "inspect",
      "--format",
      "{{.Id}}|{{ index .Config.Labels \"com.ai-sdlc.worker\" }}",
      workerImage,
    ], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });
    assert.match(inspected.stdout.trim(), /^sha256:[a-f0-9]{64}\|true$/u);
    const version = await execFile(dockerBinary, [
      "run", "--rm", "--network", "none", workerImage, "codex", "--version",
    ], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 16 * 1024,
    });
    assert.match(version.stdout.trim(), /^codex-cli 0\.144\.1$/u);

    const spec = buildDockerRunSpec({
      executionId: randomUUID(),
      deploymentId: "tier-d-smoke",
      workspaceRoot,
      controlRoot,
      image: workerImage,
      network: "none",
      user: `${uid}:${gid}`,
      cpus: 1,
      memory: "1g",
      pidsLimit: 64,
      tmpfsSize: "64m",
      workerCodexBinary: "node",
      codexArgs: ["-e", probe],
      environment: {
        ...process.env,
        AI_SDLC_SMOKE_NONCE: nonce,
      },
    });
    // The production boundary intentionally forwards only a fixed environment
    // list, so pass the smoke nonce as one explicit Docker env entry here.
    const imageIndex = spec.args.indexOf(workerImage);
    assert.notEqual(imageIndex, -1);
    spec.args.splice(imageIndex, 0, "--env", `AI_SDLC_SMOKE_NONCE=${nonce}`);
    await execFile(dockerBinary, spec.args, {
      env: spec.env,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 64 * 1024,
    });

    const result = JSON.parse(
      await readFile(path.join(workspaceRoot, "worker-result.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.deepEqual(result, {
      nonce,
      controlReadonly: true,
      gitReadonly: true,
      dockerSocketVisible: false,
    });
    assert.equal(
      await readFile(path.join(controlRoot, "ai-native.yaml"), "utf8"),
      `probe: ${nonce}\n`,
    );

    const promptSpec = buildDockerRunSpec({
      executionId: randomUUID(),
      deploymentId: "tier-d-prompt-isolation",
      workspaceRoot,
      controlRoot,
      image: workerImage,
      network: "none",
      user: `${uid}:${gid}`,
      cpus: 1,
      memory: "1g",
      pidsLimit: 64,
      tmpfsSize: "64m",
      workerCodexBinary: "codex",
      codexArgs: [
        "debug", "prompt-input",
        "--config", "project_doc_max_bytes=0",
        "--config", "project_doc_fallback_filenames=[]",
        "authority-probe",
      ],
      environment: process.env,
    });
    const promptInput = await execFile(dockerBinary, promptSpec.args, {
      env: promptSpec.env,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    assert.doesNotMatch(promptInput.stdout, new RegExp(maliciousMarker, "u"));
    assert.match(promptInput.stdout, /<cwd>\/home\/worker<\/cwd>/u);
    assert.match(promptInput.stdout, /authority-probe/u);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
