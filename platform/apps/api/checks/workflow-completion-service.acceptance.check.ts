import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  CodexReasoningEffort,
  CodexRunnerMode,
  ExecutionDto,
  ExecutionEventDto,
  PhaseRunDto,
  ProjectDto,
  WorkflowRunDto,
} from "@ai-sdlc/contracts";

import type {
  ArtifactRecordInput,
  PgWorkflowStore,
  RunBundle,
  SelectionArtifact,
} from "../src/db/store.ts";
import { resolveTaskArtifactPaths } from "../src/domain/task-artifact-paths.ts";
import { CodexTerminalRunner } from "../src/services/codex-runner.ts";
import { loadDefinition } from "../src/services/definition-loader.ts";
import { initializeCodexProject } from "../src/services/project-initializer.ts";
import { ProjectPathPolicy } from "../src/services/project-paths.ts";
import { WorkflowService } from "../src/services/workflow-service.ts";

// Isolation tier: A — generated independently from AC-WF-004 and the public
// WorkflowService/initializer contracts before implementation inspection.

const temporaryRoots: string[] = [];
test.after(async () => Promise.all(
  temporaryRoots.map((root) => rm(root, { recursive: true, force: true })),
));

test("AC-WF-004/Tier A: Web project creation installs all six native agents for every supported agentClient", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-web-clients-"));
  temporaryRoots.push(parent);
  const roles = ["pm-ba", "designer", "architect", "software-engineer", "tester", "devops"];
  const cases = [
    { client: "codex" as const, directory: ".codex/agents", suffix: ".toml" },
    { client: "claude" as const, directory: ".claude/agents", suffix: ".md" },
    { client: "copilot" as const, directory: ".github/agents", suffix: ".agent.md" },
  ];

  for (const clientCase of cases) {
    const store = new ClientCreationStore();
    const service = new WorkflowService(
      store as unknown as PgWorkflowStore,
      new ProjectPathPolicy([parent]),
      new CodexTerminalRunner({ fake: true }),
    );
    const rootPath = path.join(parent, `project-${clientCase.client}`);
    const result = await service.createProject({
      name: `Project ${clientCase.client}`,
      summary: `Native ${clientCase.client} creation contract`,
      rootPath,
      initialize: true,
      agentClient: clientCase.client,
    });

    const nativeDirectory = path.join(rootPath, ...clientCase.directory.split("/"));
    assert.deepEqual(
      (await readdir(nativeDirectory)).sort(),
      roles.map((role) => `${role}${clientCase.suffix}`).sort(),
    );
    for (const role of roles) {
      assert.match(
        await readFile(path.join(nativeDirectory, `${role}${clientCase.suffix}`), "utf8"),
        /\S/u,
      );
    }
    assert.equal(result.project.rootPath, await realpath(rootPath));
    assert.equal(store.createCalls, 1);
  }
});

test("AC-WF-004/Tier A: an aborted registration never reaches persistence", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-web-aborted-registration-"));
  temporaryRoots.push(parent);
  const rootPath = path.join(parent, "existing-project");
  await initializeCodexProject(
    rootPath,
    "Existing project",
    "Cancellation must fail before registration",
  );
  const store = new ClientCreationStore();
  const service = new WorkflowService(
    store as unknown as PgWorkflowStore,
    new ProjectPathPolicy([parent]),
    new CodexTerminalRunner({ fake: true }),
  );
  const controller = new AbortController();
  controller.abort(new Error("request disconnected before registration"));

  await assert.rejects(
    () => service.createProject({
      name: "Cancelled registration",
      summary: "Must not persist",
      rootPath,
      initialize: false,
      agentClient: "codex",
    }, controller.signal),
    (error: unknown) => (error as { code?: string }).code === "PROJECT_CREATION_ABORTED",
  );
  assert.equal(store.createCalls, 0);
});

test("AC-WF-004/Tier A: initialization commit is followed by registration despite a late disconnect", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-web-commit-boundary-"));
  temporaryRoots.push(parent);
  const rootPath = path.join(parent, "new-project");
  const controller = new AbortController();
  const store = new ClientCreationStore();

  class DisconnectAfterInitializationPolicy extends ProjectPathPolicy {
    calls = 0;

    override async resolveProjectPath(candidate: string, allowMissing = false): Promise<string> {
      this.calls += 1;
      const resolved = await super.resolveProjectPath(candidate, allowMissing);
      if (this.calls === 2) {
        controller.abort(new Error("request disconnected after filesystem commit"));
      }
      return resolved;
    }
  }

  const paths = new DisconnectAfterInitializationPolicy([parent]);
  const service = new WorkflowService(
    store as unknown as PgWorkflowStore,
    paths,
    new CodexTerminalRunner({ fake: true }),
  );
  const result = await service.createProject({
    name: "Committed project",
    summary: "Registration completes after the initializer commit point",
    rootPath,
    initialize: true,
    agentClient: "codex",
  }, controller.signal);

  assert.equal(controller.signal.aborted, true);
  assert.equal(paths.calls, 2);
  assert.equal(store.createCalls, 1);
  assert.equal(result.project.rootPath, await realpath(rootPath));
});

test("AC-WF-001/Tier A: completeExecution persistence failure restores the selected artifact bytes", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "ai-sdlc-complete-rollback-"));
  temporaryRoots.push(parent);
  const requestedRoot = path.join(parent, "project");
  await initializeCodexProject(
    requestedRoot,
    "Persistence rollback",
    "Restore selected output when its database commit fails",
  );
  const rootPath = await realpath(requestedRoot);
  const now = "2026-08-25T09:30:00.000Z";
  const project: ProjectDto = {
    id: randomUUID(),
    name: "Persistence rollback",
    summary: "Restore selected output when its database commit fails",
    rootPath,
    configPath: path.join(rootPath, "ai-native.yaml"),
    runCount: 1,
    createdAt: now,
    updatedAt: now,
  };
  const run: WorkflowRunDto = {
    id: randomUUID(),
    projectId: project.id,
    title: "Atomic PRD regeneration",
    objective: "Do not leave an uncommitted artifact in the project workspace",
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  const definition = resolveTaskArtifactPaths(await loadDefinition(rootPath), run);
  const selected = definition.artifacts.find(({ id }) => id === "prd");
  const unselected = definition.artifacts.find(({ id }) => id === "user-stories");
  assert.ok(selected);
  assert.ok(unselected);
  const baseline = "# Approved project-owned PRD bytes\n";
  await mkdir(path.dirname(selected.absolutePath), { recursive: true });
  await writeFile(selected.absolutePath, baseline, "utf8");

  const currentArtifact = {
    id: randomUUID(),
    phaseRunId: "",
    artifactKey: "prd",
    filePath: selected.relativePath,
    content: baseline,
    contentHash: createHash("sha256").update(baseline).digest("hex"),
    reviewStatus: "changes_requested" as const,
    revision: 1,
    revisionSource: "human" as const,
    parentArtifactId: null,
    createdAt: now,
  };
  const phase: PhaseRunDto = {
    id: randomUUID(),
    workflowRunId: run.id,
    phaseId: "discovery",
    position: 0,
    status: "changes_requested",
    artifacts: [],
    reviews: [],
    executions: [],
    events: [],
    availableArtifacts: [],
    createdAt: now,
    updatedAt: now,
  };
  currentArtifact.phaseRunId = phase.id;
  phase.artifacts.push(currentArtifact, {
    id: randomUUID(),
    phaseRunId: phase.id,
    artifactKey: "user-stories",
    filePath: unselected.relativePath,
    content: "# Approved existing stories\n",
    contentHash: createHash("sha256").update("# Approved existing stories\n").digest("hex"),
    reviewStatus: "approved",
    revision: 1,
    revisionSource: "human",
    parentArtifactId: null,
    createdAt: now,
  });
  const store = new FailingCompletionStore({
    project,
    run,
    phases: [phase],
    artifactPaths: {},
  }, selected.absolutePath, baseline);
  const service = new WorkflowService(
    store as unknown as PgWorkflowStore,
    new ProjectPathPolicy([parent]),
    new CodexTerminalRunner({ fake: true }),
  );

  const execution = await service.executePhase(run.id, "discovery", {
    selectedArtifactIds: [],
    selectedOutputKeys: ["prd"],
  });
  await service.waitForIdle();

  assert.equal(store.completeCalls, 1);
  assert.equal(store.failCalls, 1);
  assert.equal(store.requiredExecution(execution.id).status, "failed");
  assert.equal(
    await readFile(selected.absolutePath, "utf8"),
    baseline,
    "selected output must not outlive a failed database commit",
  );
});

class ClientCreationStore {
  createCalls = 0;

  async createProject(input: {
    name: string;
    summary: string;
    rootPath: string;
    configPath: string;
  }): Promise<ProjectDto> {
    this.createCalls += 1;
    const now = "2026-08-25T09:30:00.000Z";
    return {
      id: randomUUID(),
      ...input,
      runCount: 0,
      createdAt: now,
      updatedAt: now,
    };
  }
}

class FailingCompletionStore {
  completeCalls = 0;
  failCalls = 0;
  private readonly executions = new Map<string, ExecutionDto>();

  constructor(
    private readonly bundle: RunBundle,
    private readonly selectedPath: string,
    private readonly baseline: string,
  ) {}

  async getRun(runId: string): Promise<RunBundle> {
    assert.equal(runId, this.bundle.run.id);
    return this.bundle;
  }

  async selectionArtifacts(runId: string, ids: string[]): Promise<SelectionArtifact[]> {
    assert.equal(runId, this.bundle.run.id);
    assert.deepEqual(ids, []);
    return [];
  }

  async currentArtifactSnapshotsForPhase(runId: string, phaseId: string) {
    assert.equal(runId, this.bundle.run.id);
    assert.equal(phaseId, "discovery");
    return this.bundle.phases[0]!.artifacts.map((artifact) => ({
      ...artifact,
      content: artifact.content ?? "",
    }));
  }

  async createExecution(
    runId: string,
    phaseId: string,
    selectedArtifactIds: string[],
    selectedOutputKeys: string[],
    runnerMode: CodexRunnerMode,
    model: string | null,
    reasoningEffort: CodexReasoningEffort | null,
    command: string,
  ): Promise<ExecutionDto> {
    assert.equal(runId, this.bundle.run.id);
    assert.equal(phaseId, "discovery");
    const phase = this.bundle.phases[0]!;
    const execution: ExecutionDto = {
      id: randomUUID(),
      phaseRunId: phase.id,
      status: "running",
      selectedArtifactIds,
      selectedOutputKeys,
      runnerMode,
      model,
      reasoningEffort,
      command,
      exitCode: null,
      error: null,
      startedAt: "2026-08-25T09:31:00.000Z",
      finishedAt: null,
      createdAt: "2026-08-25T09:31:00.000Z",
    };
    phase.executions.push(execution);
    phase.status = "running";
    this.executions.set(execution.id, execution);
    return execution;
  }

  async appendEvent(
    executionId: string,
    sequence: number,
    eventType: string,
    payload: unknown,
  ): Promise<void> {
    const execution = this.requiredExecution(executionId);
    const event: ExecutionEventDto = {
      id: randomUUID(),
      executionId,
      sequence,
      eventType,
      payload,
      createdAt: "2026-08-25T09:32:00.000Z",
    };
    assert.equal(execution.phaseRunId, this.bundle.phases[0]!.id);
    this.bundle.phases[0]!.events.push(event);
  }

  async completeExecution(
    executionId: string,
    exitCode: number,
    outputs: ArtifactRecordInput[],
  ): Promise<void> {
    this.completeCalls += 1;
    this.requiredExecution(executionId);
    assert.equal(exitCode, 0);
    assert.deepEqual(outputs.map(({ artifactKey }) => artifactKey), ["prd"]);
    assert.notEqual(await readFile(this.selectedPath, "utf8"), this.baseline);
    throw new Error("simulated completeExecution database failure");
  }

  async failExecution(executionId: string, exitCode: number | null, error: string): Promise<void> {
    this.failCalls += 1;
    const execution = this.requiredExecution(executionId);
    execution.status = "failed";
    execution.exitCode = exitCode;
    execution.error = error;
    execution.finishedAt = "2026-08-25T09:33:00.000Z";
    this.bundle.phases[0]!.status = "failed";
  }

  requiredExecution(executionId: string): ExecutionDto {
    const execution = this.executions.get(executionId);
    assert.ok(execution, `missing execution ${executionId}`);
    return execution;
  }
}
