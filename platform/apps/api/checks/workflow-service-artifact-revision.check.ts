import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { ArtifactDto } from "@ai-sdlc/contracts";

import type { CreateRunPersistence, PgWorkflowStore } from "../src/db/store.ts";
import { AppError } from "../src/domain/errors.ts";
import { CodexTerminalRunner } from "../src/services/codex-runner.ts";
import { ProjectPathPolicy } from "../src/services/project-paths.ts";
import { WorkflowService } from "../src/services/workflow-service.ts";

const roots: string[] = [];
test.after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

test("workflow service keeps the project file and committed human revision identical", async () => {
  const root = await temporaryProject();
  const relativePath = "docs/prd.md";
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "# AI PRD\n", "utf8");
  const current = artifact(relativePath, "# AI PRD\n");
  let persisted:
    | { content: string; contentHash: string; expectedHash: string }
    | undefined;
  const fakeStore = {
    artifactWorkspace: async () => ({
      rootPath: root,
      workflowRunId: randomUUID(),
      phaseId: "discovery" as const,
    }),
    getArtifact: async () => current,
    createHumanArtifactRevision: async (
      _artifactId: string,
      expectedHash: string,
      content: string,
      contentHash: string,
    ) => {
      persisted = { content, contentHash, expectedHash };
      return { ...current, id: randomUUID(), content, contentHash, revision: 2, revisionSource: "human" as const };
    },
  };
  const service = new WorkflowService(
    fakeStore as unknown as PgWorkflowStore,
    new ProjectPathPolicy([root]),
    new CodexTerminalRunner({ fake: true }),
  );

  const next = "# Human PRD\n\nAdjusted scope.\n";
  const revision = await service.createArtifactRevision(current.id, {
    content: next,
    expectedContentHash: current.contentHash,
  });

  assert.equal(await readFile(target, "utf8"), next);
  assert.deepEqual(persisted, {
    content: next,
    contentHash: hash(next),
    expectedHash: current.contentHash,
  });
  assert.equal(revision.contentHash, hash(next));
});

test("workflow service restores the project file when DB revision creation fails", async () => {
  const root = await temporaryProject();
  const relativePath = "docs/spec.md";
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "approved bytes", "utf8");
  const current = artifact(relativePath, "approved bytes");
  const fakeStore = {
    artifactWorkspace: async () => ({
      rootPath: root,
      workflowRunId: randomUUID(),
      phaseId: "design" as const,
    }),
    getArtifact: async () => current,
    createHumanArtifactRevision: async () => {
      assert.equal(await readFile(target, "utf8"), "temporary human bytes");
      throw new AppError("simulated stale revision", 409, "ARTIFACT_REVISION_CONFLICT");
    },
  };
  const service = new WorkflowService(
    fakeStore as unknown as PgWorkflowStore,
    new ProjectPathPolicy([root]),
    new CodexTerminalRunner({ fake: true }),
  );

  await assert.rejects(
    () => service.createArtifactRevision(current.id, {
      content: "temporary human bytes",
      expectedContentHash: current.contentHash,
    }),
    (error: unknown) => (error as { code?: string }).code === "ARTIFACT_REVISION_CONFLICT",
  );
  assert.equal(await readFile(target, "utf8"), "approved bytes");
});

test("an execution cannot enter while a human revision is between file swap and DB commit", async () => {
  const root = await temporaryProject();
  const relativePath = "docs/prd.md";
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "AI bytes", "utf8");
  const current = artifact(relativePath, "AI bytes");
  let enteredStore!: () => void;
  const storeEntered = new Promise<void>((resolve) => { enteredStore = resolve; });
  let finishStore!: () => void;
  const storeGate = new Promise<void>((resolve) => { finishStore = resolve; });
  const now = new Date().toISOString();
  const project = {
    id: randomUUID(), name: "Demo", summary: "Demo", rootPath: root,
    configPath: path.join(root, "ai-native.yaml"), runCount: 1, createdAt: now, updatedAt: now,
  };
  const run = {
    id: randomUUID(), projectId: project.id, title: "Concurrent task", objective: "Test locking",
    status: "active" as const, createdAt: now, updatedAt: now,
  };
  const fakeStore = {
    artifactWorkspace: async () => ({
      rootPath: root,
      workflowRunId: run.id,
      phaseId: "discovery" as const,
    }),
    getArtifact: async () => current,
    createHumanArtifactRevision: async () => {
      enteredStore();
      await storeGate;
      return {
        ...current,
        id: randomUUID(),
        content: "human bytes",
        contentHash: hash("human bytes"),
        revision: 2,
        revisionSource: "human" as const,
      };
    },
    getRun: async () => ({ project, run, phases: [] }),
  };
  const service = new WorkflowService(
    fakeStore as unknown as PgWorkflowStore,
    new ProjectPathPolicy([root]),
    new CodexTerminalRunner({ fake: true }),
  );

  const revisionPromise = service.createArtifactRevision(current.id, {
    content: "human bytes",
    expectedContentHash: current.contentHash,
  });
  await storeEntered;
  assert.equal(await readFile(target, "utf8"), "human bytes");

  await assert.rejects(
    () => service.executePhase(run.id, "discovery", { selectedArtifactIds: [] }),
    (error: unknown) => (error as { code?: string }).code === "PROJECT_WORKSPACE_BUSY",
  );
  finishStore();
  await revisionPromise;
  assert.equal(await readFile(target, "utf8"), "human bytes");
});

test("creating a run atomically pins the design spec path derived from that task", async () => {
  const root = await temporaryProject();
  const templatePath = fileURLToPath(
    new URL("../../../../templates/ai-native.yaml", import.meta.url),
  );
  const config = (await readFile(templatePath, "utf8"))
    .replace("{{PROJECT_NAME}}", JSON.stringify("Demo"))
    .replace("{{PROJECT_SUMMARY}}", JSON.stringify("Demo project"))
    .replace("{{AI_CLIENT}}", JSON.stringify("codex"))
    .replace("{{AGENTS_DIRECTORY}}", JSON.stringify(".codex/agents"));
  await writeFile(path.join(root, "ai-native.yaml"), config, "utf8");
  const designerConfig = path.join(root, ".ai-sdlc", "roles", "designer", "config.yaml");
  await mkdir(path.dirname(designerConfig), { recursive: true });
  await writeFile(designerConfig, "output:\n  subdirectory: ai-native/design\n", "utf8");
  const now = new Date().toISOString();
  const project = {
    id: randomUUID(), name: "Demo", summary: "Demo", rootPath: root,
    configPath: path.join(root, "ai-native.yaml"), runCount: 0, createdAt: now, updatedAt: now,
  };
  let captured: CreateRunPersistence | undefined;
  let createdRun: {
    id: string;
    projectId: string;
    title: string;
    objective: string;
    status: "active";
    createdAt: string;
    updatedAt: string;
  } | undefined;
  const fakeStore = {
    getProject: async () => project,
    createRun: async (
      projectId: string,
      title: string,
      objective: string,
      persistence: CreateRunPersistence,
    ) => {
      captured = persistence;
      createdRun = {
        id: persistence.runId,
        projectId,
        title,
        objective,
        status: "active" as const,
        createdAt: now,
        updatedAt: now,
      };
      return createdRun;
    },
    getRun: async () => ({
      run: createdRun!,
      project,
      phases: [],
      artifactPaths: captured?.artifactPaths ?? {},
    }),
  };
  const service = new WorkflowService(
    fakeStore as unknown as PgWorkflowStore,
    new ProjectPathPolicy([root]),
    new CodexTerminalRunner({ fake: true }),
  );

  const run = await service.createRun(project.id, {
    title: "登录体验改版",
    objective: "明确登录设计规格",
  });

  assert.equal(run.id, captured?.runId);
  assert.deepEqual(captured?.artifactPaths, {
    "design-spec": `docs/ai-native/design/登录体验改版--${run.id}-design-spec.md`,
  });
  const detail = await service.getRun(run.id);
  assert.equal("artifactPaths" in detail, false);
});

function artifact(relativePath: string, content: string): ArtifactDto {
  return {
    id: randomUUID(),
    phaseRunId: randomUUID(),
    artifactKey: "prd",
    filePath: relativePath,
    content,
    contentHash: hash(content),
    reviewStatus: "approved",
    revision: 1,
    revisionSource: "ai",
    parentArtifactId: null,
    createdAt: new Date().toISOString(),
  };
}

async function temporaryProject(): Promise<string> {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-"));
  roots.push(root);
  return root;
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
