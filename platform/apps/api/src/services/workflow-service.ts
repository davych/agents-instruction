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
  type CreateArtifactRevisionInput,
  type CreateProjectInput,
  type CreateRunInput,
  type DesignBaselineDto,
  type ExecutePhaseInput,
  type FigmaIntegrationStatusDto,
  type FigmaPlanCapabilitiesDto,
  type FigmaTarget,
  type PhaseId,
  type PhaseBaselineDto,
  type PhaseResolutionDto,
  type PhaseRunDto,
  type ProductBaselineDto,
  type ReviewPhaseInput,
  type WorkflowDefinition
} from "@ai-sdlc/contracts";

import type {
  ApplyPhaseResolutionInput,
  ArchitectureBaselineRecord,
  PhaseBaselineRecord,
  PgWorkflowStore,
  RunBundle,
} from "../db/store.js";
import { AppError } from "../domain/errors.js";
import {
  CHANGE_CONTRACT_ARTIFACT_KEY,
  effectiveRequiredInputKeys,
  legacyChangeContract,
  renderChangeContract,
  validatePhaseResolutionArtifactMutation,
  validatePhaseResolutionExecution,
} from "../domain/change-routing.js";
import {
  pinExistingTaskArtifactPaths,
  resolveTaskArtifactPaths,
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
import { CodexExecutionCapabilities } from "./codex-execution-capabilities.js";
import {
  assertRuntimePath,
  prepareArtifactRevision,
  readArtifactContent,
} from "./artifact-workspace.js";
import {
  architectureRulebookValidationRequired,
  validateArchitectureRulebookReview,
} from "./architecture-rulebook-runtime.js";
import { loadDefinition, type LoadedDefinition } from "./definition-loader.js";
import type { FigmaMcpIntegration } from "./figma-mcp-integration.js";
import { initializeCodexProject } from "./project-initializer.js";
import { ProjectPathPolicy } from "./project-paths.js";

export class WorkflowService {
  private readonly tasks = new Set<Promise<void>>();
  private readonly artifactRevisionLocks = new Map<string, Promise<void>>();
  private readonly activeWorkspaceMutations = new Set<string>();

  constructor(
    private readonly store: PgWorkflowStore,
    private readonly paths: ProjectPathPolicy,
    private readonly runner: CodexTerminalRunner,
    private readonly cliPath?: string,
    private readonly figmaIntegration?: FigmaMcpIntegration,
    private readonly codexCapabilities?: CodexExecutionCapabilities
  ) {}

  async listProjects() {
    return this.store.listProjects();
  }

  async createProject(input: CreateProjectInput) {
    const summary = input.summary || "由 AI SDLC 平台管理的项目";
    let rootPath = await this.paths.resolveProjectPath(input.rootPath, input.initialize);
    if (input.initialize) {
      await initializeCodexProject(rootPath, input.name, summary, {
        cliPath: this.cliPath
      });
      rootPath = await this.paths.resolveProjectPath(rootPath);
    }
    const definition = await loadDefinition(rootPath);
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
    const changeContract = input.changeContract
      ?? legacyChangeContract(input.title, input.objective);
    const runObjective = input.changeContract ? changeContract.summary : input.objective;
    const changeContractArtifact = resolved.artifacts.find(
      (artifact) => artifact.id === CHANGE_CONTRACT_ARTIFACT_KEY,
    );
    const artifactPaths: Record<string, string> = { "design-spec": designSpec.relativePath };
    let materializedChangeContractPath: string | undefined;
    try {
      let persistedChangeContractArtifact;
      if (changeContractArtifact) {
        const content = renderChangeContract(changeContract);
        await mkdir(path.dirname(changeContractArtifact.absolutePath), { recursive: true });
        await assertRuntimePath(project.rootPath, path.dirname(changeContractArtifact.absolutePath));
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

  async executePhase(runId: string, phaseId: PhaseId, input: ExecutePhaseInput) {
    if (new Set(input.selectedArtifactIds).size !== input.selectedArtifactIds.length) {
      throw new AppError("selectedArtifactIds 不能重复", 400, "DUPLICATE_ARTIFACT_SELECTION");
    }
    const bundle = await this.store.getRun(runId);
    await this.assertProjectPath(bundle.project.rootPath);
    const releaseWorkspace = this.acquireWorkspaceMutation(bundle.project.rootPath);
    try {
    const definition = taskDefinition(bundle, await loadDefinition(bundle.project.rootPath));
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
    if (adoptedArchitecture && phasePosition(phaseId) > phasePosition("architecture")) {
      await this.validateCurrentArchitectureWorkspace(bundle.project.rootPath, runId);
    }
    if (partialImpact) {
      await this.validateCurrentArchitectureWorkspace(bundle.project.rootPath, runId);
    }
    const currentArtifacts = await this.store.currentArtifactSnapshotsForPhase(runId, phaseId);
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
      revisionFeedback: currentPhase.reviews
        .filter((review) => review.decision === "request_changes")
        .slice(0, 5)
        .map((review) => review.comment),
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
    if (
      hasPriorRoutedPhase
      && latestCompletedExecution?.selectedArtifactIds.length
      && typeof this.store.selectionArtifacts === "function"
    ) {
      const executionInputs = await this.store.selectionArtifacts(
        runId,
        latestCompletedExecution.selectedArtifactIds,
      );
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
      const result = await this.runner.run(request, event);
      const storyArtifact = result.artifacts.find((artifact) => artifact.artifactKey === "user-stories");
      const ticketSync = storyArtifact
        ? {
            artifactKey: storyArtifact.artifactKey,
            tickets: ticketRecords(storyArtifact.filePath, storyArtifact.content)
          }
        : undefined;
      await this.store.completeExecution(
        request.executionId,
        result.exitCode,
        result.artifacts,
        ticketSync
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
  const persistedTaskArtifacts = [CHANGE_CONTRACT_ARTIFACT_KEY, "design-spec"]
    .flatMap((artifactKey) => {
      const filePath = bundle.artifactPaths[artifactKey];
      return filePath ? [{ artifactKey, filePath }] : [];
    });
  const existingHeads = bundle.phases.flatMap((phase) => phase.artifacts);
  return pinExistingTaskArtifactPaths(
    resolveTaskArtifactPaths(compatibleDefinition, bundle.run),
    bundle.project.rootPath,
    persistedTaskArtifacts.length > 0 ? persistedTaskArtifacts : existingHeads,
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
