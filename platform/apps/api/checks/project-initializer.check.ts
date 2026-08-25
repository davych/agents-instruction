import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AppError } from "../src/domain/errors.ts";
import { architectureOptionIds, resolveOutputSelection } from "../src/domain/workflow.ts";
import {
  loadArchitectureRulebookContext,
  validateArchitectureRulebookReview,
} from "../src/services/architecture-rulebook-runtime.ts";
import { calculateArchitectureRulebookDigest } from "../src/services/architecture-rulebook-validator.ts";
import { CodexTerminalRunner } from "../src/services/codex-runner.ts";
import { loadDefinition } from "../src/services/definition-loader.ts";
import { initializeCodexProject } from "../src/services/project-initializer.ts";

type InitializerOptions = {
  agentClient?: "codex" | "claude" | "copilot";
  signal?: AbortSignal;
  cliPath?: string;
  timeoutMs?: number;
};
const initializeProject = initializeCodexProject as unknown as (
  rootPath: string,
  name: string,
  summary: string,
  options?: InitializerOptions,
) => Promise<void>;

test("AC3/Tier A: initializer maps agentClient to the CLI client selection", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-initializer-client-"));
  const cliPath = path.join(parent, "recording-cli.mjs");
  const observedPath = path.join(parent, "observed.json");
  const target = path.join(parent, "project");
  try {
    await writeFile(cliPath, `
      import { writeFile } from "node:fs/promises";
      export async function run(args, context) {
        await writeFile(${JSON.stringify(observedPath)}, JSON.stringify({ args, hasSignal: Boolean(context.signal) }));
        return 0;
      }
    `, "utf8");
    await initializeProject(target, "Claude project", "Initializer test", {
      agentClient: "claude",
      cliPath,
    });
    const observed = JSON.parse(await readFile(observedPath, "utf8")) as {
      args: string[];
      hasSignal: boolean;
    };
    assert.deepEqual(observed.args.slice(0, 2), ["init", target]);
    assert.deepEqual(observed.args.slice(-2), ["--client", "claude"]);
    assert.equal(observed.hasSignal, true);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("AC3/Tier A: initializer timeout aborts the CLI and waits for its cleanup", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-initializer-abort-"));
  const cliPath = path.join(parent, "blocking-cli.mjs");
  const cleanupPath = path.join(parent, "cleanup.txt");
  try {
    await writeFile(cliPath, `
      import { writeFile } from "node:fs/promises";
      export async function run(_args, context) {
        await new Promise((resolve, reject) => {
          const abort = () => void writeFile(${JSON.stringify(cleanupPath)}, "complete", "utf8")
            .then(() => reject(context.signal.reason));
          context.signal.addEventListener("abort", abort, { once: true });
        });
      }
    `, "utf8");
    await assert.rejects(
      () => initializeProject(path.join(parent, "project"), "Timeout project", "Abort test", {
        cliPath,
        timeoutMs: 20,
      }),
      /abort|timeout/i,
    );
    assert.equal(existsSync(cleanupPath), true, "initializer must await the aborted CLI cleanup");
    assert.equal(await readFile(cleanupPath, "utf8"), "complete");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("Architect rulebook config fails closed on misspelled fields", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-rulebook-config-"));
  const roleRoot = path.join(projectRoot, ".ai-sdlc", "roles", "architect");
  const configPath = path.join(roleRoot, "config.yaml");
  try {
    await mkdir(roleRoot, { recursive: true });
    for (const misspelledConfig of [
      "rulebook:\n  validaton: required\n  schema_version: 1\n",
      "rulebook:\n  validation: required\n  project_mdoe: brownfield\n  schema_version: 1\n",
    ]) {
      await writeFile(configPath, misspelledConfig, "utf8");
      await assert.rejects(
        loadArchitectureRulebookContext(projectRoot),
        (error: unknown) => error instanceof AppError && error.code === "CONFIG_INVALID",
      );
    }

    await writeFile(configPath, "version: 1\n", "utf8");
    assert.deepEqual(await loadArchitectureRulebookContext(projectRoot), {
      validation: "advisory",
    });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("the web initializer reuses the existing CLI and writes a Codex project", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-init-"));
  const target = path.join(parent, "sample");
  try {
    await initializeCodexProject(target, "Sample", "Line one\nLine two");
    const config = await readFile(path.join(target, "ai-native.yaml"), "utf8");
    assert.match(config, /name: "Sample"/u);
    assert.match(config, /summary: "Line one Line two"/u);
    assert.match(config, /client: "codex"/u);
    await readFile(path.join(target, ".codex", "agents", "pm-ba.toml"), "utf8");
    const frontendRules = await readFile(
      path.join(target, ".ai-sdlc", "roles", "architect", "references", "rules", "frontend.md"),
      "utf8",
    );
    assert.match(frontendRules, /Greenfield[\s\S]*Brownfield[\s\S]*React[\s\S]*Tailwind[\s\S]*Redux Toolkit/u);
    const rulebook = await loadArchitectureRulebookContext(target);
    assert.equal(rulebook.validation, "required");
    assert.ok(rulebook.source);
    assert.equal(rulebook.source.projectMode, "auto");
    const digest = calculateArchitectureRulebookDigest(rulebook.source);
    const digestResult = spawnSync(process.execPath, [
      path.join(target, ".ai-sdlc", "roles", "architect", "scripts", "rulebook-digest.mjs"),
    ], { cwd: target, encoding: "utf8" });
    assert.equal(digestResult.status, 0, digestResult.stderr);
    assert.equal(digestResult.stdout.trim(), digest);
    const definition = await loadDefinition(target);
    assert.deepEqual(
      definition.artifacts
        .filter((artifact) => artifact.owner === "architect")
        .map((artifact) => [artifact.id, artifact.relativePath]),
      [
        ["architecture", "docs/ai-native/architecture/architecture.md"],
        ["architecture-discovery-context", "docs/ai-native/architecture/00-discovery-context.md"],
        ["architecture-options", "docs/ai-native/architecture/00-options.md"],
        ["architecture-c4-context", "docs/ai-native/architecture/01-context.mmd"],
        ["architecture-c4-containers", "docs/ai-native/architecture/02-containers.mmd"],
        ["architecture-adrs", "docs/ai-native/architecture/04-adrs"],
        ["architecture-patterns", "docs/ai-native/architecture/05-patterns.md"],
        ["architecture-nfrs", "docs/ai-native/architecture/06-nfrs.md"],
        ["architecture-adversarial", "docs/ai-native/architecture/07-adversarial.md"],
      ],
    );
    const architecture = definition.phases.find((phase) => phase.id === "architecture");
    assert.ok(architecture);
    const selectedOutputKeys = resolveOutputSelection(
      "architecture",
      architecture.outputs,
    );
    assert.deepEqual(selectedOutputKeys, [
      "architecture",
      "architecture-discovery-context",
      "architecture-options",
    ]);
    const now = new Date().toISOString();
    const project = {
      id: crypto.randomUUID(),
      name: "Sample",
      summary: "Line one Line two",
      rootPath: target,
      configPath: definition.configPath,
      runCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    const run = {
      id: crypto.randomUUID(),
      projectId: project.id,
      title: "Architecture checkpoint",
      objective: "Select one architecture option before selected-state work",
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    };
    const result = await new CodexTerminalRunner({ fake: true }).run({
      executionId: crypto.randomUUID(),
      project,
      run,
      phase: architecture,
      definition,
      selectedArtifacts: [],
      selectedOutputKeys,
      model: null,
      reasoningEffort: null,
    }, async () => undefined);
    assert.deepEqual(
      result.artifacts.map((artifact) => artifact.artifactKey),
      selectedOutputKeys,
    );
    const optionsResult = result.artifacts.find(
      (artifact) => artifact.artifactKey === "architecture-options",
    );
    const discoveryResult = result.artifacts.find(
      (artifact) => artifact.artifactKey === "architecture-discovery-context",
    );
    assert.match(optionsResult?.content ?? "", /## Option A:[\s\S]*## Option B:[\s\S]*## Option C:/u);
    assert.match(discoveryResult?.content ?? "", /"id": "api"[\s\S]*"status": "applicable"/u);
    assert.match(discoveryResult?.content ?? "", /"id": "frontend"[\s\S]*"status": "applicable"/u);
    assert.match(optionsResult?.content ?? "", /"ruleId": "API-001"[\s\S]*"ruleId": "FE-004"/u);
    await validateArchitectureRulebookReview({
      projectRoot: target,
      stage: "checkpoint",
      artifacts: result.artifacts.map((artifact) => ({ ...artifact, revisionSource: "ai" as const })),
      documentedOptionIds: architectureOptionIds(optionsResult?.content ?? ""),
    });

    const phaseRunId = crypto.randomUUID();
    const checkpointArtifacts = result.artifacts.map((artifact) => ({
      id: crypto.randomUUID(),
      phaseRunId,
      artifactKey: artifact.artifactKey,
      filePath: artifact.filePath,
      content: artifact.content,
      contentHash: artifact.contentHash,
      reviewStatus: "changes_requested" as const,
      revision: 1,
      revisionSource: "ai" as const,
      parentArtifactId: null,
      createdAt: now,
    }));
    const optionsArtifact = checkpointArtifacts.find(
      (artifact) => artifact.artifactKey === "architecture-options",
    );
    assert.ok(optionsArtifact);
    const architectureSelection = {
      optionId: "B",
      reviewId: crypto.randomUUID(),
      optionsArtifactId: optionsArtifact.id,
      selectedAt: new Date(Date.now() + 1_000).toISOString(),
    };
    const selectedStateOutputKeys = resolveOutputSelection(
      "architecture",
      architecture.outputs,
      undefined,
      selectedOutputKeys,
      { architectureSelectionRecorded: true },
    );
    assert.deepEqual(selectedStateOutputKeys, [
      "architecture",
      "architecture-c4-context",
      "architecture-c4-containers",
      "architecture-adrs",
      "architecture-patterns",
      "architecture-nfrs",
      "architecture-adversarial",
    ]);
    const second = await new CodexTerminalRunner({ fake: true }).run({
      executionId: crypto.randomUUID(),
      project,
      run,
      phase: architecture,
      definition,
      selectedArtifacts: [],
      currentArtifacts: checkpointArtifacts,
      revisionFeedback: ["Selected option: A", "Selected option: B"],
      selectedOutputKeys: selectedStateOutputKeys,
      requireEverySelectedOutputUpdated: true,
      architectureSelection,
      model: null,
      reasoningEffort: null,
    }, async () => undefined);
    assert.deepEqual(
      second.artifacts.map((artifact) => artifact.artifactKey),
      selectedStateOutputKeys,
    );
    const patternsResult = second.artifacts.find(
      (artifact) => artifact.artifactKey === "architecture-patterns",
    );
    assert.match(patternsResult?.content ?? "", /"ruleId": "API-001"[\s\S]*"scopeId": "deterministic-fake"/u);
    assert.match(patternsResult?.content ?? "", /"ruleId": "FE-004"[\s\S]*"state": "not_triggered"/u);
    const finalArtifacts = new Map(result.artifacts.map((artifact) => [
      artifact.artifactKey,
      { ...artifact, revisionSource: "ai" as const },
    ]));
    for (const artifact of second.artifacts) {
      finalArtifacts.set(artifact.artifactKey, { ...artifact, revisionSource: "ai" as const });
    }
    await validateArchitectureRulebookReview({
      projectRoot: target,
      stage: "final",
      artifacts: [...finalArtifacts.values()],
      documentedOptionIds: architectureOptionIds(optionsResult?.content ?? ""),
      architectureSelection,
    });
    assert.equal(
      await readFile(optionsArtifact.filePath.startsWith("docs/")
        ? path.join(target, optionsArtifact.filePath)
        : optionsArtifact.filePath, "utf8"),
      optionsResult?.content,
      "the selected-state execution must not rewrite the reviewed options revision",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
