import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { PhaseDefinition, ProjectDto, WorkflowRunDto } from "@ai-sdlc/contracts";

import type { SelectionArtifact } from "../src/db/store.ts";
import { resolveTaskArtifactPaths } from "../src/domain/task-artifact-paths.ts";
import { buildTaskEnvelope, CodexTerminalRunner } from "../src/services/codex-runner.ts";
import type { LoadedDefinition } from "../src/services/definition-loader.ts";
import { loadDefinition } from "../src/services/definition-loader.ts";
import { initializeCodexProject } from "../src/services/project-initializer.ts";
import { validateReleaseEvidence } from "../src/services/release-evidence-validator.ts";

// Isolation tier: A — tests were authored from AC-WF-004/006 and exported
// runner contracts without implementation or diff access.

const temporaryRoots: string[] = [];
test.after(async () => Promise.all(
  temporaryRoots.map((root) => rm(root, { recursive: true, force: true })),
));

test("AC-WF-006/Tier A: a fresh fake Release writes one task-scoped valid runbook and no source/control files", async () => {
  const fixture = await initializedReleaseFixture();
  const sourcePath = path.join(fixture.project.rootPath, "src", "checkout.ts");
  const sourceBefore = "export const checkout = 'approved';\n";
  const configBefore = await readFile(fixture.definition.configPath, "utf8");
  const workflowPath = path.join(
    fixture.project.rootPath,
    ".ai-sdlc",
    "roles",
    "devops",
    "workflow.md",
  );
  const workflowBefore = await readFile(workflowPath, "utf8");
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, sourceBefore, "utf8");

  const result = await new CodexTerminalRunner({ fake: true }).run({
    executionId: randomUUID(),
    ...fixture,
    selectedArtifacts: [],
    selectedOutputKeys: ["release-runbook"],
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  }, async () => undefined);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.artifacts.map(({ artifactKey }) => artifactKey), ["release-runbook"]);
  const [runbook] = result.artifacts;
  assert.ok(runbook);
  assert.equal(runbook.filePath, fixture.runbook.relativePath);
  assert.match(runbook.filePath, new RegExp(fixture.run.id, "u"));
  assert.notEqual(runbook.filePath, "docs/ai-native/operations/release-runbook.md");
  assert.equal(await readFile(fixture.runbook.absolutePath, "utf8"), runbook.content);
  assert.equal(await readFile(sourcePath, "utf8"), sourceBefore);
  assert.equal(await readFile(fixture.definition.configPath, "utf8"), configBefore);
  assert.equal(await readFile(workflowPath, "utf8"), workflowBefore);

  assert.doesNotThrow(() => validateReleaseEvidence({
    artifacts: [{ artifactKey: "release-runbook", content: runbook.content ?? "" }],
  }));
});

test("AC-WF-001/002/Tier A: oversized inputs retain a full hash manifest and explicit truncation disclosure", () => {
  const fixture = envelopeFixture();
  const selectedArtifacts = [
    selectedInput("change-contract", "A", 900_000),
    selectedInput("architecture", "B", 900_000),
    selectedInput("test-report", "C", 900_000),
  ];
  const fullInputBytes = selectedArtifacts.reduce(
    (total, artifact) => total + Buffer.byteLength(artifact.content),
    0,
  );

  const prompt = buildTaskEnvelope({
    executionId: randomUUID(),
    ...fixture,
    selectedArtifacts,
    selectedOutputKeys: ["implementation-notes"],
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  });

  assert.match(prompt, /manifest|清单/iu);
  assert.match(prompt, /truncat|截断/iu);
  assert.ok(
    Buffer.byteLength(prompt) < fullInputBytes,
    "the envelope must be bounded after explicitly disclosing truncation",
  );
  for (const artifact of selectedArtifacts) {
    assert.match(prompt, new RegExp(escapeRegExp(artifact.artifactKey), "u"));
    assert.match(prompt, new RegExp(artifact.contentHash, "u"));
  }
  const finalArtifact = selectedArtifacts.at(-1)!;
  assert.match(
    prompt,
    new RegExp(`${escapeRegExp(finalArtifact.artifactKey)}[\\s\\S]{0,800}${finalArtifact.contentHash}|${finalArtifact.contentHash}[\\s\\S]{0,800}${escapeRegExp(finalArtifact.artifactKey)}`, "u"),
    "even the tail artifact needs a manifest entry tied to its full-content hash",
  );
});

test("AC-WF-001/006/Tier A: Release and Verification restore control, source, selected, and non-selected mutations", async (context) => {
  for (const phaseId of ["release", "verification"] as const) {
    await context.test(phaseId, async () => {
      const fixture = await mutationFixture(phaseId);
      let caught: unknown;
      try {
        await new CodexTerminalRunner({ binary: fixture.stubPath, fake: false }).run({
          executionId: randomUUID(),
          project: fixture.project,
          run: fixture.run,
          phase: fixture.phase,
          definition: fixture.definition,
          selectedArtifacts: [],
          selectedOutputKeys: [fixture.selected.id],
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
        }, async () => undefined);
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof Error, `${phaseId} must reject out-of-scope mutations`);
      assert.equal(
        (caught as { code?: string }).code,
        "UNSELECTED_OUTPUTS_CHANGED",
        `${phaseId} must reject because its write scope changed, not for an unrelated runner error`,
      );
      assert.equal(
        (caught as { details?: { restored?: boolean } }).details?.restored,
        true,
      );
      const changed = JSON.stringify(
        (caught as { details?: { changed?: string[] } }).details?.changed ?? [],
      );
      assert.match(changed, /sidecar/iu);
      assert.match(changed, /workflow\.md/iu);
      assert.match(changed, /src|application\.ts/iu);
      assert.equal(await readFile(fixture.selected.absolutePath, "utf8"), fixture.before.selected);
      assert.equal(await readFile(fixture.unselected.absolutePath, "utf8"), fixture.before.unselected);
      assert.equal(await readFile(fixture.controlPath, "utf8"), fixture.before.control);
      assert.equal(await readFile(fixture.sourcePath, "utf8"), fixture.before.source);
    });
  }
});

async function initializedReleaseFixture(): Promise<{
  project: ProjectDto;
  run: WorkflowRunDto;
  phase: PhaseDefinition;
  definition: LoadedDefinition;
  runbook: LoadedDefinition["artifacts"][number];
}> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-fake-release-"));
  temporaryRoots.push(parent);
  const requestedRoot = path.join(parent, "project");
  await initializeCodexProject(
    requestedRoot,
    "Release fixture",
    "Prepare a task-scoped runbook without changing the product",
  );
  const rootPath = await realpath(requestedRoot);
  const now = "2026-08-25T09:30:00.000Z";
  const projectId = randomUUID();
  const run: WorkflowRunDto = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    projectId,
    title: "Checkout canary release",
    objective: "Prepare evidence for a human production go/no-go decision",
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  const definition = resolveTaskArtifactPaths(await loadDefinition(rootPath), run);
  const phase = definition.phases.find(({ id }) => id === "release");
  const runbook = definition.artifacts.find(({ id }) => id === "release-runbook");
  assert.ok(phase);
  assert.ok(runbook);
  const project: ProjectDto = {
    id: projectId,
    name: "Release fixture",
    summary: "Prepare a task-scoped runbook without changing the product",
    rootPath,
    configPath: definition.configPath,
    runCount: 1,
    createdAt: now,
    updatedAt: now,
  };
  return { project, run, phase, definition, runbook };
}

function envelopeFixture(): {
  project: ProjectDto;
  run: WorkflowRunDto;
  phase: PhaseDefinition;
  definition: LoadedDefinition;
} {
  const now = "2026-08-25T09:30:00.000Z";
  const rootPath = path.join(os.tmpdir(), "ai-sdlc-envelope-public-contract");
  const projectId = randomUUID();
  const run: WorkflowRunDto = {
    id: randomUUID(),
    projectId,
    title: "Oversized evidence",
    objective: "Preserve provenance when prompt material is larger than the envelope budget",
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  const phase: PhaseDefinition = {
    id: "implementation",
    owner: "software-engineer",
    inputs: ["change-contract", "architecture", "test-report"],
    outputs: ["implementation-notes"],
    gate: "human review",
  };
  const definition: LoadedDefinition = {
    version: 1,
    project: { name: "Envelope fixture", summary: "Prompt provenance" },
    roles: [{
      id: "software-engineer",
      name: "Software Engineer",
      mission: "Implement",
      responsibilities: [],
    }],
    phases: [phase],
    agentClient: "codex",
    agentDirectory: ".codex/agents",
    outputRoot: path.join(rootPath, "docs"),
    artifacts: [{
      id: "implementation-notes",
      owner: "software-engineer",
      relativePath: "docs/implementation-notes.md",
      absolutePath: path.join(rootPath, "docs", "implementation-notes.md"),
    }],
    configPath: path.join(rootPath, "ai-native.yaml"),
  };
  const project: ProjectDto = {
    id: projectId,
    name: "Envelope fixture",
    summary: "Prompt provenance",
    rootPath,
    configPath: definition.configPath,
    runCount: 1,
    createdAt: now,
    updatedAt: now,
  };
  return { project, run, phase, definition };
}

function selectedInput(artifactKey: string, fill: string, length: number): SelectionArtifact {
  const now = "2026-08-25T09:30:00.000Z";
  const content = `${fill.repeat(length)}\nTAIL-SENTINEL-${artifactKey}\n`;
  return {
    id: randomUUID(),
    phaseRunId: randomUUID(),
    workflowRunId: randomUUID(),
    artifactKey,
    filePath: `docs/${artifactKey}.md`,
    content,
    contentHash: sha256(content),
    reviewStatus: "approved",
    revision: 1,
    revisionSource: "human",
    parentArtifactId: null,
    sourcePosition: 0,
    sourceStatus: "approved",
    createdAt: now,
  };
}

async function mutationFixture(phaseId: "release" | "verification") {
  const root = await mkdtemp(path.join(os.tmpdir(), `ai-sdlc-${phaseId}-mutation-`));
  temporaryRoots.push(root);
  const owner = phaseId === "release" ? "devops" : "tester";
  const selectedId = phaseId === "release" ? "release-runbook" : "test-report";
  const unselectedId = `${phaseId}-sidecar`;
  const selected = artifactDefinition(root, selectedId);
  const unselected = artifactDefinition(root, unselectedId);
  const controlPath = path.join(root, ".ai-sdlc", "roles", owner, "workflow.md");
  const sourcePath = path.join(root, "src", "application.ts");
  const agentPath = path.join(root, ".codex", "agents", `${owner}.toml`);
  const configPath = path.join(root, "ai-native.yaml");
  const before = {
    selected: `# Approved ${selectedId}\n`,
    unselected: `# Approved ${unselectedId}\n`,
    control: `# Canonical ${owner} workflow\n`,
    source: "export const state = 'approved';\n",
  };
  for (const target of [selected.absolutePath, unselected.absolutePath, controlPath, sourcePath, agentPath]) {
    await mkdir(path.dirname(target), { recursive: true });
  }
  await writeFile(selected.absolutePath, before.selected, "utf8");
  await writeFile(unselected.absolutePath, before.unselected, "utf8");
  await writeFile(controlPath, before.control, "utf8");
  await writeFile(sourcePath, before.source, "utf8");
  await writeFile(agentPath, `name = "${owner}"\n`, "utf8");
  await writeFile(configPath, "version: 1\n", "utf8");

  const now = "2026-08-25T09:30:00.000Z";
  const projectId = randomUUID();
  const run: WorkflowRunDto = {
    id: randomUUID(),
    projectId,
    title: `${phaseId} scope guard`,
    objective: "Reject and restore every out-of-scope mutation",
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  const phase: PhaseDefinition = {
    id: phaseId,
    owner,
    inputs: [],
    outputs: [selectedId, unselectedId],
    gate: "human review",
  };
  const definition: LoadedDefinition = {
    version: 1,
    project: { name: `${phaseId} fixture`, summary: "Mutation rollback" },
    roles: [{ id: owner, name: owner, mission: "Prepare evidence", responsibilities: [] }],
    phases: [phase],
    agentClient: "codex",
    agentDirectory: ".codex/agents",
    outputRoot: path.join(root, "docs"),
    artifacts: [selected, unselected],
    configPath,
  };
  const project: ProjectDto = {
    id: projectId,
    name: `${phaseId} fixture`,
    summary: "Mutation rollback",
    rootPath: root,
    configPath,
    runCount: 1,
    createdAt: now,
    updatedAt: now,
  };

  const stubPath = path.join(root, `${phaseId}-mutation-stub.mjs`);
  await writeFile(stubPath, [
    `#!${process.execPath}`,
    'import { writeFileSync } from "node:fs";',
    'import path from "node:path";',
    "for await (const _chunk of process.stdin) {}",
    'if (process.env.GIT_OPTIONAL_LOCKS !== "0") throw new Error("missing GIT_OPTIONAL_LOCKS=0");',
    `writeFileSync(path.join(process.cwd(), ${JSON.stringify(selected.relativePath)}), "# Mutated selected output\\n", "utf8");`,
    `writeFileSync(path.join(process.cwd(), ${JSON.stringify(unselected.relativePath)}), "# Mutated unselected output\\n", "utf8");`,
    `writeFileSync(path.join(process.cwd(), ${JSON.stringify(path.relative(root, controlPath))}), "# Mutated control\\n", "utf8");`,
    `writeFileSync(path.join(process.cwd(), ${JSON.stringify(path.relative(root, sourcePath))}), "export const state = 'mutated';\\n", "utf8");`,
    'process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "scope-guard" })}\\n`);',
    "",
  ].join("\n"), "utf8");
  await chmod(stubPath, 0o755);

  return {
    root,
    project,
    run,
    phase,
    definition,
    selected,
    unselected,
    controlPath,
    sourcePath,
    stubPath,
    before,
  };
}

function artifactDefinition(root: string, id: string) {
  const relativePath = `docs/${id}.md`;
  return {
    id,
    owner: id.startsWith("release") ? "devops" : "tester",
    relativePath,
    absolutePath: path.join(root, relativePath),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
