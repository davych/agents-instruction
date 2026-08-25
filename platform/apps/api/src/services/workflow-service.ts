import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  PHASE_ROUTE_VERSION,
  type AssessArchitectureWaiverInput,
  type AssessDesignImpactInput,
  type AssessProductImpactInput,
  type ArchitectureBaselineDto,
  type ArchitectureImpactDto,
  type AssessArchitectureImpactInput,
  type ChangeContractDto,
  type CaptureHumanDecisionsInput,
  type ConfigureE2eWorkspaceInput,
  type CreateArtifactRevisionInput,
  type CreateProjectInput,
  type CreateRunInput,
  type AuthorVerificationE2eInput,
  type DesignBaselineDto,
  type E2eAuthoringDto,
  type E2eReadinessItemDto,
  type E2eWorkspaceDto,
  type E2eWorkspaceReadinessDto,
  type ExecutePhaseInput,
  type ExecutionDto,
  type FigmaIntegrationStatusDto,
  type FigmaPlanCapabilitiesDto,
  type FigmaTarget,
  type HumanDecisionPhaseId,
  type PhaseId,
  type PhaseBaselineDto,
  type PhaseResolutionDto,
  type PhaseRunDto,
  type ProductBaselineDto,
  type ReviewVerificationE2eScriptsInput,
  type ReviewPhaseInput,
  type VerificationE2eFlowDto,
  type WorkflowDefinition
} from "@ai-sdlc/contracts";

import type {
  ApplyPhaseResolutionInput,
  ArchitectureBaselineRecord,
  CurrentArtifactSnapshot,
  PhaseBaselineRecord,
  PgWorkflowStore,
  RunBundle,
  SelectionArtifact,
} from "../db/store.js";
import { AppError } from "../domain/errors.js";
import { deferredDesignValidationIds } from "../domain/design-deferred-validation.js";
import { resolveEngineeringAcceptanceCriteria } from "../domain/engineering-acceptance-criteria.js";
import {
  freezeVerificationE2eIntent,
  type FrozenE2eIntent,
} from "../domain/verification-e2e-intent.js";
import {
  assessPhaseHumanDecisionGate,
  assertPhaseHumanDecisionGateReady,
  humanDecisionSummary,
  serializeHumanDecisionCapture,
} from "../domain/human-decisions.js";
import { assertImplementationReady } from "../domain/implementation-readiness.js";
import {
  findTesterE2eCrystallizationReview,
  testerE2eCrystallizationRevisionFeedback,
} from "../domain/tester-e2e-crystallization-feedback.js";
import {
  CHANGE_CONTRACT_ARTIFACT_KEY,
  effectiveRequiredInputKeys,
  legacyChangeContract,
  linkedChangeContract,
  renderChangeContract,
  validatePhaseResolutionArtifactMutation,
  validatePhaseResolutionExecution,
} from "../domain/change-routing.js";
import {
  pinExistingTaskArtifactPaths,
  resolveTaskArtifactPaths,
  TASK_SCOPED_ARTIFACT_KEYS,
} from "../domain/task-artifact-paths.js";
import { parseUserStoryTickets } from "../domain/user-story-tickets.js";
import {
  architectureOptionIds,
  findArchitectureSelectionEvidence,
  hasArchitectureSelectionMarker,
  hasCompleteArchitectureBootstrap,
  parseArchitectureSelectionId,
  phasePosition,
  requiredArchitecturePostSelectionOutputs,
  requiredApprovalOutputKeys,
  requiredSelectionKeys,
  resolveOutputSelection,
  validateArchitectureImpactOutputs,
  validateArchitectureImpactArtifactMutation,
  validateArchitecturePartialInheritance,
  validateArchitecturePartialExecution,
  validateArchitectureSelectionComment,
  validateArtifactSelection,
  type ArchitectureSelectionEvidence,
} from "../domain/workflow.js";
import { CodexTerminalRunner, type ResolvedFigmaTarget } from "./codex-runner.js";
import {
  CodexExecutionCapabilities,
  type ResolvedCodexExecutionConfig,
} from "./codex-execution-capabilities.js";
import {
  assertRuntimePath,
  prepareArtifactRevision,
  readArtifactContent,
  withArtifactPathsRollbackOnError,
} from "./artifact-workspace.js";
import {
  architectureRulebookValidationRequired,
  validateArchitectureRulebookReview,
} from "./architecture-rulebook-runtime.js";
import { validateDeferredDesignVerificationGate } from "./deferred-design-verification-validator.js";
import {
  engineeringEvidenceRepairFeedback,
  validateEngineeringEvidencePack,
} from "./engineering-evidence-validator.js";
import {
  assertDefinitionAgentFiles,
  loadDefinition,
  type LoadedArtifactDefinition,
  type LoadedDefinition,
} from "./definition-loader.js";
import { validateReleaseEvidence } from "./release-evidence-validator.js";
import type { FigmaMcpIntegration } from "./figma-mcp-integration.js";
import { initializeCodexProject } from "./project-initializer.js";
import { ProjectPathPolicy } from "./project-paths.js";
import type {
  VerificationE2eCoordinator,
  VerificationE2eScriptReviewAuthority,
} from "./verification-e2e-coordinator.js";
import {
  captureVerificationGitState,
  type VerificationGitState,
} from "./verification-git-state.js";
import { validateVerificationEvidenceProvenance } from "./verification-evidence-provenance.js";
import { withVerificationWorkspaceProtected } from "./verification-workspace.js";

interface VerificationE2eDefinitionContext {
  definition: LoadedDefinition;
  phaseDefinition: LoadedDefinition["phases"][number];
  phase: PhaseRunDto;
  reportArtifact: LoadedArtifactDefinition;
}

interface VerificationE2eExecutionContext extends VerificationE2eDefinitionContext {
  bundle: RunBundle;
  selected: SelectionArtifact[];
  currentArtifacts: CurrentArtifactSnapshot[];
  intent: FrozenE2eIntent;
  executionConfig: ResolvedCodexExecutionConfig | null;
}

export class WorkflowService {
  private readonly tasks = new Set<Promise<void>>();
  private readonly artifactRevisionLocks = new Map<string, Promise<void>>();
  private readonly activeWorkspaceMutations = new Set<string>();
  private readonly e2eReadinessCache = new Map<string, {
    descriptorHash: string;
    readiness: E2eWorkspaceReadinessDto;
  }>();

  constructor(
    private readonly store: PgWorkflowStore,
    private readonly paths: ProjectPathPolicy,
    private readonly runner: CodexTerminalRunner,
    private readonly cliPath?: string,
    private readonly figmaIntegration?: FigmaMcpIntegration,
    private readonly codexCapabilities?: CodexExecutionCapabilities,
    private readonly verificationE2e?: Pick<
      VerificationE2eCoordinator,
      | "configure"
      | "workspace"
      | "optionalWorkspace"
      | "prepare"
      | "readiness"
      | "author"
      | "latestAuthoring"
      | "review"
      | "execute"
    >,
  ) {}

  async listProjects() {
    return this.store.listProjects();
  }

  async createProject(input: CreateProjectInput, signal?: AbortSignal) {
    assertProjectCreationActive(signal);
    const summary = input.summary || "由 AI SDLC 平台管理的项目";
    let rootPath = await this.paths.resolveProjectPath(input.rootPath, input.initialize);
    assertProjectCreationActive(signal);
    if (input.initialize) {
      await initializeCodexProject(rootPath, input.name, summary, {
        agentClient: input.agentClient,
        cliPath: this.cliPath,
        signal,
      });
      // A successful initializer return is the filesystem commit point. From
      // here registration must finish even if the HTTP client disconnects;
      // cancelling now would strand a valid initialized tree outside the DB.
      rootPath = await this.paths.resolveProjectPath(rootPath);
    }
    const definition = await loadDefinition(rootPath);
    if (!input.initialize) assertProjectCreationActive(signal);
    const project = await this.store.createProject({
      name: input.name,
      summary: summary || definition.project.summary,
      rootPath,
      configPath: definition.configPath
    });
    return { project, definition: publicDefinition(definition) };
  }

  async getProject(projectId: string) {
    const project = await this.store.getProject(projectId);
    await this.assertProjectPath(project.rootPath);
    const definition = await loadDefinition(project.rootPath);
    return { project, definition: publicDefinition(definition) };
  }

  async getE2eWorkspace(projectId: string): Promise<E2eWorkspaceDto | null> {
    const project = await this.store.getProject(projectId);
    await this.assertProjectPath(project.rootPath);
    return this.requireVerificationE2e().optionalWorkspace(project);
  }

  async configureE2eWorkspace(
    projectId: string,
    input: ConfigureE2eWorkspaceInput,
  ): Promise<E2eWorkspaceDto> {
    const project = await this.store.getProject(projectId);
    await this.assertProjectPath(project.rootPath);
    const releaseWorkspaces = this.acquireWorkspaceMutations([
      project.rootPath,
      path.resolve(input.rootPath),
    ]);
    try {
      const workspace = await this.requireVerificationE2e().configure(project, input);
      this.e2eReadinessCache.delete(project.rootPath);
      return workspace;
    } finally {
      releaseWorkspaces();
    }
  }

  async prepareE2eWorkspace(projectId: string): Promise<{
    result: unknown;
    readiness: E2eWorkspaceReadinessDto;
  }> {
    const project = await this.store.getProject(projectId);
    await this.assertProjectPath(project.rootPath);
    const coordinator = this.requireVerificationE2e();
    const workspace = await coordinator.workspace(project);
    const releaseWorkspaces = this.acquireWorkspaceMutations([
      project.rootPath,
      workspace.rootPath,
    ]);
    try {
      const prepared = await coordinator.prepare(project);
      this.e2eReadinessCache.set(project.rootPath, {
        descriptorHash: workspace.descriptorHash,
        readiness: prepared.readiness,
      });
      return prepared;
    } finally {
      releaseWorkspaces();
    }
  }

  async listRuns(projectId: string) {
    return this.store.listRuns(projectId);
  }

  async createRun(projectId: string, input: CreateRunInput) {
    const project = await this.store.getProject(projectId);
    await this.assertProjectPath(project.rootPath);
    const definition = await loadDefinition(project.rootPath);
    const runId = randomUUID();
    const resolved = resolveTaskArtifactPaths(definition, { id: runId, title: input.title });
    const designSpec = resolved.artifacts.find((artifact) => artifact.id === "design-spec");
    if (!designSpec) {
      throw new AppError("项目没有注册 design-spec 产物", 400, "CONFIG_INVALID");
    }
    let changeContract: ChangeContractDto;
    let runObjective: string;
    if ("sourceRunIds" in input) {
      const sourceRuns = await this.requireProjectSourceRuns(projectId, input.sourceRunIds);
      changeContract = linkedChangeContract(
        input.workType,
        input.expectedBehavior,
        sourceRuns,
      );
      runObjective = input.expectedBehavior;
    } else {
      changeContract = input.changeContract
        ?? legacyChangeContract(input.title, input.objective);
      if (changeContract.sourceRunIds?.length) {
        if (changeContract.workType === "feature") {
          throw new AppError(
            "新功能不能关联原始任务",
            400,
            "SOURCE_RUN_NOT_ALLOWED",
          );
        }
        await this.requireProjectSourceRuns(projectId, changeContract.sourceRunIds);
      }
      runObjective = input.changeContract ? changeContract.summary : input.objective;
    }
    const changeContractArtifact = resolved.artifacts.find(
      (artifact) => artifact.id === CHANGE_CONTRACT_ARTIFACT_KEY,
    );
    const artifactPaths: Record<string, string> = Object.fromEntries(
      resolved.artifacts
        .filter((artifact) =>
          TASK_SCOPED_ARTIFACT_KEYS.has(artifact.id)
          && artifact.id !== CHANGE_CONTRACT_ARTIFACT_KEY
        )
        .map((artifact) => [artifact.id, artifact.relativePath]),
    );
    let materializedChangeContractPath: string | undefined;
    try {
      let persistedChangeContractArtifact;
      if (changeContractArtifact) {
        const content = renderChangeContract(changeContract);
        await assertRuntimePath(project.rootPath, changeContractArtifact.absolutePath);
        await mkdir(path.dirname(changeContractArtifact.absolutePath), { recursive: true });
        await assertRuntimePath(project.rootPath, changeContractArtifact.absolutePath);
        await writeFile(changeContractArtifact.absolutePath, content, {
          encoding: "utf8",
          flag: "wx",
        });
        materializedChangeContractPath = changeContractArtifact.absolutePath;
        artifactPaths[CHANGE_CONTRACT_ARTIFACT_KEY] = changeContractArtifact.relativePath;
        persistedChangeContractArtifact = {
          artifactKey: CHANGE_CONTRACT_ARTIFACT_KEY,
          filePath: changeContractArtifact.relativePath,
          content,
          contentHash: createHash("sha256").update(content).digest("hex"),
        };
      }
      return await this.store.createRun(projectId, input.title, runObjective, {
        runId,
        artifactPaths,
        changeContract,
        changeContractArtifact: persistedChangeContractArtifact,
      });
    } catch (error) {
      if (materializedChangeContractPath) {
        await rm(materializedChangeContractPath, { force: true }).catch(() => undefined);
      }
      throw error;
    }
  }

  private async requireProjectSourceRuns(projectId: string, sourceRunIds: string[]) {
    const projectRuns = await this.store.listRuns(projectId);
    const runsById = new Map(projectRuns.map((run) => [run.id, run]));
    const missingSourceRunIds = sourceRunIds.filter((id) => !runsById.has(id));
    if (missingSourceRunIds.length > 0) {
      throw new AppError(
        "原始任务不存在或不属于当前项目",
        400,
        "SOURCE_RUN_INVALID",
        { sourceRunIds: missingSourceRunIds },
      );
    }
    return sourceRunIds.map((id) => runsById.get(id)!);
  }

  async getRun(runId: string) {
    const bundle = await this.store.getRun(runId);
    await this.assertProjectPath(bundle.project.rootPath);
    const definition = taskDefinition(bundle, await loadDefinition(bundle.project.rootPath));
    attachAvailableArtifacts(bundle, definition);
    const [productBaseline, designBaseline, architectureBaseline] = await Promise.all([
      this.phaseBaselineCandidate(bundle, definition, "discovery"),
      this.phaseBaselineCandidate(bundle, definition, "design"),
      this.architectureBaselineCandidate(bundle, definition),
    ]);
    const { artifactPaths: _internalArtifactPaths, ...publicBundle } = bundle;
    return {
      ...publicBundle,
      definition: publicDefinition(definition),
      productBaseline,
      designBaseline,
      architectureBaseline,
    };
  }

  async getHumanDecisions(runId: string) {
    const bundle = await this.store.getRun(runId);
    await this.assertProjectPath(bundle.project.rootPath);
    const phaseIds: HumanDecisionPhaseId[] = ["discovery", "design", "architecture"];
    const gates = await Promise.all(phaseIds.map(async (phaseId) => {
      const phase = bundle.phases.find((candidate) => candidate.phaseId === phaseId);
      if (!phase) throw new AppError("阶段运行不存在", 404, "PHASE_NOT_FOUND");
      const artifacts = phase.artifacts.length > 0
        ? await this.store.currentArtifactSnapshotsForPhase(runId, phaseId)
        : [];
      const requiredDeferredValidationIds = phaseId === "design"
        ? await this.priorDeferredDesignValidationIds(
          artifacts.find(({ artifactKey }) => artifactKey === "design-spec"),
        )
        : [];
      return assessPhaseHumanDecisionGate({
        phaseId,
        phaseStatus: phase.status,
        artifacts,
        reviews: phase.reviews,
        requiredDeferredValidationIds,
      });
    }));
    return humanDecisionSummary(gates);
  }

  async captureHumanDecisions(
    runId: string,
    phaseId: HumanDecisionPhaseId,
    input: CaptureHumanDecisionsInput,
  ) {
    const initial = await this.store.getRun(runId);
    await this.assertProjectPath(initial.project.rootPath);
    const releaseWorkspace = this.acquireWorkspaceMutation(initial.project.rootPath);
    try {
      const current = await this.store.getRun(runId);
      const phase = current.phases.find((candidate) => candidate.phaseId === phaseId);
      if (!phase) throw new AppError("阶段运行不存在", 404, "PHASE_NOT_FOUND");
      if (!["ready", "awaiting_review", "approved", "changes_requested"].includes(phase.status)) {
        throw new AppError(
          `当前阶段状态 ${phase.status} 不能记录人工决定`,
          409,
          "HUMAN_DECISION_CAPTURE_NOT_ALLOWED",
        );
      }
      const artifacts = await this.store.currentArtifactSnapshotsForPhase(runId, phaseId);
      const gate = assessPhaseHumanDecisionGate({
        phaseId,
        phaseStatus: phase.status,
        artifacts,
        reviews: phase.reviews,
      });
      const actionableIds = new Set(gate.items
        .filter((item) => item.blocking && item.actionPhaseId === phaseId)
        .map(({ id }) => id));
      const invalidIds = input.responses
        .map(({ id }) => id)
        .filter((id) => !actionableIds.has(id));
      if (invalidIds.length > 0) {
        throw new AppError(
          `人工决定已变化或不属于当前角色：${invalidIds.join(", ")}`,
          409,
          "HUMAN_DECISION_STALE",
          { invalidIds, actionableIds: [...actionableIds] },
        );
      }
      const review = await this.store.reviewPhase(
        runId,
        phaseId,
        "request_changes",
        serializeHumanDecisionCapture({ phaseId, responses: input.responses }),
        input.expectedArtifactIds,
        [],
        undefined,
        ["ready", "awaiting_review", "approved", "changes_requested"],
      );
      const detail = await this.getRun(runId);
      return { review, run: detail.run, phases: detail.phases };
    } finally {
      releaseWorkspace();
    }
  }

  async assessArchitectureImpact(runId: string, input: AssessArchitectureImpactInput) {
    const bundle = await this.store.getRun(runId);
    await this.assertProjectPath(bundle.project.rootPath);
    const releaseWorkspace = this.acquireWorkspaceMutation(bundle.project.rootPath);
    try {
      const definition = taskDefinition(bundle, await loadDefinition(bundle.project.rootPath));
      const phaseDefinition = definition.phases.find((phase) => phase.id === "architecture");
      const currentPhase = bundle.phases.find((phase) => phase.phaseId === "architecture");
      if (!phaseDefinition || !currentPhase) {
        throw new AppError("架构阶段不在工作流定义中", 404, "PHASE_NOT_FOUND");
      }
      if (
        currentPhase.status !== "ready"
        || currentPhase.artifacts.length > 0
        || currentPhase.executions.length > 0
        || currentPhase.reviews.length > 0
      ) {
        throw new AppError(
          "Architecture Impact Check 只能在本次架构阶段首次执行前确认",
          409,
          "ARCHITECTURE_IMPACT_NOT_AVAILABLE",
        );
      }

      const selected = await this.store.selectionArtifacts(runId, input.selectedArtifactIds);
      const requiredInputs = effectiveRequiredInputKeys(
        "architecture",
        phaseDefinition.inputs,
        bundle.phases,
        Boolean(bundle.run.changeContract),
        outputKeysByPhase(definition),
      );
      validateArtifactSelection(
        "architecture",
        requiredSelectionKeys("architecture", requiredInputs),
        selected.map((artifact) => ({
          id: artifact.id,
          artifactKey: artifact.artifactKey,
          sourcePosition: artifact.sourcePosition,
          sourceStatus: artifact.sourceStatus,
          reviewStatus: artifact.reviewStatus,
        })),
      );
      await this.validateArtifactWorkspaceSnapshots(bundle.project.rootPath, selected);
      if (input.mode === "partial") {
        validateArchitectureImpactOutputs(phaseDefinition.outputs, input.affectedOutputKeys);
      }

      const baselines = await this.architectureBaselineCandidates(
        bundle.project.id,
        runId,
      );
      const eligible = this.requireEligibleArchitectureBaseline(
        baselines,
        architectureArtifactContracts(definition, phaseDefinition.outputs),
      );
      const currentBaselineIds = eligible.record.artifacts.map((artifact) => artifact.id);
      if (!sameStringSet(currentBaselineIds, input.expectedBaselineArtifactIds)) {
        throw new AppError(
          "架构基线已变化，请刷新后重新执行 Impact Check",
          409,
          "ARCHITECTURE_BASELINE_CHANGED",
          {
            expectedArtifactIds: input.expectedBaselineArtifactIds,
            currentArtifactIds: currentBaselineIds,
          },
        );
      }

      await this.validateArchitectureBaselineWorkspace(
        bundle.project.rootPath,
        eligible.record,
      );
      await validateArchitectureRulebookReview({
        projectRoot: bundle.project.rootPath,
        stage: "final",
        artifacts: eligible.record.artifacts,
        documentedOptionIds: architectureOptionIds(
          eligible.record.artifacts.find(
            (artifact) => artifact.artifactKey === "architecture-options",
          )?.content ?? "",
        ),
        architectureSelection: eligible.selection,
      });

      const impact: ArchitectureImpactDto = {
        mode: input.mode,
        rationale: input.rationale,
        sourceRunId: eligible.record.sourceRunId,
        sourceRunTitle: eligible.record.sourceRunTitle,
        sourcePhaseRunId: eligible.record.sourcePhaseRunId,
        sourceArtifactIds: currentBaselineIds,
        inputArtifactIds: input.selectedArtifactIds,
        affectedOutputKeys: input.mode === "partial" ? input.affectedOutputKeys : [],
        assessedAt: new Date().toISOString(),
        selection: eligible.selection,
      };
      const review = await this.store.adoptArchitectureBaseline(runId, {
        impact,
        expectedBaselineArtifactIds: input.expectedBaselineArtifactIds,
        requiredArtifactKeys: phaseDefinition.outputs,
      });
      return { review };
    } finally {
      releaseWorkspace();
    }
  }

  async assessProductImpact(runId: string, input: AssessProductImpactInput) {
    const bundle = await this.store.getRun(runId);
    await this.assertProjectPath(bundle.project.rootPath);
    const releaseWorkspace = this.acquireWorkspaceMutation(bundle.project.rootPath);
    const createdPaths: string[] = [];
    try {
      const definition = taskDefinition(bundle, await loadDefinition(bundle.project.rootPath));
      const phase = bundle.phases.find((candidate) => candidate.phaseId === "discovery");
      const phaseDefinition = definition.phases.find(
        (candidate) => candidate.id === "discovery",
      );
      if (!phaseDefinition) throw new AppError("Discovery 阶段未定义", 400, "CONFIG_INVALID");
      const routableProductOutputs = phaseDefinition.outputs.filter(
        (key) => key !== CHANGE_CONTRACT_ARTIFACT_KEY,
      );
      const productArtifacts = phase?.artifacts.filter(
        (artifact) => artifact.artifactKey !== CHANGE_CONTRACT_ARTIFACT_KEY,
      ) ?? [];
      if (
        !phase
        || phase.status !== "ready"
        || phase.resolution
        || productArtifacts.length > 0
        || phase.executions.length > 0
        || phase.reviews.length > 0
      ) {
        throw new AppError(
          "Product Impact Check 只能在 Discovery 首次执行前确认",
          409,
          "PHASE_RESOLUTION_NOT_AVAILABLE",
        );
      }
      const contract = bundle.run.changeContract;
      if (!contract) {
        throw new AppError(
          "当前 Run 没有 Change Contract，不能跳过或复用 PM/BA",
          409,
          "CHANGE_CONTRACT_REQUIRED",
        );
      }
      if (input.mode === "direct" && !["bug", "technical"].includes(contract.workType)) {
        throw new AppError(
          "只有预期行为明确的 Bug 或无行为变化的技术任务可以直接采用 Change Contract",
          409,
          "PRODUCT_DIRECT_NOT_ALLOWED",
        );
      }
      if (input.mode === "direct" && contract.evidenceRefs.length === 0) {
        throw new AppError(
          "Product Direct 必须在 Change Contract 中提供至少一条权威预期行为或回归证据引用",
          409,
          "PRODUCT_DIRECT_EVIDENCE_REQUIRED",
        );
      }
      let baseline: PhaseBaselineRecord | null = null;
      if (input.mode === "reuse" || input.mode === "partial") {
        baseline = await this.requirePhaseBaseline(
          bundle.project.id,
          runId,
          "discovery",
          input.expectedBaselineArtifactIds,
          routableProductOutputs,
        );
        const relevant = baseline.artifacts.filter((artifact) =>
          routableProductOutputs.includes(artifact.artifactKey)
        );
        await this.validateArtifactWorkspaceSnapshots(bundle.project.rootPath, relevant);
        if (input.mode === "partial") {
          const allowed = new Set(routableProductOutputs);
          const invalid = input.affectedOutputKeys.filter((key) => !allowed.has(key));
          if (invalid.length > 0) {
            throw new AppError(
              `Product 局部更新包含不允许的输出：${invalid.join(", ")}`,
              400,
              "PHASE_RESOLUTION_OUTPUTS_INVALID",
            );
          }
        }
      }
      const sourceArtifacts = baseline?.artifacts.filter((artifact) =>
        routableProductOutputs.includes(artifact.artifactKey)
      ) ?? [];
      for (const artifact of sourceArtifacts) {
        const target = definition.artifacts.find(
          (candidate) => candidate.id === artifact.artifactKey,
        );
        if (!target || target.relativePath === artifact.filePath) continue;
        const sourcePath = path.resolve(bundle.project.rootPath, artifact.filePath);
        await assertRuntimePath(bundle.project.rootPath, sourcePath);
        await assertRuntimePath(bundle.project.rootPath, target.absolutePath);
        await mkdir(path.dirname(target.absolutePath), { recursive: true });
        await cp(sourcePath, target.absolutePath, {
          recursive: true,
          errorOnExist: true,
          force: false,
          dereference: false,
          preserveTimestamps: true,
        });
        createdPaths.push(target.absolutePath);
      }
      const resolution: PhaseResolutionDto = {
        phaseId: "discovery",
        mode: input.mode,
        rationale: input.rationale,
        inputArtifactIds: [],
        sourceRunId: baseline?.sourceRunId ?? null,
        sourceRunTitle: baseline?.sourceRunTitle ?? null,
        sourcePhaseRunId: baseline?.sourcePhaseRunId ?? null,
        sourceArtifactIds: sourceArtifacts.map((artifact) => artifact.id),
        affectedOutputKeys: input.mode === "partial" ? input.affectedOutputKeys : [],
        routeVersion: PHASE_ROUTE_VERSION,
        decidedAt: new Date().toISOString(),
      } as PhaseResolutionDto;
      const review = await this.store.applyPhaseResolution(runId, {
        resolution,
        expectedBaselineArtifactIds: input.expectedBaselineArtifactIds,
        targetArtifactPaths: Object.fromEntries(sourceArtifacts.map((artifact) => [
          artifact.artifactKey,
          definition.artifacts.find((candidate) => candidate.id === artifact.artifactKey)
            ?.relativePath ?? artifact.filePath,
        ])),
      });
      return { review };
    } catch (error) {
      for (const target of createdPaths) {
        await rm(target, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    } finally {
      releaseWorkspace();
    }
  }

  async assessDesignImpact(runId: string, input: AssessDesignImpactInput) {
    const bundle = await this.store.getRun(runId);
    await this.assertProjectPath(bundle.project.rootPath);
    const releaseWorkspace = this.acquireWorkspaceMutation(bundle.project.rootPath);
    const createdPaths: string[] = [];
    try {
      const definition = taskDefinition(bundle, await loadDefinition(bundle.project.rootPath));
      const phase = bundle.phases.find((candidate) => candidate.phaseId === "design");
      const phaseDefinition = definition.phases.find(
        (candidate) => candidate.id === "design",
      );
      if (!phaseDefinition) throw new AppError("Design 阶段未定义", 400, "CONFIG_INVALID");
      const routableDesignOutputs = [...phaseDefinition.outputs];
      if (
        !phase
        || phase.status !== "ready"
        || phase.artifacts.length > 0
        || phase.executions.length > 0
        || phase.reviews.length > 0
        || phase.resolution
      ) {
        throw new AppError(
          "Design Impact Check 只能在本次 Design 首次执行前确认",
          409,
          "PHASE_RESOLUTION_NOT_AVAILABLE",
        );
      }
      const selected = await this.store.selectionArtifacts(runId, input.selectedArtifactIds);
      const requiredInputs = effectiveRequiredInputKeys(
        "design",
        phaseDefinition.inputs,
        bundle.phases,
        Boolean(bundle.run.changeContract),
        outputKeysByPhase(definition),
      );
      validateArtifactSelection(
        "design",
        requiredInputs,
        selected.map((artifact) => ({
          id: artifact.id,
          artifactKey: artifact.artifactKey,
          sourcePosition: artifact.sourcePosition,
          sourceStatus: artifact.sourceStatus,
          reviewStatus: artifact.reviewStatus,
        })),
      );
      await this.validateArtifactWorkspaceSnapshots(bundle.project.rootPath, selected);
      let baseline: PhaseBaselineRecord | null = null;
      if (input.mode === "reuse" || input.mode === "partial") {
        baseline = await this.requirePhaseBaseline(
          bundle.project.id,
          runId,
          "design",
          input.expectedBaselineArtifactIds,
          routableDesignOutputs,
        );
        const sourceArtifacts = baseline.artifacts.filter((artifact) =>
          routableDesignOutputs.includes(artifact.artifactKey)
        );
        await this.validateArtifactWorkspaceSnapshots(bundle.project.rootPath, sourceArtifacts);
        if (input.mode === "partial") {
          const allowed = new Set(routableDesignOutputs);
          const invalid = input.affectedOutputKeys.filter((key) => !allowed.has(key));
          if (invalid.length > 0 || !input.affectedOutputKeys.includes("design-spec")) {
            throw new AppError(
              "Design 局部更新必须包含 design-spec，且只能修改已注册设计输出",
              400,
              "PHASE_RESOLUTION_OUTPUTS_INVALID",
            );
          }
        }
        for (const artifact of sourceArtifacts) {
          const target = definition.artifacts.find((candidate) => candidate.id === artifact.artifactKey);
          if (!target || target.relativePath === artifact.filePath) continue;
          const sourcePath = path.resolve(bundle.project.rootPath, artifact.filePath);
          await assertRuntimePath(bundle.project.rootPath, sourcePath);
          await assertRuntimePath(bundle.project.rootPath, target.absolutePath);
          await mkdir(path.dirname(target.absolutePath), { recursive: true });
          await cp(sourcePath, target.absolutePath, {
            recursive: true,
            errorOnExist: true,
            force: false,
            dereference: false,
            preserveTimestamps: true,
          });
          createdPaths.push(target.absolutePath);
        }
      }
      const sourceArtifacts = baseline?.artifacts.filter((artifact) =>
        routableDesignOutputs.includes(artifact.artifactKey)
      ) ?? [];
      const resolution: PhaseResolutionDto = {
        phaseId: "design",
        mode: input.mode,
        rationale: input.rationale,
        inputArtifactIds: selected.map((artifact) => artifact.id),
        sourceRunId: baseline?.sourceRunId ?? null,
        sourceRunTitle: baseline?.sourceRunTitle ?? null,
        sourcePhaseRunId: baseline?.sourcePhaseRunId ?? null,
        sourceArtifactIds: sourceArtifacts.map((artifact) => artifact.id),
        affectedOutputKeys: input.mode === "partial" ? input.affectedOutputKeys : [],
        routeVersion: PHASE_ROUTE_VERSION,
        decidedAt: new Date().toISOString(),
      } as PhaseResolutionDto;
      const review = await this.store.applyPhaseResolution(runId, {
        resolution,
        expectedBaselineArtifactIds: input.expectedBaselineArtifactIds,
        targetArtifactPaths: Object.fromEntries(sourceArtifacts.map((artifact) => [
          artifact.artifactKey,
          definition.artifacts.find((candidate) => candidate.id === artifact.artifactKey)
            ?.relativePath ?? artifact.filePath,
        ])),
      });
      return { review };
    } catch (error) {
      for (const target of createdPaths) {
        await rm(target, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    } finally {
      releaseWorkspace();
    }
  }

  async waiveArchitecture(runId: string, input: AssessArchitectureWaiverInput) {
    const bundle = await this.store.getRun(runId);
    await this.assertProjectPath(bundle.project.rootPath);
    const releaseWorkspace = this.acquireWorkspaceMutation(bundle.project.rootPath);
    try {
      const contract = bundle.run.changeContract;
      if (
        !contract
        || !["bug", "technical"].includes(contract.workType)
        || contract.evidenceRefs.length === 0
      ) {
        throw new AppError(
          "只有带明确证据引用的局部 Bug 或无行为变化的技术任务可以声明无架构工作",
          409,
          "ARCHITECTURE_WAIVER_NOT_ALLOWED",
        );
      }
      const phase = bundle.phases.find((candidate) => candidate.phaseId === "architecture");
      if (
        !phase
        || phase.status !== "ready"
        || phase.artifacts.length > 0
        || phase.executions.length > 0
        || phase.reviews.length > 0
        || phase.resolution
      ) {
        throw new AppError(
          "Architecture Impact Check 当前不可用",
          409,
          "PHASE_RESOLUTION_NOT_AVAILABLE",
        );
      }
      const definition = taskDefinition(bundle, await loadDefinition(bundle.project.rootPath));
      const selected = await this.store.selectionArtifacts(runId, input.selectedArtifactIds);
      const requiredInputs = effectiveRequiredInputKeys("architecture", definition.phases.find(
        (candidate) => candidate.id === "architecture",
      )?.inputs ?? [], bundle.phases, Boolean(bundle.run.changeContract), outputKeysByPhase(definition));
      validateArtifactSelection(
        "architecture",
        requiredInputs,
        selected.map((artifact) => ({
          id: artifact.id,
          artifactKey: artifact.artifactKey,
          sourcePosition: artifact.sourcePosition,
          sourceStatus: artifact.sourceStatus,
          reviewStatus: artifact.reviewStatus,
        })),
      );
      await this.validateArtifactWorkspaceSnapshots(bundle.project.rootPath, selected);
      const resolution: PhaseResolutionDto = {
        phaseId: "architecture",
        mode: "skip",
        rationale: input.rationale,
        inputArtifactIds: selected.map((artifact) => artifact.id),
        sourceRunId: null,
        sourceRunTitle: null,
        sourcePhaseRunId: null,
        sourceArtifactIds: [],
        affectedOutputKeys: [],
        routeVersion: PHASE_ROUTE_VERSION,
        decidedAt: new Date().toISOString(),
      };
      const review = await this.store.applyPhaseResolution(runId, {
        resolution,
        expectedBaselineArtifactIds: [],
        targetArtifactPaths: {},
      });
      return { review };
    } finally {
      releaseWorkspace();
    }
  }

  async getVerificationE2eFlow(runId: string): Promise<VerificationE2eFlowDto> {
    const bundle = await this.store.getRun(runId);
    await this.assertProjectPath(bundle.project.rootPath);
    return this.verificationE2eFlow(bundle);
  }

  async preflightVerificationE2e(runId: string): Promise<VerificationE2eFlowDto> {
    const bundle = await this.store.getRun(runId);
    await this.assertProjectPath(bundle.project.rootPath);
    const coordinator = this.requireVerificationE2e();
    const verificationPhase = bundle.phases.find(({ phaseId }) => phaseId === "verification");
    if (
      verificationPhase
      && verificationE2eExecutions(verificationPhase).some(({ status }) => status === "running")
    ) return this.verificationE2eFlow(bundle);
    const workspace = await coordinator.optionalWorkspace(bundle.project);
    if (!workspace) return this.verificationE2eFlow(bundle);
    const releaseWorkspaces = this.acquireWorkspaceMutations([
      bundle.project.rootPath,
      workspace.rootPath,
    ]);
    try {
      const readiness = await coordinator.readiness(bundle.project);
      this.e2eReadinessCache.set(bundle.project.rootPath, {
        descriptorHash: workspace.descriptorHash,
        readiness,
      });
      return this.verificationE2eFlow(bundle, readiness);
    } finally {
      releaseWorkspaces();
    }
  }

  async authorVerificationE2e(
    runId: string,
    input: AuthorVerificationE2eInput,
  ): Promise<ExecutionDto> {
    const initial = await this.store.getRun(runId);
    await this.assertProjectPath(initial.project.rootPath);
    const coordinator = this.requireVerificationE2e();
    const workspace = await coordinator.workspace(initial.project);
    const releaseWorkspaces = this.acquireWorkspaceMutations([
      initial.project.rootPath,
      workspace.rootPath,
    ]);
    let scheduled = false;
    try {
      const context = await this.verificationE2eExecutionContext(runId, input);
      const execution = await this.store.createExecution(
        runId,
        "verification",
        input.selectedArtifactIds,
        [context.reportArtifact.id],
        this.runner.mode(),
        context.executionConfig?.model ?? null,
        context.executionConfig?.reasoningEffort ?? null,
        "codex exec --ephemeral (independent E2E Test Author)",
      );
      try {
        await this.store.appendEvent(execution.id, 1, "e2e.authoring.queued", {
          phaseId: "verification",
          criterionIds: context.intent.criteria.map(({ id }) => id),
        });
      } catch (error) {
        await this.store.failExecution(
          execution.id,
          null,
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
      const task = this.performVerificationE2eAuthor({
        ...context,
        execution,
        startingSequence: 1,
      }).finally(releaseWorkspaces);
      this.trackTask(task);
      scheduled = true;
      return execution;
    } catch (error) {
      if (!scheduled) releaseWorkspaces();
      throw error;
    }
  }

  async reviewVerificationE2eScripts(
    runId: string,
    input: ReviewVerificationE2eScriptsInput,
  ): Promise<VerificationE2eFlowDto> {
    const initial = await this.store.getRun(runId);
    await this.assertProjectPath(initial.project.rootPath);
    const coordinator = this.requireVerificationE2e();
    const workspace = await coordinator.workspace(initial.project);
    const releaseWorkspaces = this.acquireWorkspaceMutations([
      initial.project.rootPath,
      workspace.rootPath,
    ]);
    try {
      const current = await this.store.getRun(runId);
      const { reportArtifact } = await this.verificationE2eDefinitionContext(current);
      const pendingAuthoring = await coordinator.latestAuthoring(current.project, runId);
      if (!pendingAuthoring) {
        throw new AppError("尚未生成可审核的 E2E 脚本", 409, "E2E_AUTHORING_REQUIRED");
      }
      assertTrustedE2eAuthoringExecution(current, pendingAuthoring);
      const reviewed = await coordinator.review(
        current.project,
        runId,
        input,
        reportArtifact.relativePath,
      );
      const refreshed = await this.store.getRun(runId);
      const verificationPhase = requiredRunPhase(refreshed, "verification");
      const nextSequence = verificationPhase.events
        .filter(({ executionId }) => executionId === reviewed.executionId)
        .reduce((maximum, { sequence }) => Math.max(maximum, sequence), 0) + 1;
      const reviewedAt = reviewed.reviewedAt ?? new Date().toISOString();
      await this.store.appendEvent(reviewed.executionId, nextSequence, "e2e.script.reviewed", {
        decision: input.decision,
        authorExecutionId: reviewed.executionId,
        patchHash: reviewed.patchHash,
        productRevisionToken: reviewed.productRevisionToken,
        e2eRevisionToken: reviewed.e2eRevisionToken,
        commentHash: createHash("sha256").update(input.comment).digest("hex"),
        reviewedAt,
      });
      return this.verificationE2eFlow(await this.store.getRun(runId));
    } finally {
      releaseWorkspaces();
    }
  }

  async executeVerificationE2e(
    runId: string,
    input: AuthorVerificationE2eInput,
  ): Promise<ExecutionDto> {
    const initial = await this.store.getRun(runId);
    await this.assertProjectPath(initial.project.rootPath);
    const coordinator = this.requireVerificationE2e();
    const workspace = await coordinator.workspace(initial.project);
    const releaseWorkspaces = this.acquireWorkspaceMutations([
      initial.project.rootPath,
      workspace.rootPath,
    ]);
    let scheduled = false;
    try {
      const context = await this.verificationE2eExecutionContext(runId, input);
      const execution = await this.store.createExecution(
        runId,
        "verification",
        input.selectedArtifactIds,
        [context.reportArtifact.id],
        this.runner.mode(),
        context.executionConfig?.model ?? null,
        context.executionConfig?.reasoningEffort ?? null,
        `npm run ${workspace.testScript} + ${this.runner.commandLabel(context.executionConfig ?? undefined)}`,
      );
      try {
        await this.store.appendEvent(execution.id, 1, "e2e.execution.queued", {
          phaseId: "verification",
        });
      } catch (error) {
        await this.store.failExecution(
          execution.id,
          null,
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
      const task = this.performVerificationE2eExecution({
        ...context,
        execution,
        startingSequence: 1,
      }).finally(releaseWorkspaces);
      this.trackTask(task);
      scheduled = true;
      return execution;
    } catch (error) {
      if (!scheduled) releaseWorkspaces();
      throw error;
    }
  }

  async executePhase(runId: string, phaseId: PhaseId, input: ExecutePhaseInput) {
    if (phaseId !== "verification" && input.verificationAction !== undefined) {
      throw new AppError(
        "verificationAction 只能由 Verification 阶段使用",
        400,
        "VERIFICATION_ACTION_PHASE_MISMATCH",
      );
    }
    if (phaseId === "verification" && input.verificationAction === "author_e2e") {
      return this.authorVerificationE2e(runId, {
        selectedArtifactIds: input.selectedArtifactIds,
        ...(input.model ? { model: input.model } : {}),
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      });
    }
    if (phaseId === "verification" && input.verificationAction === "run_e2e") {
      return this.executeVerificationE2e(runId, {
        selectedArtifactIds: input.selectedArtifactIds,
        ...(input.model ? { model: input.model } : {}),
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      });
    }
    if (new Set(input.selectedArtifactIds).size !== input.selectedArtifactIds.length) {
      throw new AppError("selectedArtifactIds 不能重复", 400, "DUPLICATE_ARTIFACT_SELECTION");
    }
    const bundle = await this.store.getRun(runId);
    await this.assertProjectPath(bundle.project.rootPath);
    const releaseWorkspace = this.acquireWorkspaceMutation(bundle.project.rootPath);
    try {
    const definition = taskDefinition(bundle, await loadDefinition(bundle.project.rootPath));
    if (this.runner.mode() === "real") {
      await assertDefinitionAgentFiles(bundle.project.rootPath, definition);
    }
    const phaseDefinition = definition.phases.find((phase) => phase.id === phaseId);
    if (!phaseDefinition) throw new AppError("阶段不在工作流定义中", 404, "PHASE_NOT_FOUND");
    const currentPhase = bundle.phases.find((phase) => phase.phaseId === phaseId);
    if (!currentPhase) throw new AppError("阶段运行不存在", 404, "PHASE_NOT_FOUND");
    if (phaseId === "architecture" && currentPhase.architectureImpact?.mode === "reuse") {
      throw new AppError(
        "已复用的架构基线是不可变快照；如需修改，请让上游变更使 Impact Check 失效后重新评估",
        409,
        "ARCHITECTURE_IMPACT_REUSE_IMMUTABLE",
      );
    }
    if (
      currentPhase.resolution
      && currentPhase.resolution.phaseId === phaseId
      && ["skip", "direct", "reuse"].includes(currentPhase.resolution.mode)
    ) {
      throw new AppError(
        `阶段已通过 ${currentPhase.resolution.mode} 处置，无需运行 Codex`,
        409,
        "PHASE_RESOLUTION_IMMUTABLE",
      );
    }
    const architectureSelection = phaseId === "architecture" && currentPhase.status !== "ready"
      ? await this.architectureSelectionEvidence(currentPhase)
      : undefined;
    const partialImpact = phaseId === "architecture"
      && currentPhase.architectureImpact?.mode === "partial"
      ? currentPhase.architectureImpact
      : undefined;
    const partialResolution = currentPhase.resolution?.phaseId === phaseId
      && currentPhase.resolution.mode === "partial"
      ? currentPhase.resolution
      : undefined;
    const selectedOutputKeys = resolveOutputSelection(
      phaseId,
      phaseDefinition.outputs,
      input.selectedOutputKeys
        ?? partialResolution?.affectedOutputKeys
        ?? partialImpact?.affectedOutputKeys,
      currentPhase.artifacts.map((artifact) => artifact.artifactKey),
      { architectureSelectionRecorded: Boolean(architectureSelection) },
    );
    if (partialImpact) {
      validateArchitecturePartialExecution(
        partialImpact.affectedOutputKeys,
        selectedOutputKeys,
        currentPhase.executions.length > 0,
      );
    }
    if (partialResolution) {
      validatePhaseResolutionExecution(
        partialResolution,
        phaseId,
        selectedOutputKeys,
        currentPhase.executions.length > 0,
      );
    }
    let figmaTarget: ResolvedFigmaTarget | undefined;
    if (selectedOutputKeys.includes("figma-handoff")) {
      const requestedFigmaTarget = requireFigmaTarget(input.figmaTarget);
      if (this.runner.mode() !== "real") {
        throw new AppError(
          "Figma 产物只能使用真实 Codex Runner 执行",
          409,
          "FIGMA_REQUIRES_REAL_RUNNER"
        );
      }
      if (requestedFigmaTarget.mode === "new_private_draft") {
        const capabilities = await this.resolveFigmaPlans(bundle.project.rootPath, { force: true });
        figmaTarget = resolveNewPrivateDraftTarget(requestedFigmaTarget, capabilities);
      } else {
        figmaTarget = resolveExistingFigmaTarget(requestedFigmaTarget);
        await this.assertFigmaReady(bundle.project.rootPath, { force: true });
      }
    } else if (input.figmaTarget) {
      throw new AppError(
        "只有选择 figma-handoff 产物时才能指定 Figma 目标",
        400,
        "FIGMA_TARGET_WITHOUT_OUTPUT"
      );
    }
    if (this.runner.mode() === "real" && !this.codexCapabilities) {
      throw new AppError("Codex 执行能力服务未配置", 503, "CODEX_CAPABILITIES_UNAVAILABLE");
    }
    const executionConfig = this.runner.mode() === "real"
      ? await this.codexCapabilities!.resolve(bundle.project.rootPath, input)
      : null;
    const selected = await this.store.selectionArtifacts(runId, input.selectedArtifactIds);
    const requiredInputs = effectiveRequiredInputKeys(
      phaseId,
      phaseDefinition.inputs,
      bundle.phases,
      Boolean(bundle.run.changeContract),
      outputKeysByPhase(definition),
    );
    validateArtifactSelection(
      phaseId,
      requiredSelectionKeys(phaseId, requiredInputs),
      selected.map((artifact) => ({
        id: artifact.id,
        artifactKey: artifact.artifactKey,
        sourcePosition: artifact.sourcePosition,
        sourceStatus: artifact.sourceStatus,
        reviewStatus: artifact.reviewStatus
      }))
    );
    if (
      (partialImpact || partialResolution)
      && !sameStringSet(
        selected.map((artifact) => artifact.id),
        (partialResolution ?? partialImpact)!.inputArtifactIds,
      )
    ) {
      throw new AppError(
        "本次局部更新所依据的上游输入已经变化，请重新执行 Impact Check",
        409,
        "PHASE_RESOLUTION_INPUTS_CHANGED",
        {
          assessedArtifactIds: (partialResolution ?? partialImpact)!.inputArtifactIds,
          selectedArtifactIds: selected.map((artifact) => artifact.id),
        },
      );
    }
    const adoptedArchitecture = bundle.phases.find(
      (phase) => phase.phaseId === "architecture" && phase.architectureImpact,
    );
    // Every selected input is an approved immutable snapshot. Validate the
    // physical workspace for all routes, including Full→Full chains, before
    // Codex can consume it.
    await this.validateArtifactWorkspaceSnapshots(bundle.project.rootPath, selected);
    if (phaseId === "implementation") {
      assertImplementationReady({
        changeContractCriteria: bundle.run.changeContract?.acceptanceCriteria,
        selectedArtifacts: selected,
      });
    }
    if (adoptedArchitecture && phasePosition(phaseId) > phasePosition("architecture")) {
      await this.validateCurrentArchitectureWorkspace(bundle.project.rootPath, runId);
    }
    if (partialImpact) {
      await this.validateCurrentArchitectureWorkspace(bundle.project.rootPath, runId);
    }
    const currentArtifacts = await this.store.currentArtifactSnapshotsForPhase(runId, phaseId);
    const verificationPhase = bundle.phases.find((phase) => phase.phaseId === "verification");
    const testerCrystallizationReview = phaseId === "implementation"
      && verificationPhase?.status === "changes_requested"
      ? findTesterE2eCrystallizationReview(
          verificationPhase.reviews,
          bundle.run.changeContract,
        )
      : undefined;
    const testerCrystallizationFeedback = testerCrystallizationReview
      ? testerE2eCrystallizationRevisionFeedback({
          review: testerCrystallizationReview,
          artifacts: await this.store.currentArtifactSnapshotsForPhase(runId, "verification"),
          changeContract: bundle.run.changeContract,
        })
      : undefined;
    const engineeringRepairFeedback = phaseId === "implementation" && currentArtifacts.length > 0
      ? engineeringEvidenceRepairFeedback({
          artifacts: currentArtifacts,
          acceptanceCriteria: resolveEngineeringAcceptanceCriteria({
            changeContractCriteria: bundle.run.changeContract?.acceptanceCriteria,
            selectedArtifacts: selected,
          }),
          selectedArtifactKeys: selectedOutputKeys,
        })
      : undefined;
    const revisionFeedback = [
      ...(testerCrystallizationFeedback ? [testerCrystallizationFeedback] : []),
      ...(engineeringRepairFeedback ? [engineeringRepairFeedback] : []),
      ...currentPhase.reviews
        .filter((review) => review.decision === "request_changes")
        .slice(0, 5)
        .map((review) => review.comment),
    ];
    const execution = await this.store.createExecution(
      runId,
      phaseId,
      input.selectedArtifactIds,
      selectedOutputKeys,
      this.runner.mode(),
      executionConfig?.model ?? null,
      executionConfig?.reasoningEffort ?? null,
      this.runner.commandLabel(executionConfig ?? undefined)
    );

    const task = this.performExecution({
      executionId: execution.id,
      project: bundle.project,
      run: bundle.run,
      phase: phaseDefinition,
      definition,
      selectedArtifacts: selected,
      currentArtifacts,
      revisionFeedback,
      selectedOutputKeys,
      requireEverySelectedOutputUpdated: Boolean(architectureSelection || partialResolution),
      architectureSelection,
      phaseResolution: currentPhase.resolution,
      model: executionConfig?.model ?? null,
      reasoningEffort: executionConfig?.reasoningEffort ?? null,
      figmaTarget
    }).finally(releaseWorkspace);
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
    return execution;
    } catch (error) {
      releaseWorkspace();
      throw error;
    }
  }

  async reviewPhase(runId: string, phaseId: PhaseId, input: ReviewPhaseInput) {
    const initial = await this.store.getRun(runId);
    await this.assertProjectPath(initial.project.rootPath);
    const releaseWorkspace = this.acquireWorkspaceMutation(initial.project.rootPath);
    try {
    const current = await this.store.getRun(runId);
    const definition = taskDefinition(
      current,
      await loadDefinition(current.project.rootPath),
    );
    const phaseDefinition = definition.phases.find((phase) => phase.id === phaseId);
    if (!phaseDefinition) throw new AppError("阶段不在工作流定义中", 404, "PHASE_NOT_FOUND");
    const currentPhase = current.phases.find((phase) => phase.phaseId === phaseId);
    if (!currentPhase) throw new AppError("阶段运行不存在", 404, "PHASE_NOT_FOUND");
    if (
      input.decision === "approve"
      && (phaseId === "discovery" || phaseId === "design" || phaseId === "architecture")
    ) {
      const decisionArtifacts = await this.store.currentArtifactSnapshotsForPhase(runId, phaseId);
      const requiredDeferredValidationIds = phaseId === "design"
        ? await this.priorDeferredDesignValidationIds(
          decisionArtifacts.find(({ artifactKey }) => artifactKey === "design-spec"),
        )
        : [];
      assertPhaseHumanDecisionGateReady(assessPhaseHumanDecisionGate({
        phaseId,
        phaseStatus: currentPhase.status,
        artifacts: decisionArtifacts,
        reviews: currentPhase.reviews,
        requiredDeferredValidationIds,
      }));
    }
    const adoptedArchitecture = current.phases.find(
      (phase) => phase.phaseId === "architecture" && phase.architectureImpact,
    );
    if (adoptedArchitecture && phasePosition(phaseId) > phasePosition("architecture")) {
      await this.validateCurrentArchitectureWorkspace(current.project.rootPath, runId);
    }
    const hasPriorRoutedPhase = current.phases.some(
      (phase) => phase.resolution
        && phasePosition(phase.phaseId) < phasePosition(phaseId),
    );
    const latestCompletedExecution = currentPhase.executions.find(
      (execution) => execution.status === "completed",
    );
    const requiresReleaseEvidenceGate = phaseId === "release"
      && input.decision === "approve"
      && definition.releaseEvidenceValidationRequired;
    const needsExecutionInputs = hasPriorRoutedPhase
      || (
        input.decision === "approve"
        && (phaseId === "implementation" || phaseId === "verification" || requiresReleaseEvidenceGate)
      );
    const executionInputs = needsExecutionInputs
      && latestCompletedExecution?.selectedArtifactIds.length
      && typeof this.store.selectionArtifacts === "function"
      ? await this.store.selectionArtifacts(
        runId,
        latestCompletedExecution.selectedArtifactIds,
      )
      : [];
    if (requiresReleaseEvidenceGate && executionInputs.length === 0) {
      throw new AppError(
        "Release approval requires the completed execution's current approved input snapshots",
        409,
        "RELEASE_EVIDENCE_BINDINGS_REQUIRED",
      );
    }
    if (requiresReleaseEvidenceGate && latestCompletedExecution?.runnerMode !== "real") {
      throw new AppError(
        "Release readiness cannot be approved from a simulated or legacy runner execution",
        409,
        "RELEASE_EVIDENCE_REAL_EXECUTION_REQUIRED",
      );
    }
    if (requiresReleaseEvidenceGate) {
      const requiredInputs = effectiveRequiredInputKeys(
        "release",
        phaseDefinition.inputs,
        current.phases,
        Boolean(current.run.changeContract),
        outputKeysByPhase(definition),
      );
      validateArtifactSelection(
        "release",
        requiredSelectionKeys("release", requiredInputs),
        executionInputs.map((artifact) => ({
          id: artifact.id,
          artifactKey: artifact.artifactKey,
          sourcePosition: artifact.sourcePosition,
          sourceStatus: artifact.sourceStatus,
          reviewStatus: artifact.reviewStatus,
        })),
      );
    }
    if ((hasPriorRoutedPhase || requiresReleaseEvidenceGate) && executionInputs.length > 0) {
      await this.validateArtifactWorkspaceSnapshots(
        current.project.rootPath,
        executionInputs,
      );
    }
    let architectureSelection: ArchitectureSelectionEvidence | undefined;
    if (phaseId === "architecture") {
      if (input.decision === "request_changes") {
        const selectionId = parseArchitectureSelectionId(input.comment);
        if (
          currentPhase.architectureImpact?.mode === "partial"
          && hasArchitectureSelectionMarker(input.comment)
        ) {
          throw new AppError(
            "局部架构更新不能改变既有选型；如需重新选型，请使用完整架构重评",
            409,
            "ARCHITECTURE_IMPACT_REQUIRES_FULL",
          );
        }
        if (selectionId) {
          if (!hasCompleteArchitectureBootstrap(
            phaseDefinition.outputs,
            currentPhase.artifacts.map((artifact) => artifact.artifactKey),
          )) {
            throw new AppError(
              "必须先完成 architecture、discovery context 和 options 检查点，才能记录架构选型",
              409,
              "ARCHITECTURE_BOOTSTRAP_INCOMPLETE",
            );
          }
          const optionsHead = currentPhase.artifacts.find(
            (artifact) => artifact.artifactKey === "architecture-options",
          );
          if (!optionsHead) {
            throw new AppError(
              "必须先生成 architecture-options 才能记录架构选型",
              409,
              "ARCHITECTURE_OPTIONS_REQUIRED",
            );
          }
          const options = await this.store.getArtifact(optionsHead.id);
          validateArchitectureSelectionComment(input.comment, options.content ?? "");
          await this.validateArchitectureRulebookGate(
            current.project.rootPath,
            runId,
            "checkpoint",
          );
        }
      } else {
        validateArchitecturePartialInheritance(
          currentPhase.architectureImpact,
          phaseDefinition.outputs,
          currentPhase.artifacts,
        );
        architectureSelection = await this.architectureSelectionEvidence(currentPhase);
        if (!architectureSelection) {
          throw new AppError(
            "架构阶段尚无针对当前 options revision 的有效人工选型，不能批准",
            409,
            "ARCHITECTURE_SELECTION_REQUIRED",
          );
        }
        const approvalKeys = requiredApprovalOutputKeys(phaseId, phaseDefinition.outputs);
        const currentKeys = new Set(currentPhase.artifacts.map((artifact) => artifact.artifactKey));
        if (approvalKeys.every((key) => currentKeys.has(key))) {
          await this.validateArchitectureRulebookGate(
            current.project.rootPath,
            runId,
            "final",
            architectureSelection,
          );
        }
      }
    }
    const architectureFreshness = architectureSelection
      ? currentPhase.architectureImpact?.mode === "partial"
        ? {
            keys: currentPhase.architectureImpact.affectedOutputKeys,
            after: currentPhase.architectureImpact.assessedAt,
            minimumRevision: 2,
            indexKey: "architecture",
          }
        : {
            keys: requiredArchitecturePostSelectionOutputs.filter((key) =>
              phaseDefinition.outputs.includes(key)
            ),
            after: architectureSelection.selectedAt,
          }
      : undefined;
    if (phaseId === "implementation" && input.decision === "approve") {
      const engineeringArtifacts = await this.store.currentArtifactSnapshotsForPhase(
        runId,
        "implementation",
      );
      validateEngineeringEvidencePack({
        artifacts: engineeringArtifacts,
        acceptanceCriteria: resolveEngineeringAcceptanceCriteria({
          changeContractCriteria: current.run.changeContract?.acceptanceCriteria,
          selectedArtifacts: executionInputs,
        }),
        reviewComment: input.comment,
      });
    }
    if (phaseId === "verification" && input.decision === "approve") {
      const [designArtifacts, verificationArtifacts] = await Promise.all([
        this.store.currentArtifactSnapshotsForPhase(runId, "design"),
        this.store.currentArtifactSnapshotsForPhase(runId, "verification"),
      ]);
      validateDeferredDesignVerificationGate({
        designArtifacts,
        verificationArtifacts,
      });
      assertLinkedE2eApprovalObligation(currentPhase, verificationArtifacts);
      await validateVerificationEvidenceProvenance({
        projectRoot: current.project.rootPath,
        artifacts: verificationArtifacts,
        phase: currentPhase,
        acceptanceCriteria: resolveEngineeringAcceptanceCriteria({
          changeContractCriteria: current.run.changeContract?.acceptanceCriteria,
          selectedArtifacts: executionInputs,
        }),
        regressionScope: current.run.changeContract?.regressionScope,
        riskFlags: current.run.changeContract?.riskFlags,
      });
    }
    if (requiresReleaseEvidenceGate) {
      const releaseArtifacts = await this.store.currentArtifactSnapshotsForPhase(
        runId,
        "release",
      );
      validateReleaseEvidence({
        artifacts: releaseArtifacts,
        expectedRunId: current.run.id,
        expectedInputs: executionInputs.map(({ artifactKey, filePath, contentHash }) => ({
          artifactKey,
          filePath,
          contentHash,
        })),
      });
    }
    const review = await this.store.reviewPhase(
      runId,
      phaseId,
      input.decision,
      input.comment,
      input.expectedArtifactIds,
      requiredApprovalOutputKeys(phaseId, phaseDefinition.outputs),
      architectureFreshness,
    );
    const detail = await this.getRun(runId);
    return { review, run: detail.run, phases: detail.phases };
    } finally {
      releaseWorkspace();
    }
  }

  async getArtifact(artifactId: string) {
    return this.store.getArtifact(artifactId);
  }

  private async verificationE2eDefinitionContext(
    bundle: RunBundle,
  ): Promise<VerificationE2eDefinitionContext> {
    const definition = taskDefinition(bundle, await loadDefinition(bundle.project.rootPath));
    const phaseDefinition = definition.phases.find(({ id }) => id === "verification");
    const phase = bundle.phases.find(({ phaseId }) => phaseId === "verification");
    if (!phaseDefinition || !phase) {
      throw new AppError("Verification 阶段不存在", 404, "PHASE_NOT_FOUND");
    }
    if (phaseDefinition.owner !== "tester") {
      throw new AppError(
        "Linked E2E author/run 只能由固定 Verification Tester 角色执行",
        409,
        "E2E_VERIFICATION_OWNER_INVALID",
      );
    }
    if (
      phase.resolution
      && ["skip", "direct", "reuse"].includes(phase.resolution.mode)
    ) {
      throw new AppError(
        `Verification 已通过 ${phase.resolution.mode} 处置，不能运行 Linked E2E`,
        409,
        "PHASE_RESOLUTION_IMMUTABLE",
      );
    }
    const reportArtifact = definition.artifacts.find(({ id }) => id === "test-report");
    if (!reportArtifact || !phaseDefinition.outputs.includes(reportArtifact.id)) {
      throw new AppError(
        "Verification 没有注册 test-report 输出",
        400,
        "CONFIG_INVALID",
      );
    }
    return { definition, phaseDefinition, phase, reportArtifact };
  }

  private async verificationE2eExecutionContext(
    runId: string,
    input: AuthorVerificationE2eInput,
  ): Promise<VerificationE2eExecutionContext> {
    if (new Set(input.selectedArtifactIds).size !== input.selectedArtifactIds.length) {
      throw new AppError("selectedArtifactIds 不能重复", 400, "DUPLICATE_ARTIFACT_SELECTION");
    }
    const bundle = await this.store.getRun(runId);
    await this.assertProjectPath(bundle.project.rootPath);
    const definitionContext = await this.verificationE2eDefinitionContext(bundle);
    if (this.runner.mode() === "real") {
      await assertDefinitionAgentFiles(bundle.project.rootPath, definitionContext.definition);
    }
    const selected = await this.store.selectionArtifacts(runId, input.selectedArtifactIds);
    const requiredInputs = effectiveRequiredInputKeys(
      "verification",
      definitionContext.phaseDefinition.inputs,
      bundle.phases,
      Boolean(bundle.run.changeContract),
      outputKeysByPhase(definitionContext.definition),
    );
    validateArtifactSelection(
      "verification",
      requiredSelectionKeys("verification", requiredInputs),
      selected.map((artifact) => ({
        id: artifact.id,
        artifactKey: artifact.artifactKey,
        sourcePosition: artifact.sourcePosition,
        sourceStatus: artifact.sourceStatus,
        reviewStatus: artifact.reviewStatus,
      })),
    );
    await this.validateArtifactWorkspaceSnapshots(bundle.project.rootPath, selected);
    const adoptedArchitecture = bundle.phases.find(
      (phase) => phase.phaseId === "architecture" && phase.architectureImpact,
    );
    if (adoptedArchitecture) {
      await this.validateCurrentArchitectureWorkspace(bundle.project.rootPath, runId);
    }
    const intent = freezeVerificationE2eIntent({
      changeContract: bundle.run.changeContract,
      selectedArtifacts: selected,
    });
    if (this.runner.mode() === "real" && !this.codexCapabilities) {
      throw new AppError("Codex 执行能力服务未配置", 503, "CODEX_CAPABILITIES_UNAVAILABLE");
    }
    const executionConfig = this.runner.mode() === "real"
      ? await this.codexCapabilities!.resolve(bundle.project.rootPath, input)
      : null;
    return {
      ...definitionContext,
      bundle,
      selected,
      currentArtifacts: await this.store.currentArtifactSnapshotsForPhase(runId, "verification"),
      intent,
      executionConfig,
    };
  }

  private async verificationE2eFlow(
    bundle: RunBundle,
    probedReadiness?: E2eWorkspaceReadinessDto,
  ): Promise<VerificationE2eFlowDto> {
    const coordinator = this.requireVerificationE2e();
    const definitionContext = await this.verificationE2eDefinitionContext(bundle);
    const flowIntent = await this.verificationE2eFlowIntent(bundle);
    const workspace = await coordinator.optionalWorkspace(bundle.project);
    if (!workspace) {
      return {
        runId: bundle.run.id,
        state: "unconfigured",
        workspace: null,
        readiness: null,
        blockers: flowIntent.blockers,
        criterionIds: flowIntent.intent?.criteria.map(({ id }) => id) ?? [],
        contractSource: flowIntent.contractSource,
        authoring: null,
        execution: null,
        recommendedAction: "先为项目显式配置一个新的独立 E2E 工作区。",
      };
    }

    const cachedReadiness = this.e2eReadinessCache.get(bundle.project.rootPath);
    let readiness = probedReadiness
      ?? (cachedReadiness?.descriptorHash === workspace.descriptorHash
        ? cachedReadiness.readiness
        : unprobedE2eReadiness());
    let staleAuthoringBlockers: string[] = [];
    let localAuthoring: E2eAuthoringDto | null;
    try {
      localAuthoring = await coordinator.latestAuthoring(bundle.project, bundle.run.id);
    } catch (error) {
      if (
        error instanceof AppError
        && ["E2E_AUTHORING_RECORD_INVALID", "E2E_SCRIPT_APPROVAL_STALE"].includes(error.code)
      ) {
        localAuthoring = null;
        staleAuthoringBlockers = ["已生成的 E2E 脚本与完整待审 manifest 不一致，请重新生成。"];
      } else {
        throw error;
      }
    }
    const reviewResolution = localAuthoring
      ? resolveE2eScriptReviewAuthority(definitionContext.phase, localAuthoring)
      : { authority: null, mismatch: false };
    const authoring = localAuthoring
      ? {
        ...localAuthoring,
        status: reviewResolution.authority
          ? (reviewResolution.authority.decision === "approve" ? "approved" as const : "changes_requested" as const)
          : (localAuthoring.status === "changes_requested" ? "changes_requested" as const : "awaiting_review" as const),
        reviewedAt: reviewResolution.authority?.reviewedAt ?? null,
      }
      : null;
    const specialExecutions = verificationE2eExecutions(
      definitionContext.phase,
    );
    const latest = specialExecutions[0] ?? null;
    const latestKind = latest
      ? verificationE2eExecutionKind(definitionContext.phase, latest.id)
      : null;
    if (latest && latestKind === "execute") {
      const completed = definitionContext.phase.events
        .filter(({ executionId, eventType }) => (
          executionId === latest.id && eventType === "e2e.execution.completed"
        ))
        .sort((left, right) => left.sequence - right.sequence)
        .at(-1);
      const payload = completed?.payload && typeof completed.payload === "object"
        ? completed.payload as Record<string, unknown>
        : null;
      if (payload?.targetProbe && typeof payload.targetProbe === "object") {
        const target = payload.targetProbe as Record<string, unknown>;
        const trustedTarget = isTrustedLinkedE2eCompletedPayload(payload);
        readiness = {
          ...readiness,
          target: {
            state: trustedTarget ? "ready" : "failed",
            message: trustedTarget ? "真实 Chromium 已访问目标" : "真实 Chromium 目标验证失败",
            detail: `url=${String(target.url ?? "unknown")}; status=${String(target.status ?? "unknown")}; cleanup=${String(payload.serverCleanup ?? "unknown")}`,
          },
        };
      }
    }
    const readinessBlockers = readiness.ready
      ? []
      : e2eReadinessBlockers(readiness);
    const currentReport = (await this.store.currentArtifactSnapshotsForPhase(
      bundle.run.id,
      "verification",
    )).find(({ artifactKey }) => artifactKey === "test-report");
    const linkedExecutionIsCurrent = latestKind !== "execute"
      || currentReport?.executionId === latest?.id;
    const blockers = [...new Set([
      ...flowIntent.blockers,
      ...readinessBlockers,
      ...staleAuthoringBlockers,
      ...(reviewResolution.mismatch
        ? ["数据库脚本审核与当前生成文件的 hash/revision 不匹配，必须重新审核。"]
        : []),
      ...(latestKind === "execute" && latest?.status !== "running" && !linkedExecutionIsCurrent
        ? ["旧 Linked E2E 结果不是当前 test-report head，必须重新运行。"]
        : []),
    ])];
    let state: VerificationE2eFlowDto["state"];
    let recommendedAction: string;
    if (latest?.status === "running" && latestKind === "author") {
      state = "authoring";
      recommendedAction = "独立 Test Author 正在生成脚本；完成后请审核精确文件哈希。";
    } else if (latest?.status === "running" && latestKind === "execute") {
      state = "executing";
      recommendedAction = "平台正在监督产品服务和真实 Playwright 浏览器执行。";
    } else if (!readiness.ready) {
      state = "preflight_blocked";
      recommendedAction = "按预检项修复环境；依赖与 Chromium 只能通过显式准备操作安装。";
    } else if (!flowIntent.intent) {
      state = "needs_authoring";
      recommendedAction = "先批准带稳定 AC ID 的 user-stories，或为新 Run 提供 Change Contract。";
    } else if (!authoring || authoring.status === "changes_requested") {
      state = "needs_authoring";
      recommendedAction = "从已批准规格重新生成独立 E2E 脚本。";
    } else if (authoring.status === "awaiting_review") {
      state = "awaiting_script_review";
      recommendedAction = "人工审核生成文件及 manifest hash；脚本批准不等于 Verification 批准。";
    } else if (latestKind === "execute" && latest?.status !== "running" && !linkedExecutionIsCurrent) {
      state = "ready_to_execute";
      recommendedAction = "当前 test-report 已被其他 Tester 执行替换，请重新运行 Linked E2E。";
    } else if (
      latestKind === "execute"
      && (
        latest?.status === "failed"
        || (latest?.status === "completed" && latest.exitCode !== 0)
      )
    ) {
      state = "failed";
      recommendedAction = "查看真实浏览器执行失败证据，按归属修复后重新运行。";
    } else if (
      latestKind === "execute"
      && latest?.status === "completed"
      && latest.exitCode === 0
    ) {
      state = "awaiting_verification_review";
      recommendedAction = "检查 test-report 与真实 Playwright 证据，再进行正常 Verification 人工审核。";
    } else {
      state = "ready_to_execute";
      recommendedAction = "运行已批准哈希对应的真实 Playwright 脚本。";
    }
    return {
      runId: bundle.run.id,
      state,
      workspace,
      readiness,
      blockers,
      criterionIds: flowIntent.intent?.criteria.map(({ id }) => id) ?? [],
      contractSource: flowIntent.contractSource,
      authoring,
      execution: latest,
      recommendedAction,
    };
  }

  private async verificationE2eFlowIntent(bundle: RunBundle): Promise<{
    intent: FrozenE2eIntent | null;
    contractSource: VerificationE2eFlowDto["contractSource"];
    blockers: string[];
  }> {
    const priorPhases = bundle.phases.filter(
      ({ phaseId, status }) => phasePosition(phaseId) < phasePosition("verification")
        && status === "approved",
    );
    const selectedArtifacts = (await Promise.all(priorPhases.map(async (phase) => (
      (await this.store.currentArtifactSnapshotsForPhase(bundle.run.id, phase.phaseId))
        .map((artifact) => ({ ...artifact, sourceStatus: phase.status }))
    )))).flat();
    try {
      const intent = freezeVerificationE2eIntent({
        changeContract: bundle.run.changeContract,
        selectedArtifacts,
      });
      return {
        intent,
        contractSource: intent.criteriaSource === "change_contract"
          ? "change_contract"
          : "legacy_approved_artifacts",
        blockers: [],
      };
    } catch (error) {
      if (error instanceof AppError && error.code === "E2E_AUTHORITATIVE_CRITERIA_MISSING") {
        return {
          intent: null,
          contractSource: "unavailable",
          blockers: [error.message],
        };
      }
      throw error;
    }
  }

  private async performVerificationE2eAuthor(
    input: VerificationE2eExecutionContext & {
      execution: ExecutionDto;
      startingSequence: number;
    },
  ): Promise<void> {
    let sequence = input.startingSequence;
    const event = async (eventType: string, payload: unknown) => {
      sequence += 1;
      await this.store.appendEvent(input.execution.id, sequence, eventType, payload);
    };
    try {
      const productGitState = await captureVerificationGitState(input.bundle.project.rootPath);
      const artifact = await withArtifactPathsRollbackOnError(
        input.bundle.project.rootPath,
        [{ id: input.reportArtifact.id, absolutePath: input.reportArtifact.absolutePath }],
        2_000_000,
        () => withVerificationWorkspaceProtected(
          {
            projectRoot: input.bundle.project.rootPath,
            selectedOutputPaths: [input.reportArtifact.absolutePath],
            protectedGitMetadataPaths: verificationGitMetadataPaths(productGitState),
          },
          async () => {
            await event("e2e.authoring.started", {
              isolationTier: "B",
              criterionIds: input.intent.criteria.map(({ id }) => id),
            });
            const authored = await this.requireVerificationE2e().author({
              project: input.bundle.project,
              runId: input.bundle.run.id,
              executionId: input.execution.id,
              intent: input.intent,
              model: input.executionConfig?.model ?? null,
              reasoningEffort: input.executionConfig?.reasoningEffort ?? null,
              testReportPath: input.reportArtifact.relativePath,
            });
            const report = await this.writeVerificationE2eReport(
              input.bundle.project.rootPath,
              input.reportArtifact,
              authored.reportContent,
            );
            await event("e2e.authoring.materialized", {
              patchHash: authored.authoring.patchHash,
              productRevisionToken: authored.authoring.productRevisionToken,
              e2eRevisionToken: authored.authoring.e2eRevisionToken,
              criterionIds: authored.authoring.criterionIds,
              files: authored.authoring.files.map(({ path: filePath, sha256, bytes }) => ({
                path: filePath,
                sha256,
                bytes,
              })),
            });
            return report;
          },
        ),
      );
      await this.store.completeExecution(input.execution.id, 0, [artifact]);
      await event("e2e.authoring.completed", { exitCode: 0 });
    } catch (error) {
      const failure = e2eFailureDetails(error, "test_author");
      await event("e2e.authoring.failed", failure).catch(() => undefined);
      await this.store.failExecution(
        input.execution.id,
        e2eFailureExitCode(error),
        `[${failure.code}] ${failure.stage}: ${failure.message}`,
      );
    }
  }

  private async performVerificationE2eExecution(
    input: VerificationE2eExecutionContext & {
      execution: ExecutionDto;
      startingSequence: number;
    },
  ): Promise<void> {
    let sequence = input.startingSequence;
    const event = async (eventType: string, payload: unknown) => {
      sequence += 1;
      await this.store.appendEvent(input.execution.id, sequence, eventType, payload);
    };
    try {
      const coordinator = this.requireVerificationE2e();
      const workspace = await coordinator.workspace(input.bundle.project);
      const productGitState = await captureVerificationGitState(input.bundle.project.rootPath);
      const e2eGitState = await captureVerificationGitState(workspace.rootPath);
      const latestBundle = await this.store.getRun(input.bundle.run.id);
      const localAuthoring = await coordinator.latestAuthoring(
        latestBundle.project,
        latestBundle.run.id,
      );
      const reviewResolution = localAuthoring
        ? resolveE2eScriptReviewAuthority(
          requiredRunPhase(latestBundle, "verification"),
          localAuthoring,
        )
        : { authority: null, mismatch: false };
      if (localAuthoring) assertTrustedE2eAuthoringExecution(latestBundle, localAuthoring);
      if (!reviewResolution.authority || reviewResolution.authority.decision !== "approve") {
        throw new AppError(
          "Linked E2E 缺少与当前脚本完全匹配的数据库人工批准事件",
          409,
          "E2E_SCRIPT_REVIEW_REQUIRED",
        );
      }
      const reviewAuthority = reviewResolution.authority;
      const completed = await withArtifactPathsRollbackOnError(
        input.bundle.project.rootPath,
        [{ id: input.reportArtifact.id, absolutePath: input.reportArtifact.absolutePath }],
        2_000_000,
        () => withVerificationWorkspaceProtected(
          {
            projectRoot: input.bundle.project.rootPath,
            selectedOutputPaths: [input.reportArtifact.absolutePath],
            protectedGitMetadataPaths: verificationGitMetadataPaths(productGitState),
          },
          () => withVerificationWorkspaceProtected(
            {
              projectRoot: workspace.rootPath,
              selectedOutputPaths: [],
              protectedGitMetadataPaths: verificationGitMetadataPaths(e2eGitState),
            },
            async () => {
            const e2e = await coordinator.execute({
              project: input.bundle.project,
              runId: input.bundle.run.id,
              executionId: input.execution.id,
              testReportPath: input.reportArtifact.relativePath,
              reviewAuthority,
              onEvent: event,
            });
            const report = await this.runner.run({
              executionId: input.execution.id,
              project: input.bundle.project,
              run: input.bundle.run,
              phase: input.phaseDefinition,
              definition: input.definition,
              selectedArtifacts: input.selected,
              currentArtifacts: input.currentArtifacts,
              revisionFeedback: [
                e2e.prompt,
                ...input.phase.reviews
                  .filter(({ decision }) => decision === "request_changes")
                  .slice(0, 5)
                  .map(({ comment }) => comment),
              ],
              selectedOutputKeys: [input.reportArtifact.id],
              requireEverySelectedOutputUpdated: true,
              phaseResolution: input.phase.resolution,
              model: input.executionConfig?.model ?? null,
              reasoningEffort: input.executionConfig?.reasoningEffort ?? null,
            }, event);
            return { e2e, report };
            },
          ),
        ),
      );
      const effectiveExitCode = completed.e2e.result.passed
        ? 0
        : (completed.e2e.result.testExitCode || 1);
      await this.store.completeExecution(
        input.execution.id,
        effectiveExitCode,
        completed.report.artifacts,
      );
      await event("e2e.workflow.completed", {
        exitCode: effectiveExitCode,
        testExitCode: completed.e2e.result.testExitCode,
        passed: completed.e2e.result.passed,
      });
    } catch (error) {
      const failure = e2eFailureDetails(error, "linked_e2e_execution_or_report");
      await event("e2e.workflow.failed", failure).catch(() => undefined);
      await this.store.failExecution(
        input.execution.id,
        e2eFailureExitCode(error),
        `[${failure.code}] ${failure.stage}: ${failure.message}`,
      );
    }
  }

  private async writeVerificationE2eReport(
    projectRoot: string,
    artifact: LoadedArtifactDefinition,
    content: string,
  ) {
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes === 0 || bytes > 2_000_000) {
      throw new AppError(
        "E2E authoring report is empty or exceeds the artifact limit",
        bytes > 2_000_000 ? 413 : 422,
        bytes > 2_000_000 ? "ARTIFACT_TOO_LARGE" : "OUTPUT_ARTIFACTS_MISSING",
      );
    }
    await assertRuntimePath(projectRoot, artifact.absolutePath);
    await mkdir(path.dirname(artifact.absolutePath), { recursive: true });
    await writeFile(artifact.absolutePath, content, "utf8");
    return {
      artifactKey: artifact.id,
      filePath: artifact.relativePath,
      content,
      contentHash: createHash("sha256").update(content).digest("hex"),
    };
  }

  private async priorDeferredDesignValidationIds(
    head: CurrentArtifactSnapshot | undefined,
  ): Promise<string[]> {
    if (!head?.parentArtifactId) return [];
    const ids = new Set<string>();
    const visited = new Set<string>();
    let parentId: string | null = head.parentArtifactId;
    for (let depth = 0; parentId && depth < 100; depth += 1) {
      if (visited.has(parentId)) {
        throw new AppError(
          "design-spec 修订链包含循环，无法确认延期验证义务",
          409,
          "DESIGN_ARTIFACT_LINEAGE_INVALID",
        );
      }
      visited.add(parentId);
      const parent = await this.store.getArtifact(parentId);
      for (const id of deferredDesignValidationIds(parent.content ?? "")) ids.add(id);
      parentId = parent.parentArtifactId;
    }
    if (parentId) {
      throw new AppError(
        "design-spec 修订链超过安全上限，无法确认延期验证义务",
        409,
        "DESIGN_ARTIFACT_LINEAGE_INVALID",
      );
    }
    return [...ids];
  }

  async createArtifactRevision(artifactId: string, input: CreateArtifactRevisionInput) {
    if (Buffer.byteLength(input.content, "utf8") > 2_000_000) {
      throw new AppError("产物超过 2000000 字节限制", 413, "ARTIFACT_TOO_LARGE");
    }
    const workspace = await this.store.artifactWorkspace(artifactId);
    await this.assertProjectPath(workspace.rootPath);
    const releaseWorkspace = this.acquireWorkspaceMutation(workspace.rootPath);
    try {
    const initial = await this.store.getArtifact(artifactId);
    const absolutePath = path.resolve(workspace.rootPath, initial.filePath);
    const lockKey = `${workspace.rootPath}\0${absolutePath}`;
    return await this.withArtifactRevisionLock(lockKey, async () => {
      const current = await this.store.getArtifact(artifactId);
      if (
        current.reviewStatus === "superseded"
        || current.contentHash !== input.expectedContentHash
      ) {
        throw new AppError(
          "该产物版本已发生变化，请刷新后重试",
          409,
          "ARTIFACT_REVISION_CONFLICT",
          { artifactId, currentContentHash: current.contentHash },
        );
      }
      if (current.artifactKey === CHANGE_CONTRACT_ARTIFACT_KEY) {
        throw new AppError(
          "Change Contract 在 Run 创建后不可修改；请新建 Run 记录新的变更合同",
          409,
          "CHANGE_CONTRACT_IMMUTABLE",
        );
      }
      if (input.content === current.content) {
        throw new AppError(
          "人工修订内容与当前产物完全相同",
          409,
          "ARTIFACT_REVISION_UNCHANGED",
          { artifactId, currentContentHash: current.contentHash },
        );
      }
      if (workspace.phaseId === "architecture") {
        const phase = await this.store.getPhase(workspace.workflowRunId, "architecture");
        validateArchitectureImpactArtifactMutation(
          phase.architectureImpact,
          current.artifactKey,
        );
        validatePhaseResolutionArtifactMutation(
          phase.resolution,
          workspace.phaseId,
          current.artifactKey,
        );
      } else if (
        ["discovery", "design"].includes(workspace.phaseId)
        && typeof this.store.getPhase === "function"
      ) {
        const phase = await this.store.getPhase(workspace.workflowRunId, workspace.phaseId);
        validatePhaseResolutionArtifactMutation(
          phase.resolution,
          workspace.phaseId,
          current.artifactKey,
        );
      }
      const prepared = await prepareArtifactRevision({
        projectRoot: workspace.rootPath,
        absolutePath,
        previousContentHash: current.contentHash,
        nextContent: input.content,
        maxBytes: 2_000_000,
      });
      try {
        const tickets = current.artifactKey === "user-stories"
          ? ticketRecords(current.filePath, prepared.content)
          : undefined;
        const artifact = await this.store.createHumanArtifactRevision(
          artifactId,
          input.expectedContentHash,
          prepared.content,
          prepared.contentHash,
          tickets,
        );
        await prepared.commit();
        return artifact;
      } catch (error) {
        try {
          await prepared.rollback();
        } catch (rollbackError) {
          throw new AppError(
            "人工版本未能保存，且项目文件回滚失败",
            500,
            "ARTIFACT_WORKSPACE_ROLLBACK_FAILED",
            {
              saveError: error instanceof Error ? error.message : String(error),
              rollbackError: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
            },
          );
        }
        throw error;
      }
    });
    } finally {
      releaseWorkspace();
    }
  }

  async getFigmaIntegration(runId: string, options: { force?: boolean } = {}) {
    const bundle = await this.store.getRun(runId);
    await this.assertProjectPath(bundle.project.rootPath);
    return this.figmaIntegration?.status(bundle.project.rootPath, options);
  }

  async getFigmaPlans(runId: string, options: { force?: boolean } = {}) {
    const bundle = await this.store.getRun(runId);
    await this.assertProjectPath(bundle.project.rootPath);
    return this.resolveFigmaPlans(bundle.project.rootPath, options);
  }

  async getCodexCapabilities(runId: string) {
    const bundle = await this.store.getRun(runId);
    await this.assertProjectPath(bundle.project.rootPath);
    if (!this.codexCapabilities) {
      throw new AppError("Codex 执行能力服务未配置", 503, "CODEX_CAPABILITIES_UNAVAILABLE");
    }
    return this.codexCapabilities.status(bundle.project.rootPath);
  }

  async listTickets(runId: string) {
    const bundle = await this.store.getRun(runId);
    await this.assertProjectPath(bundle.project.rootPath);
    return this.ensureTicketsFromLatestArtifact(runId);
  }

  async getTicket(runId: string, ticketId: string) {
    const bundle = await this.store.getRun(runId);
    await this.assertProjectPath(bundle.project.rootPath);
    await this.ensureTicketsFromLatestArtifact(runId);
    return this.store.getTicket(runId, ticketId);
  }

  async updateTicketStatus(runId: string, ticketId: string, status: Parameters<PgWorkflowStore["updateTicketStatus"]>[2]) {
    const bundle = await this.store.getRun(runId);
    await this.assertProjectPath(bundle.project.rootPath);
    await this.ensureTicketsFromLatestArtifact(runId);
    return this.store.updateTicketStatus(runId, ticketId, status);
  }

  async getExecutionEvents(executionId: string) {
    return this.store.eventsForExecution(executionId);
  }

  private requireVerificationE2e(): NonNullable<WorkflowService["verificationE2e"]> {
    if (!this.verificationE2e) {
      throw new AppError(
        "Linked E2E 服务未配置",
        503,
        "E2E_SERVICE_UNAVAILABLE",
      );
    }
    return this.verificationE2e;
  }

  private trackTask(task: Promise<void>): void {
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
  }

  private acquireWorkspaceMutations(roots: readonly string[]): () => void {
    const releases: Array<() => void> = [];
    try {
      for (const root of [...new Set(roots.map((candidate) => path.resolve(candidate)))].sort()) {
        releases.push(this.acquireWorkspaceMutation(root));
      }
    } catch (error) {
      for (const release of releases.reverse()) release();
      throw error;
    }
    return () => {
      for (const release of releases.reverse()) release();
    };
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled([...this.tasks]);
  }

  private async withArtifactRevisionLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.artifactRevisionLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.artifactRevisionLocks.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.artifactRevisionLocks.get(key) === tail) {
        this.artifactRevisionLocks.delete(key);
      }
    }
  }

  private acquireWorkspaceMutation(projectRoot: string): () => void {
    if (this.activeWorkspaceMutations.has(projectRoot)) {
      throw new AppError(
        "该项目工作区正在执行或保存另一项产物变更，请稍后重试",
        409,
        "PROJECT_WORKSPACE_BUSY",
      );
    }
    this.activeWorkspaceMutations.add(projectRoot);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeWorkspaceMutations.delete(projectRoot);
    };
  }

  private async assertFigmaReady(
    projectRoot: string,
    options: { force?: boolean } = {},
  ): Promise<void> {
    if (!this.figmaIntegration) {
      throw new AppError(
        "Figma 集成服务未配置",
        503,
        "FIGMA_UNAVAILABLE"
      );
    }
    let status;
    try {
      status = await this.figmaIntegration.status(projectRoot, options);
    } catch {
      throw new AppError(
        "暂时无法检测 Figma 授权，请稍后重试",
        503,
        "FIGMA_UNAVAILABLE"
      );
    }
    if (status.state !== "ready") throw figmaStatusError(status);
  }

  private async resolveFigmaPlans(
    projectRoot: string,
    options: { force?: boolean } = {},
  ): Promise<FigmaPlanCapabilitiesDto> {
    if (!this.figmaIntegration) {
      throw new AppError("Figma 集成服务未配置", 503, "FIGMA_UNAVAILABLE");
    }
    let status;
    try {
      status = await this.figmaIntegration.status(projectRoot, options);
    } catch {
      throw new AppError(
        "暂时无法检测 Figma 授权，请稍后重试",
        503,
        "FIGMA_UNAVAILABLE"
      );
    }
    if (status.state !== "ready") throw figmaStatusError(status);
    try {
      return await this.figmaIntegration.plans(projectRoot, options);
    } catch {
      throw new AppError(
        "Figma 已授权，但暂时无法读取可用计划，请重新检测",
        503,
        "FIGMA_PLAN_DISCOVERY_FAILED"
      );
    }
  }

  private async architectureBaselineCandidate(
    bundle: RunBundle,
    definition: LoadedDefinition,
  ): Promise<ArchitectureBaselineDto | null> {
    const phase = bundle.phases.find((candidate) => candidate.phaseId === "architecture");
    if (
      !phase
      || phase.status !== "ready"
      || phase.artifacts.length > 0
    ) return null;
    const phaseDefinition = definition.phases.find((candidate) => candidate.id === "architecture");
    if (!phaseDefinition) return null;
    const baselines = await this.architectureBaselineCandidates(
      bundle.project.id,
      bundle.run.id,
    );
    const eligible = this.firstEligibleArchitectureBaseline(
      baselines,
      architectureArtifactContracts(definition, phaseDefinition.outputs),
    );
    if (!eligible) return null;
    return {
      sourceRunId: eligible.record.sourceRunId,
      sourceRunTitle: eligible.record.sourceRunTitle,
      sourcePhaseRunId: eligible.record.sourcePhaseRunId,
      approvedAt: eligible.approvedAt,
      artifacts: eligible.record.artifacts.map((artifact) => ({
        id: artifact.id,
        artifactKey: artifact.artifactKey,
        contentHash: artifact.contentHash,
      })),
      selection: eligible.selection,
    };
  }

  private async phaseBaselineCandidate<TPhaseId extends "discovery" | "design">(
    bundle: RunBundle,
    definition: LoadedDefinition,
    phaseId: TPhaseId,
  ): Promise<PhaseBaselineDto<TPhaseId> | null> {
    const phase = bundle.phases.find((candidate) => candidate.phaseId === phaseId);
    if (!phase || phase.status !== "ready" || phase.resolution) return null;
    const businessHeads = phase.artifacts.filter(
      (artifact) => artifact.artifactKey !== CHANGE_CONTRACT_ARTIFACT_KEY,
    );
    if (businessHeads.length > 0) return null;
    if (typeof this.store.approvedPhaseBaselineCandidates !== "function") return null;
    const phaseDefinition = definition.phases.find((candidate) => candidate.id === phaseId);
    if (!phaseDefinition) return null;
    const downstreamInputs = new Set(
      definition.phases
        .filter((candidate) => phasePosition(candidate.id) > phasePosition(phaseId))
        .flatMap((candidate) => candidate.inputs),
    );
    const requiredKeys = phaseId === "discovery"
      ? phaseDefinition.outputs.filter((key) => key !== CHANGE_CONTRACT_ARTIFACT_KEY)
      : phaseDefinition.outputs.filter((key) =>
          key === "design-baseline"
          || key === "design-spec"
          || downstreamInputs.has(key)
        );
    const candidates = await this.store.approvedPhaseBaselineCandidates(
      bundle.project.id,
      phaseId,
      bundle.run.id,
    );
    for (const candidate of candidates) {
      const artifacts = candidate.artifacts.filter((artifact) =>
        phaseDefinition.outputs.includes(artifact.artifactKey)
        && artifact.artifactKey !== CHANGE_CONTRACT_ARTIFACT_KEY
      );
      const keys = new Set(artifacts.map((artifact) => artifact.artifactKey));
      if (!requiredKeys.every((key) => keys.has(key))) continue;
      try {
        await this.validateArtifactWorkspaceSnapshots(bundle.project.rootPath, artifacts);
      } catch {
        // A structurally valid historical baseline whose files no longer match
        // its approved snapshots is not reusable. Continue to an older eligible
        // candidate instead of presenting a choice that can only fail on submit.
        continue;
      }
      return {
        phaseId,
        sourceRunId: candidate.sourceRunId,
        sourceRunTitle: candidate.sourceRunTitle,
        sourcePhaseRunId: candidate.sourcePhaseRunId,
        approvedAt: candidate.approvedAt,
        artifacts: artifacts.map((artifact) => ({
          id: artifact.id,
          artifactKey: artifact.artifactKey,
          contentHash: artifact.contentHash,
        })),
      };
    }
    return null;
  }

  private async requirePhaseBaseline(
    projectId: string,
    excludeRunId: string,
    phaseId: "discovery" | "design",
    expectedArtifactIds: string[],
    allowedArtifactKeys: string[],
  ): Promise<PhaseBaselineRecord> {
    const candidates = await this.store.approvedPhaseBaselineCandidates(
      projectId,
      phaseId,
      excludeRunId,
    );
    const allowed = new Set(allowedArtifactKeys);
    const candidate = candidates.find((baseline) => {
      const relevant = baseline.artifacts.filter((artifact) =>
        allowed.has(artifact.artifactKey)
      );
      return sameStringSet(relevant.map((artifact) => artifact.id), expectedArtifactIds);
    });
    if (!candidate) {
      throw new AppError(
        "阶段基线已变化，请刷新后重新执行 Impact Check",
        409,
        "PHASE_BASELINE_CHANGED",
      );
    }
    return candidate;
  }

  private async architectureBaselineCandidates(
    projectId: string,
    excludeRunId: string,
  ): Promise<ArchitectureBaselineRecord[]> {
    if (typeof this.store.approvedArchitectureBaselineCandidates === "function") {
      return this.store.approvedArchitectureBaselineCandidates(projectId, excludeRunId);
    }
    if (typeof this.store.latestApprovedArchitectureBaseline !== "function") return [];
    const latest = await this.store.latestApprovedArchitectureBaseline(projectId, excludeRunId);
    return latest ? [latest] : [];
  }

  private requireEligibleArchitectureBaseline(
    baselines: ArchitectureBaselineRecord[],
    requiredArtifacts: Array<{ artifactKey: string; filePath: string }>,
  ): {
    record: ArchitectureBaselineRecord;
    selection: ArchitectureSelectionEvidence;
    approvedAt: string;
  } {
    const eligible = this.firstEligibleArchitectureBaseline(baselines, requiredArtifacts);
    if (!eligible) {
      throw new AppError(
        "当前项目没有完整、已批准且带有效选型证据的架构基线",
        409,
        "ARCHITECTURE_BASELINE_UNAVAILABLE",
      );
    }
    return eligible;
  }

  private firstEligibleArchitectureBaseline(
    baselines: ArchitectureBaselineRecord[],
    requiredArtifacts: Array<{ artifactKey: string; filePath: string }>,
  ): {
    record: ArchitectureBaselineRecord;
    selection: ArchitectureSelectionEvidence;
    approvedAt: string;
  } | undefined {
    for (const baseline of baselines) {
      const eligible = this.eligibleArchitectureBaseline(baseline, requiredArtifacts);
      if (eligible) return eligible;
    }
    return undefined;
  }

  private eligibleArchitectureBaseline(
    baseline: ArchitectureBaselineRecord | null,
    requiredArtifacts: Array<{ artifactKey: string; filePath: string }>,
  ): {
    record: ArchitectureBaselineRecord;
    selection: ArchitectureSelectionEvidence;
    approvedAt: string;
  } | undefined {
    if (!baseline) return undefined;
    const artifacts = baseline.artifacts;
    const artifactIds = artifacts.map((artifact) => artifact.id);
    const artifactKeys = artifacts.map((artifact) => artifact.artifactKey);
    const requiredArtifactKeys = requiredArtifacts.map((artifact) => artifact.artifactKey);
    const requiredPaths = new Map(
      requiredArtifacts.map((artifact) => [artifact.artifactKey, artifact.filePath]),
    );
    if (
      new Set(artifactIds).size !== artifactIds.length
      || !sameStringSet(artifactKeys, requiredArtifactKeys)
      || artifacts.some((artifact) => artifact.reviewStatus !== "approved")
      || artifacts.some((artifact) => requiredPaths.get(artifact.artifactKey) !== artifact.filePath)
    ) return undefined;
    const approval = baseline.reviews.find((review) =>
      review.decision === "approve" && sameStringSet(review.artifactIds, artifactIds)
    );
    if (!approval) return undefined;
    const options = artifacts.find((artifact) => artifact.artifactKey === "architecture-options");
    const discovery = artifacts.find(
      (artifact) => artifact.artifactKey === "architecture-discovery-context",
    );
    if (!options || !discovery) return undefined;
    const sourceImpact = baseline.architectureImpact;
    if (sourceImpact) {
      const affected = new Set(
        sourceImpact.mode === "partial" ? sourceImpact.affectedOutputKeys : [],
      );
      const sourceIds = new Set(sourceImpact.sourceArtifactIds);
      const inheritedHeadDiverged = artifacts
        .filter((artifact) => !affected.has(artifact.artifactKey))
        .some((artifact) => artifact.revision !== 1
          || !artifact.parentArtifactId
          || !sourceIds.has(artifact.parentArtifactId));
      if (inheritedHeadDiverged) return undefined;
    }
    const inherited = sourceImpact?.selection;
    const selection = inherited ?? findArchitectureSelectionEvidence(
      options.id,
      options.content,
      baseline.reviews,
      [options.id, discovery.id],
    );
    if (
      !selection
      || !architectureOptionIds(options.content).some(
        (optionId) => optionId.toLocaleLowerCase("en-US")
          === selection.optionId.toLocaleLowerCase("en-US"),
      )
    ) return undefined;
    const selectedAt = Date.parse(selection.selectedAt);
    const postSelectionArtifacts = artifacts.filter((artifact) =>
      requiredArchitecturePostSelectionOutputs.includes(artifact.artifactKey)
    );
    if (
      !Number.isFinite(selectedAt)
      || postSelectionArtifacts.some((artifact) => {
        const createdAt = Date.parse(artifact.createdAt);
        return !Number.isFinite(createdAt) || createdAt <= selectedAt;
      })
    ) return undefined;
    return {
      record: baseline,
      selection,
      approvedAt: approval.createdAt,
    };
  }

  private async validateArchitectureBaselineWorkspace(
    projectRoot: string,
    baseline: ArchitectureBaselineRecord,
  ): Promise<void> {
    await this.validateArtifactWorkspaceSnapshots(projectRoot, baseline.artifacts);
  }

  private async validateCurrentArchitectureWorkspace(
    projectRoot: string,
    runId: string,
  ): Promise<void> {
    const artifacts = await this.store.currentArtifactSnapshotsForPhase(runId, "architecture");
    await this.validateArtifactWorkspaceSnapshots(projectRoot, artifacts);
  }

  private async validateArtifactWorkspaceSnapshots(
    projectRoot: string,
    artifacts: Array<{
      id: string;
      artifactKey: string;
      filePath: string;
      content: string;
    }>,
  ): Promise<void> {
    for (const artifact of artifacts) {
      const absolutePath = path.resolve(projectRoot, artifact.filePath);
      await assertRuntimePath(projectRoot, absolutePath);
      let physical: string;
      try {
        physical = await readArtifactContent(absolutePath, 2_000_000);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        throw new AppError(
          `架构基线 ${artifact.artifactKey} 的工作区产物已不存在`,
          409,
          "ARTIFACT_WORKSPACE_SNAPSHOT_MISMATCH",
          { artifactId: artifact.id, artifactKey: artifact.artifactKey, missing: true },
        );
      }
      if (physical !== artifact.content) {
        throw new AppError(
          `架构基线 ${artifact.artifactKey} 的数据库快照与工作区不一致`,
          409,
          "ARTIFACT_WORKSPACE_SNAPSHOT_MISMATCH",
          { artifactId: artifact.id, artifactKey: artifact.artifactKey },
        );
      }
    }
  }

  private async assertProjectPath(storedRootPath: string): Promise<void> {
    const canonical = await this.paths.resolveProjectPath(storedRootPath);
    if (canonical !== storedRootPath) {
      throw new AppError("项目目录的真实路径已变化，请重新注册", 409, "PROJECT_PATH_CHANGED");
    }
  }

  private async architectureSelectionEvidence(
    phase: PhaseRunDto,
  ): Promise<ArchitectureSelectionEvidence | undefined> {
    const optionsHead = phase.artifacts.find(
      (artifact) => artifact.artifactKey === "architecture-options",
    );
    const discoveryHead = phase.artifacts.find(
      (artifact) => artifact.artifactKey === "architecture-discovery-context",
    );
    if (!optionsHead || !discoveryHead) return undefined;
    const options = await this.store.getArtifact(optionsHead.id);
    if (phase.architectureImpact?.selection) {
      const impact = phase.architectureImpact;
      const sourceIds = new Set(impact.sourceArtifactIds);
      const inheritedCheckpointIsIntact = optionsHead.revision === 1
        && discoveryHead.revision === 1
        && optionsHead.parentArtifactId !== null
        && discoveryHead.parentArtifactId !== null
        && sourceIds.has(optionsHead.parentArtifactId)
        && sourceIds.has(discoveryHead.parentArtifactId);
      const selectedOptionStillExists = architectureOptionIds(options.content ?? "").filter(
        (optionId) => optionId.toLocaleLowerCase("en-US")
          === impact.selection.optionId.toLocaleLowerCase("en-US"),
      ).length === 1;
      return inheritedCheckpointIsIntact && selectedOptionStillExists
        ? impact.selection
        : undefined;
    }
    return findArchitectureSelectionEvidence(
      optionsHead.id,
      options.content ?? "",
      phase.reviews,
      [optionsHead.id, discoveryHead.id],
    );
  }

  private async validateArchitectureRulebookGate(
    projectRoot: string,
    runId: string,
    stage: "checkpoint" | "final",
    architectureSelection?: ArchitectureSelectionEvidence,
  ): Promise<void> {
    const artifacts = await this.store.currentArtifactSnapshotsForPhase(runId, "architecture");
    if (stage === "final") {
      await this.validateArtifactWorkspaceSnapshots(projectRoot, artifacts);
    }
    if (!await architectureRulebookValidationRequired(projectRoot)) return;
    const options = artifacts.find((artifact) => artifact.artifactKey === "architecture-options");
    await validateArchitectureRulebookReview({
      projectRoot,
      stage,
      artifacts,
      documentedOptionIds: architectureOptionIds(options?.content ?? ""),
      architectureSelection,
    });
  }

  private async performExecution(request: Parameters<CodexTerminalRunner["run"]>[0]): Promise<void> {
    let sequence = 0;
    const event = async (eventType: string, payload: unknown) => {
      sequence += 1;
      await this.store.appendEvent(request.executionId, sequence, eventType, payload);
    };
    try {
      const selectedOutputKeys = new Set(request.selectedOutputKeys ?? request.phase.outputs);
      const selectedOutputPaths = request.definition.artifacts
        .filter((artifact) => selectedOutputKeys.has(artifact.id))
        .map((artifact) => ({ id: artifact.id, absolutePath: artifact.absolutePath }));
      await withArtifactPathsRollbackOnError(
        request.project.rootPath,
        selectedOutputPaths,
        2_000_000,
        async () => {
          const result = await this.runner.run(request, event);
          const storyArtifact = result.artifacts.find(
            (artifact) => artifact.artifactKey === "user-stories",
          );
          const ticketSync = storyArtifact
            ? {
                artifactKey: storyArtifact.artifactKey,
                tickets: ticketRecords(storyArtifact.filePath, storyArtifact.content),
              }
            : undefined;
          await this.store.completeExecution(
            request.executionId,
            result.exitCode,
            result.artifacts,
            ticketSync,
          );
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await event("runner.failed", { message });
      } finally {
        await this.store.failExecution(
          request.executionId,
          error instanceof AppError && typeof (error.details as { exitCode?: unknown })?.exitCode === "number"
            ? (error.details as { exitCode: number }).exitCode
            : null,
          message
        );
      }
    }
  }

  private async ensureTicketsFromLatestArtifact(runId: string) {
    const existing = await this.store.listTickets(runId);
    if (existing.length > 0) return existing;
    const artifact = await this.store.latestUserStoriesArtifact(runId);
    if (!artifact) return existing;
    const tickets = ticketRecords(artifact.filePath, artifact.content);
    await this.store.syncTickets(runId, artifact.id, tickets);
    return this.store.listTickets(runId);
  }
}

function assertProjectCreationActive(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new AppError(
    "项目创建请求已取消 (aborted)",
    400,
    "PROJECT_CREATION_ABORTED",
    signal.reason,
  );
}

function verificationGitMetadataPaths(state: VerificationGitState): string[] {
  return state.kind === "not_repository"
    ? []
    : [...new Set([state.gitDirectory, state.gitCommonDirectory])];
}

function requiredRunPhase(bundle: RunBundle, phaseId: PhaseId): PhaseRunDto {
  const phase = bundle.phases.find((candidate) => candidate.phaseId === phaseId);
  if (!phase) throw new AppError(`阶段 ${phaseId} 不存在`, 404, "PHASE_NOT_FOUND");
  return phase;
}

function resolveE2eScriptReviewAuthority(
  phase: PhaseRunDto,
  authoring: E2eAuthoringDto,
): { authority: VerificationE2eScriptReviewAuthority | null; mismatch: boolean } {
  const latest = phase.events
    .filter(({ executionId, eventType }) => (
      executionId === authoring.executionId && eventType === "e2e.script.reviewed"
    ))
    .sort((left, right) => left.sequence - right.sequence)
    .at(-1);
  if (!latest || typeof latest.payload !== "object" || latest.payload === null) {
    return { authority: null, mismatch: false };
  }
  const payload = latest.payload as Record<string, unknown>;
  if (
    !["approve", "request_changes"].includes(String(payload.decision))
    || typeof payload.authorExecutionId !== "string"
    || typeof payload.patchHash !== "string"
    || typeof payload.productRevisionToken !== "string"
    || typeof payload.e2eRevisionToken !== "string"
    || typeof payload.commentHash !== "string"
    || typeof payload.reviewedAt !== "string"
    || !/^[a-f0-9]{64}$/u.test(payload.commentHash)
    || Number.isNaN(Date.parse(payload.reviewedAt))
  ) return { authority: null, mismatch: true };
  const authority = payload as unknown as VerificationE2eScriptReviewAuthority;
  const matches = authority.authorExecutionId === authoring.executionId
    && authority.patchHash === authoring.patchHash
    && authority.productRevisionToken === authoring.productRevisionToken
    && authority.e2eRevisionToken === authoring.e2eRevisionToken;
  return matches
    ? { authority, mismatch: false }
    : { authority: null, mismatch: true };
}

function assertTrustedE2eAuthoringExecution(
  bundle: RunBundle,
  authoring: E2eAuthoringDto,
): void {
  const phase = requiredRunPhase(bundle, "verification");
  const execution = phase.executions.find(({ id }) => id === authoring.executionId);
  const materialized = phase.events
    .filter(({ executionId, eventType }) => (
      executionId === authoring.executionId && eventType === "e2e.authoring.materialized"
    ))
    .sort((left, right) => left.sequence - right.sequence)
    .at(-1);
  const payload = materialized?.payload && typeof materialized.payload === "object"
    ? materialized.payload as Record<string, unknown>
    : null;
  const eventFiles = Array.isArray(payload?.files)
    ? payload.files.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object") return [];
      const file = candidate as Record<string, unknown>;
      return typeof file.path === "string"
        && typeof file.sha256 === "string"
        && typeof file.bytes === "number"
        ? [`${file.path}\0${file.sha256}\0${file.bytes}`]
        : [];
    }).sort()
    : [];
  const authoredFiles = authoring.files
    .map(({ path: filePath, sha256, bytes }) => `${filePath}\0${sha256}\0${bytes}`)
    .sort();
  if (
    !execution
    || execution.status !== "completed"
    || verificationE2eExecutionKind(phase, execution.id) !== "author"
    || !payload
    || payload.patchHash !== authoring.patchHash
    || payload.productRevisionToken !== authoring.productRevisionToken
    || payload.e2eRevisionToken !== authoring.e2eRevisionToken
    || eventFiles.length !== authoredFiles.length
    || eventFiles.some((value, index) => value !== authoredFiles[index])
  ) {
    throw new AppError(
      "E2E authoring record is not bound to a completed author execution in this run",
      409,
      "E2E_AUTHORING_EXECUTION_UNTRUSTED",
    );
  }
}

function e2eFailureExitCode(error: unknown): number | null {
  const value = error instanceof AppError
    ? (error.details as { exitCode?: unknown } | undefined)?.exitCode
    : undefined;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function e2eFailureDetails(error: unknown, stage: string): {
  stage: string;
  code: string;
  message: string;
} {
  return {
    stage,
    code: error instanceof AppError ? error.code : "E2E_UNEXPECTED_FAILURE",
    message: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
  };
}

function verificationE2eExecutions(phase: PhaseRunDto): ExecutionDto[] {
  const executionIds = new Set(
    phase.events
      .filter(({ eventType }) => eventType.startsWith("e2e."))
      .map(({ executionId }) => executionId),
  );
  return phase.executions.filter(({ id }) => executionIds.has(id));
}

function verificationE2eExecutionKind(
  phase: PhaseRunDto,
  executionId: string,
): "author" | "execute" | null {
  const events = phase.events.filter((event) => event.executionId === executionId);
  if (events.some(({ eventType }) => eventType.startsWith("e2e.execution."))) return "execute";
  if (events.some(({ eventType }) => eventType.startsWith("e2e.authoring."))) return "author";
  return null;
}

export function assertLinkedE2eApprovalObligation(
  phase: PhaseRunDto,
  verificationArtifacts: readonly CurrentArtifactSnapshot[],
): void {
  const linkedSelected = phase.events.some(({ eventType }) => (
    eventType === "e2e.authoring.queued" || eventType === "e2e.authoring.started"
  ));
  if (!linkedSelected) return;
  const reportHead = verificationArtifacts.find(({ artifactKey }) => artifactKey === "test-report");
  const execution = reportHead?.executionId
    ? phase.executions.find(({ id }) => id === reportHead.executionId)
    : undefined;
  const completedEvent = execution
    ? phase.events
      .filter(({ executionId, eventType }) => (
        executionId === execution.id && eventType === "e2e.execution.completed"
      ))
      .sort((left, right) => left.sequence - right.sequence)
      .at(-1)
    : undefined;
  const payload = completedEvent?.payload && typeof completedEvent.payload === "object"
    ? completedEvent.payload as Record<string, unknown>
    : null;
  if (
    !execution
    || execution.status !== "completed"
    || execution.exitCode !== 0
    || verificationE2eExecutionKind(phase, execution.id) !== "execute"
    || !isTrustedLinkedE2eCompletedPayload(payload)
  ) {
    throw new AppError(
      "本 Run 已选择 Linked E2E；当前 test-report 必须来自同 Run 成功的受监督浏览器执行",
      409,
      "E2E_LINKED_EXECUTION_REQUIRED",
    );
  }
}

function isTrustedLinkedE2eCompletedPayload(
  payload: Record<string, unknown> | null,
): boolean {
  if (!payload) return false;
  const browser = payload.browser !== null && typeof payload.browser === "object"
    ? payload.browser as Record<string, unknown>
    : null;
  const target = payload.targetProbe !== null && typeof payload.targetProbe === "object"
    ? payload.targetProbe as Record<string, unknown>
    : null;
  if (
    payload.passed !== true
    || payload.exitCode !== 0
    || payload.testExitCode !== 0
    || !["already_exited", "sigterm"].includes(String(payload.serverCleanup))
    || typeof payload.baseUrl !== "string"
    || !browser
    || typeof browser.executablePath !== "string"
    || browser.executablePath.length === 0
    || typeof browser.version !== "string"
    || browser.version.length === 0
    || !target
    || typeof target.url !== "string"
    || !Number.isInteger(target.status)
    || (target.status as number) < 200
    || (target.status as number) >= 500
    || typeof target.browserVersion !== "string"
    || target.browserVersion.length === 0
    || target.browserVersion !== browser.version
  ) return false;
  try {
    const configured = new URL(payload.baseUrl);
    const navigated = new URL(target.url);
    return configured.origin === navigated.origin && configured.href === navigated.href;
  } catch {
    return false;
  }
}

function e2eReadinessBlockers(readiness: E2eWorkspaceReadinessDto): string[] {
  const items: Array<[string, E2eReadinessItemDto]> = [
    ["workspace", readiness.workspace],
    ["playwright", readiness.playwright],
    ["browser", readiness.browser],
    ["sourceStartScript", readiness.sourceStartScript],
    ["target", readiness.target],
  ];
  return items.flatMap(([label, item]) => (
    item.state !== "ready"
      ? [`${label}: ${item.message}${item.detail ? ` — ${item.detail}` : ""}`]
      : []
  ));
}

function unprobedE2eReadiness(): E2eWorkspaceReadinessDto {
  const item = {
    state: "not_checked" as const,
    message: "E2E_PREFLIGHT_REQUIRED",
    detail: "请显式运行预检；读取流程状态不会启动 Chromium。",
  };
  return {
    ready: false,
    workspace: item,
    playwright: item,
    browser: item,
    sourceStartScript: item,
    target: item,
    checkedAt: new Date(0).toISOString(),
  };
}

function ticketRecords(artifactPath: string, content: string) {
  const basePath = artifactPath.replaceAll("\\", "/").replace(/\/+$/u, "");
  return parseUserStoryTickets(content).map((ticket) => ({
    ...ticket,
    sourcePath: [basePath, ticket.sourcePath].filter(Boolean).join("/")
  }));
}

function publicDefinition(definition: LoadedDefinition): WorkflowDefinition {
  return {
    version: definition.version,
    project: definition.project,
    roles: definition.roles,
    phases: definition.phases
  };
}

function taskDefinition(bundle: RunBundle, definition: LoadedDefinition): LoadedDefinition {
  // Loader injection makes Change Contract available to every newly-created
  // Run without rewriting project YAML. Rows created before that feature have
  // neither the immutable contract nor its artifact, so retain their original
  // graph instead of introducing an impossible approval/input requirement.
  const compatibleDefinition = bundle.run.changeContract
    ? definition
    : {
        ...definition,
        artifacts: definition.artifacts.filter(
          (artifact) => artifact.id !== CHANGE_CONTRACT_ARTIFACT_KEY,
        ),
        phases: definition.phases.map((phase) => ({
          ...phase,
          inputs: phase.inputs.filter((key) => key !== CHANGE_CONTRACT_ARTIFACT_KEY),
          outputs: phase.outputs.filter((key) => key !== CHANGE_CONTRACT_ARTIFACT_KEY),
        })),
      };
  const persistedTaskArtifacts = [...TASK_SCOPED_ARTIFACT_KEYS]
    .flatMap((artifactKey) => {
      const filePath = bundle.artifactPaths[artifactKey];
      return filePath ? [{ artifactKey, filePath }] : [];
    });
  const existingHeads = bundle.phases.flatMap((phase) => phase.artifacts);
  return pinExistingTaskArtifactPaths(
    resolveTaskArtifactPaths(compatibleDefinition, bundle.run),
    bundle.project.rootPath,
    [
      ...existingHeads.filter((artifact) => TASK_SCOPED_ARTIFACT_KEYS.has(artifact.artifactKey)),
      ...persistedTaskArtifacts,
    ],
  );
}

function outputKeysByPhase(
  definition: LoadedDefinition,
): Partial<Record<PhaseId, string[]>> {
  return Object.fromEntries(
    definition.phases.map((phase) => [phase.id, phase.outputs]),
  );
}

function architectureArtifactContracts(
  definition: LoadedDefinition,
  outputKeys: string[],
): Array<{ artifactKey: string; filePath: string }> {
  return outputKeys.map((artifactKey) => {
    const artifact = definition.artifacts.find((candidate) => candidate.id === artifactKey);
    if (!artifact) {
      throw new AppError(
        `架构阶段输出 ${artifactKey} 没有注册产物路径`,
        400,
        "CONFIG_INVALID",
      );
    }
    return { artifactKey, filePath: artifact.relativePath };
  });
}

function attachAvailableArtifacts(bundle: RunBundle, definition: LoadedDefinition): void {
  for (const phase of bundle.phases) {
    const acceptedKeys = new Set(definition.phases.find((item) => item.id === phase.phaseId)?.inputs ?? []);
    phase.availableArtifacts = bundle.phases
      .filter((candidate) => candidate.position < phase.position && candidate.status === "approved")
      .flatMap((candidate) => candidate.artifacts)
      .filter((artifact) => artifact.reviewStatus === "approved" && acceptedKeys.has(artifact.artifactKey));
  }
}

function figmaStatusError(status: FigmaIntegrationStatusDto): AppError {
  const code = status.state === "not_configured"
    ? "FIGMA_NOT_CONFIGURED"
    : status.state === "authorization_required"
      ? "FIGMA_AUTH_REQUIRED"
      : "FIGMA_UNAVAILABLE";
  return new AppError(status.message, 409, code, status);
}

export function requireFigmaTarget(target: FigmaTarget | undefined): FigmaTarget {
  if (!target) {
    throw new AppError(
      "请先选择新建私人 Draft 或指定已有 Figma 文件",
      400,
      "FIGMA_TARGET_REQUIRED"
    );
  }
  return target;
}

export function resolveNewPrivateDraftTarget(
  target: Extract<FigmaTarget, { mode: "new_private_draft" }>,
  capabilities: FigmaPlanCapabilitiesDto,
): ResolvedFigmaTarget {
  const selectedPlan = capabilities.plans.find((plan) => plan.key === target.planKey);
  if (!selectedPlan) {
    throw new AppError(
      "选择的 Figma 计划已不存在或已变更，请重新选择",
      409,
      "FIGMA_PLAN_NOT_AVAILABLE"
    );
  }
  if (!selectedPlan.writable) {
    throw new AppError(
      "选择的 Figma 计划是只读 seat，不能创建私人 Draft",
      409,
      "FIGMA_PLAN_READ_ONLY"
    );
  }
  return {
    mode: "new_private_draft",
    planKey: selectedPlan.key,
    fileName: target.fileName,
  };
}

export function resolveExistingFigmaTarget(
  target: Extract<FigmaTarget, { mode: "existing_file" }>,
): ResolvedFigmaTarget {
  let parsed: URL;
  try {
    parsed = new URL(target.fileUrl);
  } catch {
    throw invalidFigmaFileUrl();
  }
  if (
    parsed.protocol !== "https:" ||
    !["figma.com", "www.figma.com"].includes(parsed.hostname) ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    /%2f|%5c/iu.test(parsed.pathname)
  ) {
    throw invalidFigmaFileUrl();
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const kind = segments[0];
  const fileKey = segments[1];
  if (
    !["design", "file"].includes(kind ?? "") ||
    typeof fileKey !== "string" ||
    !/^[a-zA-Z0-9_-]{2,256}$/u.test(fileKey) ||
    segments.slice(2).some((segment) => {
      try {
        return decodeURIComponent(segment).toLowerCase() === "branch";
      } catch {
        return true;
      }
    })
  ) {
    throw invalidFigmaFileUrl();
  }
  const nodeIds = parsed.searchParams.getAll("node-id");
  if (
    nodeIds.length > 1 ||
    (nodeIds[0] !== undefined && !/^\d+(?:-|:)\d+$/u.test(nodeIds[0]))
  ) {
    throw invalidFigmaFileUrl();
  }
  const canonical = new URL(`https://www.figma.com/${kind}/${fileKey}`);
  if (nodeIds[0]) canonical.searchParams.set("node-id", nodeIds[0]);
  return {
    mode: "existing_file",
    fileUrl: canonical.toString(),
    fileKey,
    ...(nodeIds[0] ? { nodeId: nodeIds[0].replace("-", ":") } : {}),
  };
}

function invalidFigmaFileUrl(): AppError {
  return new AppError(
    "请输入官方 Figma Design 文件链接（https://figma.com/design/... 或 /file/...）",
    400,
    "FIGMA_FILE_URL_INVALID"
  );
}

function sameStringSet(left: string[], right: string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size
    && [...leftSet].every((value) => rightSet.has(value));
}
