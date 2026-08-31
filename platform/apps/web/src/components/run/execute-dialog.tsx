import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  LoaderCircle,
  Play,
  RefreshCw,
  TerminalSquare,
} from "lucide-react";

import { EngineeringFlowGuide, TesterFlowGuide } from "@/components/run/phase-flow-guides";
import {
  defaultEffortForModel,
  isOfficialFigmaFileUrl,
  keyForArtifact,
  reasoningEffortLabel,
  safeHttpUrl,
} from "@/components/run/run-page-helpers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/api";
import {
  buildFigmaExecutionOptions,
  isCapabilityConfirmed,
  isFigmaRequested,
  reconcileFigmaPlanSelection,
  setFigmaRequested,
} from "@/lib/design-execution-selection";
import {
  ENGINEERING_ARTIFACT_GUIDES,
  implementationReadinessGuidance,
  type ImplementationStartGuidance,
} from "@/lib/engineering-workflow";
import {
  architecturePartialAllowedOutputKeys,
  architecturePartialOutputKeys,
  architectureSelectionFromReviews,
  defaultFigmaFileName,
  initialPhaseOutputKeys,
  isPhaseOutputLocked,
  isPhaseOutputSelectionComplete,
  isArchitectureImpactRationaleValid,
  isArchitecturePartialOutputSelectionComplete,
  REQUIRED_ARCHITECTURE_BOOTSTRAP_OUTPUT_KEYS,
  type ArchitectureImpactChoice,
} from "@/lib/phase-output-selection";
import {
  defaultRoutedPartialOutputKeys,
  effectiveRequiredInputKeys,
  impactChoiceRequiresBaseline,
  impactOptionsForPhase,
  isImpactAssessmentComplete,
  isFirstPhaseImpactAttempt,
  isProductDirectAllowed,
  phaseImpactTitle,
  shouldSubmitRoutedImpactAssessment,
  type RoutedImpactChoice,
} from "@/lib/phase-impact";
import type {
  ArchitectureBaseline,
  AssessDesignImpactInput,
  AssessProductImpactInput,
  ChangeContract,
  CodexReasoningEffort,
  FigmaTarget,
  PhaseBaseline,
  PhaseDefinition,
  PhaseRun,
  VerificationE2eAction,
} from "@/lib/types";
import { cn, formatDate } from "@/lib/utils";
import { artifactLabel, getPhaseName } from "@/lib/workflow";

const FIGMA_SETUP_URL =
  "https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/#codex";
const DESIGN_OUTPUTS = [
  {
    key: "design-baseline",
    description: "项目级设计规则、组件与视觉基准。",
    required: true,
  },
  {
    key: "design-spec",
    description: "可追溯用户故事的交互与工程交付规格。",
    required: true,
  },
  {
    key: "design-prototype",
    description: "用于验证流程与交互的非生产自包含 HTML 原型。",
    required: false,
  },
  {
    key: "figma-handoff",
    description: "在已授权的 Figma 中创建设计，并记录真实文件与节点证据。",
    required: false,
  },
] as const;

const ARCHITECTURE_IMPACT_OPTIONS: ReadonlyArray<{
  value: ArchitectureImpactChoice;
  title: string;
  description: string;
}> = [
  {
    value: "skip",
    title: "无需架构工作",
    description: "没有边界、集成、数据、安全或 NFR 变化，记录豁免理由后直接进入实现。",
  },
  {
    value: "reuse",
    title: "复用现有架构",
    description: "本次变更不影响架构，沿用已批准基线，不生成新架构产物并完成本阶段。",
  },
  {
    value: "partial",
    title: "局部更新",
    description: "保留既有选型，只更新架构索引和明确受影响的选型后产物。",
  },
  {
    value: "full",
    title: "完整重跑",
    description: "重新生成 Discovery 与 Options，并进入新一轮人工选型。",
  },
];

export function ExecuteDialog({
  runId,
  runTitle,
  phase,
  phases,
  hasChangeContract,
  allowMissingUpstreamInputs = false,
  outputKeysByPhase,
  workType,
  hasEvidenceRefs,
  productBaseline,
  designBaseline,
  architectureBaseline,
  figmaEnabled = true,
  definition,
  initialOutputKeys,
  verificationAction = "standard",
  open,
  onOpenChange,
  onNavigatePhase,
}: {
  runId: string;
  runTitle: string;
  phase: PhaseRun;
  phases: PhaseRun[];
  hasChangeContract: boolean;
  allowMissingUpstreamInputs?: boolean;
  outputKeysByPhase: Partial<Record<string, string[]>>;
  workType?: ChangeContract["workType"];
  hasEvidenceRefs: boolean;
  productBaseline?: PhaseBaseline | null;
  designBaseline?: PhaseBaseline | null;
  architectureBaseline?: ArchitectureBaseline | null;
  /** Cloud MVP does not expose the operator-local Figma MCP bridge. */
  figmaEnabled?: boolean;
  definition: PhaseDefinition;
  initialOutputKeys?: string[];
  verificationAction?: VerificationE2eAction;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigatePhase: (phaseId: "discovery" | "design" | "architecture") => void;
}) {
  const queryClient = useQueryClient();
  const candidates = phase.availableArtifacts ?? [];
  const isDesignPhase = phase.phaseId === "design";
  const isImplementationPhase = phase.phaseId === "implementation";
  const isE2eAuthoring = phase.phaseId === "verification" && verificationAction === "author_e2e";
  const isE2eExecution = phase.phaseId === "verification" && verificationAction === "run_e2e";
  const executableOutputKeys = definition.outputs.filter((key) =>
    key !== "change-contract" && (figmaEnabled || key !== "figma-handoff")
  );
  const effectiveInputKeys = allowMissingUpstreamInputs
    ? []
    : effectiveRequiredInputKeys(
      definition.inputs,
      phases,
      { hasChangeContract, outputKeysByPhase },
    );
  const routedImpactPhaseId = phase.phaseId === "discovery" || phase.phaseId === "design"
    ? phase.phaseId
    : undefined;
  const routedImpactBaseline = routedImpactPhaseId === "discovery"
    ? productBaseline
    : routedImpactPhaseId === "design"
      ? designBaseline
      : undefined;
  const productDirectAllowed = isProductDirectAllowed(
    hasChangeContract,
    workType,
    hasEvidenceRefs,
  );
  const existingOutputKeys = [...new Set(
    phase.artifacts
      .filter((artifact) => !artifact.superseded && artifact.reviewStatus !== "superseded")
      .map((artifact) => keyForArtifact(artifact)),
  )].filter((key) => key !== "change-contract");
  const hasExistingArtifacts = existingOutputKeys.length > 0;
  const canAssessRoutedImpact = Boolean(
    routedImpactPhaseId
    && phase.status === "ready"
    && !phase.resolution
    && isFirstPhaseImpactAttempt(phase),
  );
  const canAssessArchitectureImpact = phase.phaseId === "architecture"
    && phase.status === "ready"
    && !phase.resolution
    && !phase.architectureImpact
    && isFirstPhaseImpactAttempt(phase);
  const hasAssessedPartialImpact = phase.phaseId === "architecture"
    && phase.architectureImpact?.mode === "partial";
  const isFirstAssessedPartialExecution = hasAssessedPartialImpact
    && phase.executions.length === 0;
  const currentArchitectureOptions = phase.artifacts.find(
    (artifact) => !artifact.superseded
      && artifact.reviewStatus !== "superseded"
      && keyForArtifact(artifact) === "architecture-options",
  );
  const currentArchitectureDiscovery = phase.artifacts.find(
    (artifact) => !artifact.superseded
      && artifact.reviewStatus !== "superseded"
      && keyForArtifact(artifact) === "architecture-discovery-context",
  );
  const architectureSelectionRecorded = hasAssessedPartialImpact
    || (
      phase.phaseId === "architecture"
      && phase.status !== "ready"
      && Boolean(currentArchitectureOptions)
      && Boolean(currentArchitectureDiscovery)
      && Boolean(architectureSelectionFromReviews(
        phase.reviews,
        currentArchitectureOptions!.id,
        [currentArchitectureOptions!.id, currentArchitectureDiscovery!.id],
      ))
    );
  const outputOptions = executableOutputKeys.map((key) => {
    const designOutput = DESIGN_OUTPUTS.find((output) => output.key === key);
    const engineeringOutput = ENGINEERING_ARTIFACT_GUIDES.find((output) => output.key === key);
    const describedOutput = designOutput ?? engineeringOutput;
    return {
      key,
      description: engineeringOutput?.purpose
        ?? designOutput?.description
        ?? "此阶段注册的可审核交付产物。",
      downstreamRequired: describedOutput?.required ?? false,
      engineeringGuide: engineeringOutput,
    };
  });
  const [selected, setSelected] = useState<string[]>(() => candidates.map((artifact) => artifact.id));
  const [routedImpactChoice, setRoutedImpactChoice] = useState<RoutedImpactChoice | "">(
    () => canAssessRoutedImpact ? "" : "",
  );
  const [routedImpactRationale, setRoutedImpactRationale] = useState("");
  const [architectureImpactChoice, setArchitectureImpactChoice] = useState<
    ArchitectureImpactChoice | ""
  >(() => canAssessArchitectureImpact ? "" : hasAssessedPartialImpact ? "partial" : "full");
  const [architectureImpactRationale, setArchitectureImpactRationale] = useState("");
  const standardInitialOutputKeys = () => initialPhaseOutputKeys({
      phaseId: phase.phaseId,
      availableOutputKeys: executableOutputKeys,
      hasExistingArtifacts,
      existingOutputKeys,
      initialOutputKeys,
      architectureSelectionRecorded,
    });
  const [selectedOutputs, setSelectedOutputs] = useState<string[]>(() => {
    if (canAssessRoutedImpact) return [];
    if (phase.resolution?.mode === "partial") {
      const affected = phase.resolution.affectedOutputKeys;
      if (phase.executions.length === 0 || !initialOutputKeys?.length) return [...affected];
      const requested = initialOutputKeys.filter((key) => affected.includes(key));
      return requested.length > 0 ? requested : [...affected];
    }
    if (canAssessArchitectureImpact) return [];
    if (hasAssessedPartialImpact) {
      const affectedOutputKeys = phase.architectureImpact?.affectedOutputKeys ?? [];
      return architecturePartialOutputKeys({
        availableOutputKeys: executableOutputKeys,
        affectedOutputKeys,
        initialOutputKeys: initialOutputKeys?.length ? initialOutputKeys : affectedOutputKeys,
        requireAllAffectedOutputs: isFirstAssessedPartialExecution,
      });
    }
    return standardInitialOutputKeys();
  });
  const isImplementationEvidenceRepair = isImplementationPhase
    && selectedOutputs.length > 0
    && selectedOutputs.length < executableOutputKeys.length;
  const isArchitecturePartialMode = hasAssessedPartialImpact
    || (canAssessArchitectureImpact && architectureImpactChoice === "partial");
  const partialAffectedOutputKeys = hasAssessedPartialImpact
    ? phase.architectureImpact?.affectedOutputKeys
    : undefined;
  const partialAllowedOutputKeys = architecturePartialAllowedOutputKeys(
    executableOutputKeys,
    partialAffectedOutputKeys,
  );
  const routedPartialOutputKeys = phase.resolution?.mode === "partial"
    ? phase.resolution.affectedOutputKeys
    : undefined;
  const visibleOutputOptions = isArchitecturePartialMode
    ? outputOptions.filter((output) => partialAllowedOutputKeys.includes(output.key))
    : routedPartialOutputKeys
      ? outputOptions.filter((output) => routedPartialOutputKeys.includes(output.key))
      : outputOptions;
  const runsRoutedFullExecution = Boolean(
    canAssessRoutedImpact
    && routedImpactChoice === "full",
  );
  const submitsRoutedImpactAssessment = Boolean(
    canAssessRoutedImpact
    && routedImpactPhaseId
    && shouldSubmitRoutedImpactAssessment(routedImpactChoice),
  );
  const submitsArchitectureImpactAssessment = canAssessArchitectureImpact
    && (
      architectureImpactChoice === "skip"
      || architectureImpactChoice === "reuse"
      || architectureImpactChoice === "partial"
    );
  const showsImpactAssessmentOnly = submitsRoutedImpactAssessment
    || (canAssessRoutedImpact && !routedImpactChoice)
    || (canAssessArchitectureImpact && architectureImpactChoice !== "full");
  const showsArchitectureImpactOnly = canAssessArchitectureImpact
    && architectureImpactChoice !== "full";
  const figmaOutputSelected = figmaEnabled
    && !submitsRoutedImpactAssessment
    && isFigmaRequested(selectedOutputs);
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<CodexReasoningEffort | "">("");
  const [figmaTargetMode, setFigmaTargetMode] = useState<FigmaTarget["mode"]>(
    "new_private_draft",
  );
  const [figmaPlanKey, setFigmaPlanKey] = useState("");
  const [figmaFileName, setFigmaFileName] = useState(() => defaultFigmaFileName(runTitle));
  const [figmaFileUrl, setFigmaFileUrl] = useState("");
  const [error, setError] = useState<string>();
  const [implementationStartHelp, setImplementationStartHelp] = useState<ImplementationStartGuidance>();
  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: api.getHealth,
    enabled: open,
    staleTime: 10_000,
  });
  const runnerMode = healthQuery.data?.runner.mode;
  const capabilitiesQuery = useQuery({
    queryKey: ["codex", "capabilities", runId],
    queryFn: () => api.getCodexCapabilities(runId),
    enabled: open && runnerMode === "real" && !showsImpactAssessmentOnly,
    staleTime: 10_000,
    retry: 1,
  });
  const figmaQueryKey = ["integration", "figma", runId] as const;
  const figmaQuery = useQuery({
    queryKey: figmaQueryKey,
    queryFn: () => api.getFigmaIntegration(runId),
    enabled: open && figmaEnabled && isDesignPhase && figmaOutputSelected,
    staleTime: 10_000,
    retry: 1,
  });
  const figmaRefreshMutation = useMutation({
    mutationFn: () => api.getFigmaIntegration(runId, { force: true }),
    onSuccess: (status) => queryClient.setQueryData(figmaQueryKey, status),
  });
  const figmaReady = isCapabilityConfirmed({
    dataReady: runnerMode === "real" && figmaQuery.data?.state === "ready",
    isFetching: figmaQuery.isFetching,
    isError: figmaQuery.isError,
    refreshPending: figmaRefreshMutation.isPending,
    refreshError: figmaRefreshMutation.isError,
  });
  const figmaPlansQueryKey = ["integration", "figma", "plans", runId] as const;
  const figmaPlansQuery = useQuery({
    queryKey: figmaPlansQueryKey,
    queryFn: () => api.getFigmaPlans(runId),
    enabled:
      open
      && figmaEnabled
      && isDesignPhase
      && figmaOutputSelected
      && runnerMode === "real"
      && figmaTargetMode === "new_private_draft"
      && figmaReady,
    staleTime: 10_000,
    retry: 1,
  });
  const figmaPlansRefreshMutation = useMutation({
    mutationFn: () => api.getFigmaPlans(runId, { force: true }),
    onSuccess: (plans) => queryClient.setQueryData(figmaPlansQueryKey, plans),
  });
  const isFigmaDetecting = figmaQuery.isFetching || figmaRefreshMutation.isPending;
  const hasFigmaDetectionError = figmaQuery.isError || figmaRefreshMutation.isError;
  const figmaPlans = useMemo(
    () => figmaPlansQuery.data?.plans ?? [],
    [figmaPlansQuery.data?.plans],
  );
  const writableFigmaPlans = useMemo(
    () => figmaPlans.filter((plan) => plan.writable),
    [figmaPlans],
  );
  const figmaPlansConfirmed = isCapabilityConfirmed({
    dataReady: figmaPlansQuery.isSuccess,
    isFetching: figmaPlansQuery.isFetching,
    isError: figmaPlansQuery.isError,
    refreshPending: figmaPlansRefreshMutation.isPending,
    refreshError: figmaPlansRefreshMutation.isError,
  });
  const trimmedFigmaFileName = figmaFileName.trim();
  const trimmedFigmaFileUrl = figmaFileUrl.trim();
  const selectedFigmaPlan = figmaPlans.find((plan) => plan.key === figmaPlanKey);
  const hasWritableFigmaPlan = selectedFigmaPlan?.writable === true;
  const hasValidExistingFigmaUrl = isOfficialFigmaFileUrl(trimmedFigmaFileUrl);
  const figmaTarget: FigmaTarget | undefined =
    figmaTargetMode === "new_private_draft"
      ? hasWritableFigmaPlan && trimmedFigmaFileName
        ? {
            mode: "new_private_draft",
            planKey: figmaPlanKey,
            fileName: trimmedFigmaFileName,
          }
        : undefined
      : hasValidExistingFigmaUrl
        ? { mode: "existing_file", fileUrl: trimmedFigmaFileUrl }
        : undefined;
  const figmaExecutionOptions = buildFigmaExecutionOptions({
    selectedOutputKeys: selectedOutputs,
    figmaIntegrationReady:
      figmaReady
      && (figmaTargetMode === "existing_file" || figmaPlansConfirmed),
    figmaTarget,
  });
  const figmaExecutionReady = figmaOutputSelected && figmaExecutionOptions.valid;
  const isFigmaPlanLoading =
    figmaTargetMode === "new_private_draft"
    && (figmaPlansQuery.isFetching || figmaPlansRefreshMutation.isPending);
  const hasFigmaPlanError =
    figmaTargetMode === "new_private_draft"
    && (figmaPlansQuery.isError || figmaPlansRefreshMutation.isError);
  const figmaAuthorizationUrl = safeHttpUrl(figmaQuery.data?.authorizationUrl) ?? FIGMA_SETUP_URL;
  const capabilities = capabilitiesQuery.data;
  const selectedModel =
    capabilities?.models.some((item) => item.id === model) === true
      ? model
      : capabilities?.defaultModel ?? "";
  const selectedModelCapability = capabilities?.models.find((item) => item.id === selectedModel);
  const defaultReasoningEffort = defaultEffortForModel(capabilities, selectedModel);
  const selectedReasoningEffort =
    reasoningEffort && selectedModelCapability?.reasoningEfforts.includes(reasoningEffort)
      ? reasoningEffort
      : defaultReasoningEffort;
  const usesDefaultCodexConfiguration = Boolean(
    capabilities
      && selectedModel === capabilities.defaultModel
      && selectedReasoningEffort === capabilities.defaultReasoningEffort,
  );
  const hasResolvedCodexConfiguration = Boolean(selectedModel && selectedReasoningEffort);
  const realExecutionReady = runnerMode !== "real"
    || capabilities?.realExecution.state === "ready";
  useEffect(() => {
    setFigmaPlanKey((current) =>
      reconcileFigmaPlanSelection(current, figmaPlans, figmaPlansConfirmed),
    );
  }, [figmaPlans, figmaPlansConfirmed]);
  const mutation = useMutation({
    mutationFn: () => {
      if (submitsRoutedImpactAssessment && routedImpactPhaseId && routedImpactChoice) {
        const needsBaseline = impactChoiceRequiresBaseline(
          routedImpactPhaseId,
          routedImpactChoice,
        );
        if (needsBaseline && !routedImpactBaseline) {
          throw new Error("已批准基线已变化或不可用，请刷新后重新判断");
        }
        const common = {
          rationale: routedImpactRationale.trim(),
          selectedArtifactIds: selected,
          expectedBaselineArtifactIds: needsBaseline
            ? routedImpactBaseline?.artifacts.map((artifact) => artifact.id) ?? []
            : [],
          affectedOutputKeys: routedImpactChoice === "partial" ? selectedOutputs : [],
        };
        if (routedImpactPhaseId === "discovery") {
          return api.assessProductImpact(runId, {
            ...common,
            mode: routedImpactChoice as AssessProductImpactInput["mode"],
          });
        }
        return api.assessDesignImpact(runId, {
          ...common,
          mode: routedImpactChoice as AssessDesignImpactInput["mode"],
        });
      }
      if (submitsArchitectureImpactAssessment) {
        const requiresBaseline = architectureImpactChoice === "reuse"
          || architectureImpactChoice === "partial";
        if (requiresBaseline && !architectureBaseline) {
          throw new Error("架构基线已变化，请刷新后重试");
        }
        return api.assessArchitectureImpact(runId, {
          mode: architectureImpactChoice as "skip" | "reuse" | "partial",
          rationale: architectureImpactRationale.trim(),
          selectedArtifactIds: selected,
          expectedBaselineArtifactIds: requiresBaseline
            ? architectureBaseline?.artifacts.map((artifact) => artifact.id) ?? []
            : [],
          affectedOutputKeys: architectureImpactChoice === "partial" ? selectedOutputs : [],
        });
      }
      const e2eSelection = {
        selectedArtifactIds: selected,
        ...(selectedModel && selectedReasoningEffort
          ? { model: selectedModel, reasoningEffort: selectedReasoningEffort }
          : {}),
      };
      if (isE2eAuthoring) return api.authorVerificationE2e(runId, e2eSelection);
      if (isE2eExecution) return api.executeVerificationE2e(runId, e2eSelection);
      if (!figmaExecutionOptions.valid) {
        throw new Error(
          figmaExecutionOptions.reason === "FIGMA_INTEGRATION_NOT_READY"
            ? "Figma 授权或连接尚未就绪"
            : "请先完整配置 Figma 写入目标",
        );
      }
      return api.executePhase(runId, phase.phaseId, selected, selectedOutputs, {
        ...(selectedModel && selectedReasoningEffort
          ? { model: selectedModel, reasoningEffort: selectedReasoningEffort }
          : {}),
        ...figmaExecutionOptions.options,
      });
    },
    onMutate: () => {
      setError(undefined);
      setImplementationStartHelp(undefined);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["run", runId] }),
        queryClient.invalidateQueries({ queryKey: ["run", runId, "verification", "e2e-flow"] }),
      ]);
      onOpenChange(false);
    },
    onError: async (mutationError) => {
      const readinessHelp = implementationReadinessGuidance(mutationError);
      if (readinessHelp) {
        setError(undefined);
        setImplementationStartHelp(readinessHelp);
        return;
      }
      if (mutationError instanceof ApiError && mutationError.status === 409) {
        await queryClient.invalidateQueries({ queryKey: ["run", runId] });
      }
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : submitsRoutedImpactAssessment
            ? "提交阶段影响评估失败"
            : submitsArchitectureImpactAssessment
              ? "提交架构影响评估失败"
            : "无法启动 Codex",
      );
    },
  });
  const requiredKeys = new Set(effectiveInputKeys);
  const selectedKeys = new Set(
    candidates
      .filter((artifact) => selected.includes(artifact.id))
      .map((artifact) => keyForArtifact(artifact)),
  );
  const missingRequiredInputKeys = effectiveInputKeys.filter((key) => !selectedKeys.has(key));
  const hasAllRequiredInputs = missingRequiredInputKeys.length === 0;
  const hasImpactAssessmentInputs = routedImpactPhaseId === "discovery"
    ? true
    : hasAllRequiredInputs;
  const hasInputsForCurrentAction = canAssessRoutedImpact && !runsRoutedFullExecution
    ? hasImpactAssessmentInputs
    : hasAllRequiredInputs;
  const hasAllRequiredOutputs = canAssessRoutedImpact && !runsRoutedFullExecution
    ? routedImpactChoice !== "partial" || selectedOutputs.length > 0
    : phase.resolution?.mode === "partial"
      ? selectedOutputs.length > 0
        && selectedOutputs.every((key) => phase.resolution?.affectedOutputKeys.includes(key))
        && (
          phase.executions.length > 0
          || phase.resolution.affectedOutputKeys.every((key) => selectedOutputs.includes(key))
        )
    : canAssessArchitectureImpact
      ? architectureImpactChoice === "skip"
      || architectureImpactChoice === "reuse"
      || (
        architectureImpactChoice === "partial"
        && isArchitecturePartialOutputSelectionComplete({
          availableOutputKeys: executableOutputKeys,
          selectedOutputKeys: selectedOutputs,
        })
      )
      || (
        architectureImpactChoice === "full"
        && isPhaseOutputSelectionComplete({
          phaseId: phase.phaseId,
          availableOutputKeys: executableOutputKeys,
          selectedOutputKeys: selectedOutputs,
          hasExistingArtifacts,
          existingOutputKeys,
          architectureSelectionRecorded,
        })
      )
    : isArchitecturePartialMode
      ? isArchitecturePartialOutputSelectionComplete({
        availableOutputKeys: executableOutputKeys,
        selectedOutputKeys: selectedOutputs,
        affectedOutputKeys: partialAffectedOutputKeys,
        requireAllAffectedOutputs: isFirstAssessedPartialExecution,
      })
      : isPhaseOutputSelectionComplete({
        phaseId: phase.phaseId,
        availableOutputKeys: executableOutputKeys,
        selectedOutputKeys: selectedOutputs,
        hasExistingArtifacts,
        existingOutputKeys,
        architectureSelectionRecorded,
      });
  const routedImpactAssessmentReady = !canAssessRoutedImpact
    || runsRoutedFullExecution
    || Boolean(
      routedImpactPhaseId
      && isImpactAssessmentComplete({
        phaseId: routedImpactPhaseId,
        choice: routedImpactChoice,
        rationale: routedImpactRationale,
        baseline: routedImpactBaseline,
        affectedOutputKeys: selectedOutputs,
        hasAllRequiredInputs: hasImpactAssessmentInputs,
      }),
    );
  const hasValidArchitectureImpactRationale = !submitsArchitectureImpactAssessment
    || isArchitectureImpactRationaleValid(architectureImpactRationale);
  const hasUnsupportedFigmaOutput = !showsImpactAssessmentOnly
    && !figmaExecutionOptions.valid;
  const canUseSelectedCodexConfiguration =
    showsImpactAssessmentOnly
    || runnerMode !== "real"
    || (hasResolvedCodexConfiguration && realExecutionReady);

  const selectModel = (nextModel: string) => {
    setModel(nextModel);
    const nextCapability = capabilities?.models.find((item) => item.id === nextModel);
    if (!nextCapability) return;
    setReasoningEffort((current) =>
      current && nextCapability.reasoningEfforts.includes(current)
        ? current
        : defaultEffortForModel(capabilities, nextModel),
    );
  };

  const selectArchitectureImpactChoice = (choice: ArchitectureImpactChoice) => {
    if (mutation.isPending) return;
    if ((choice === "reuse" || choice === "partial") && !architectureBaseline) {
      setError("当前项目还没有可复用的已批准架构基线；请选择跳过或完整重跑。");
      return;
    }
    setArchitectureImpactChoice(choice);
    if (choice === "skip" || choice === "reuse") {
      setSelectedOutputs([]);
    } else if (choice === "partial") {
      setSelectedOutputs(architecturePartialOutputKeys({
        availableOutputKeys: executableOutputKeys,
        initialOutputKeys,
      }));
    } else {
      setSelectedOutputs(standardInitialOutputKeys());
    }
    setError(undefined);
  };

  const selectRoutedImpactChoice = (choice: RoutedImpactChoice) => {
    if (mutation.isPending || !routedImpactPhaseId) return;
    if (
      routedImpactPhaseId === "discovery"
      && choice !== "full"
      && !hasChangeContract
    ) {
      setError("旧 Run 没有 Change Contract，只能选择 Full 运行 PM / BA 补齐产品产物。");
      return;
    }
    if (
      routedImpactPhaseId === "discovery"
      && choice === "direct"
      && !productDirectAllowed
    ) {
      setError("Direct 仅适用于预期行为明确的 Bug 或无行为变化的技术任务；请选择 Partial 或 Full。");
      return;
    }
    if (impactChoiceRequiresBaseline(routedImpactPhaseId, choice) && !routedImpactBaseline) {
      setError("当前项目还没有可复用的已批准基线；请选择直接、跳过或完整执行。");
      return;
    }
    setRoutedImpactChoice(choice);
    setSelectedOutputs(
      choice === "partial"
        ? defaultRoutedPartialOutputKeys(routedImpactPhaseId, executableOutputKeys)
        : choice === "full"
          ? standardInitialOutputKeys()
          : [],
    );
    setError(undefined);
  };

  const toggleOutput = (key: string) => {
    if (mutation.isPending) return;
    if (canAssessRoutedImpact && !runsRoutedFullExecution) {
      if (routedImpactChoice !== "partial") return;
      setSelectedOutputs((current) =>
        current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
      );
      return;
    }
    if (phase.resolution?.mode === "partial") {
      if (
        phase.executions.length === 0
        || !phase.resolution.affectedOutputKeys.includes(key)
      ) return;
      setSelectedOutputs((current) =>
        current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
      );
      return;
    }
    if (isArchitecturePartialMode) {
      if (
        key === "architecture"
        || isFirstAssessedPartialExecution
        || !partialAllowedOutputKeys.includes(key)
      ) return;
      setSelectedOutputs((current) =>
        current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
      );
      return;
    }
    if (isPhaseOutputLocked({
      phaseId: phase.phaseId,
      outputKey: key,
      hasExistingArtifacts,
      architectureSelectionRecorded,
    })) return;
    if (key === "figma-handoff") {
      setSelectedOutputs((current) =>
        setFigmaRequested(current, !isFigmaRequested(current)),
      );
      return;
    }
    setSelectedOutputs((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (mutation.isPending && !nextOpen) return;
        onOpenChange(nextOpen);
      }}
      title={isImplementationEvidenceRepair
        ? "检查并修复工程证据"
        : isE2eAuthoring
          ? "生成独立 E2E 脚本"
          : isE2eExecution
            ? "运行真实 Chromium E2E"
        : phase.phaseId === "implementation"
          ? "检查条件并开始写代码"
          : phase.phaseId === "verification"
            ? "开始 Tester 独立验证"
            : `运行 · ${getPhaseName(definition)}`}
      description={isImplementationEvidenceRepair
        ? "本次只修复审核页选中的工程记录；平台会把机器校验反馈交给 Codex。代码与测试作为事实基线，若事实不成立则停止并报告。"
        : isE2eAuthoring
          ? "从已批准规格冻结测试意图，在独立 E2E workspace 生成或更新 Playwright 脚本。点击运行即为本 Run 启动 linked E2E 流程；随后当前 Verification 必须使用成功的 linked E2E 证据完成，不能改用普通 Tester 报告。本版不提供取消按钮，生成后的整套可执行脚本基线必须先人工审核。"
          : isE2eExecution
            ? "只运行已人工审核且 revision 未变化的脚本，启动真实 Chromium 并保存 report/trace；Vitest、jsdom 或 MCP 结果不能代替本次执行。"
        : phase.phaseId === "implementation"
          ? "选择已批准的上游依据后，Codex 会修改源码、补测试、运行检查；七份证据文档会自动生成。"
          : phase.phaseId === "verification"
            ? "先审核当前工程交接，再按探索、固化回流和独立执行边界完成 Verification；Tester 只写 test-report，不绕过 Software Engineer 修改仓库测试。"
            : "选择 Codex 本次可以使用的上游产物，以及需要交付的阶段输出。"}
      className="h-[calc(100dvh-1rem)] max-h-[52rem] max-w-2xl sm:h-[calc(100dvh-3rem)]"
    >
      <fieldset
        disabled={mutation.isPending}
        aria-busy={mutation.isPending}
        className="m-0 flex min-h-0 min-w-0 flex-1 flex-col border-0 p-0"
      >
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-contain p-6">
          {phase.phaseId === "implementation" ? (
            <div className="mb-5"><EngineeringFlowGuide compact /></div>
          ) : null}
          {phase.phaseId === "verification" ? (
            <div className="mb-5"><TesterFlowGuide compact /></div>
          ) : null}
          {canAssessRoutedImpact && routedImpactPhaseId ? (
            <section
              className="mb-5 rounded-2xl border border-teal-200 bg-teal-50/50 p-4"
              aria-labelledby="routed-impact-check-title"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 id="routed-impact-check-title" className="text-sm font-semibold text-slate-950">
                    {phaseImpactTitle(routedImpactPhaseId)}
                  </h3>
                  <p className="mt-1 text-xs leading-5 text-slate-600">
                    先判断本阶段的处理方式；Direct、Reuse、Partial 会留存处置证据，Full 会直接启动当前角色。
                  </p>
                </div>
                <Badge variant={routedImpactBaseline ? "info" : "muted"}>
                  {routedImpactBaseline ? "存在已批准基线" : "暂无可复用基线"}
                </Badge>
              </div>
              {routedImpactBaseline ? (
                <p className="mt-3 rounded-lg bg-white/80 px-3 py-2 text-[11px] leading-5 text-slate-500 ring-1 ring-teal-100">
                  来源：{routedImpactBaseline.sourceRunTitle} · {routedImpactBaseline.artifacts.length} 项产物 ·
                  批准于 {formatDate(routedImpactBaseline.approvedAt)}
                </p>
              ) : (
                <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800">
                  Reuse 与 Partial 需要已批准基线，当前只能选择
                  {routedImpactPhaseId === "discovery" && productDirectAllowed
                    ? " Direct 或 Full"
                    : routedImpactPhaseId === "discovery"
                      ? " Full"
                      : " Skip 或 Full"}。
                </p>
              )}
              {routedImpactPhaseId === "discovery" && !hasChangeContract ? (
                <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800">
                  这是没有 Change Contract 的旧 Run；Direct、Reuse、Partial 不可用，请用 Full 补齐产品产物。
                </p>
              ) : null}

              <fieldset className="mt-3">
                <legend className="sr-only">选择阶段处置方式</legend>
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                  {impactOptionsForPhase(routedImpactPhaseId).map((option) => {
                    const missingBaseline = option.requiresBaseline && !routedImpactBaseline;
                    const legacyProductChoice = routedImpactPhaseId === "discovery"
                      && !hasChangeContract
                      && option.value !== "full";
                    const directNotAllowed = routedImpactPhaseId === "discovery"
                      && option.value === "direct"
                      && !productDirectAllowed;
                    const disabled = missingBaseline || legacyProductChoice || directNotAllowed;
                    return (
                      <label
                        key={option.value}
                        className={cn(disabled ? "cursor-not-allowed opacity-55" : "cursor-pointer")}
                      >
                        <input
                          type="radio"
                          name={`routed-impact-${phase.id ?? phase.phaseId}`}
                          value={option.value}
                          checked={routedImpactChoice === option.value}
                          disabled={disabled}
                          onChange={() => selectRoutedImpactChoice(option.value)}
                          className="peer sr-only"
                        />
                        <span
                          className={cn(
                            "block h-full rounded-xl border bg-white px-3 py-3 transition peer-focus-visible:ring-2 peer-focus-visible:ring-teal-500 peer-focus-visible:ring-offset-2",
                            routedImpactChoice === option.value
                              ? "border-teal-400 ring-1 ring-teal-200"
                              : "border-slate-200",
                            !disabled && "hover:border-slate-300",
                          )}
                        >
                          <span className="block text-xs font-semibold text-slate-900">{option.title}</span>
                          <span className="mt-1 block text-[11px] leading-4 text-slate-500">
                            {option.description}
                          </span>
                          {directNotAllowed && hasChangeContract ? (
                            <span className="mt-1 block text-[10px] font-semibold text-amber-700">
                              {!hasEvidenceRefs
                                ? "Change Contract 缺少证据引用；请选择 Full 或新建 Run 补充"
                                : "新功能 / 局部变更请选择 Partial 或 Full"}
                            </span>
                          ) : null}
                          {legacyProductChoice ? (
                            <span className="mt-1 block text-[10px] font-semibold text-amber-700">
                              旧 Run 缺少 Change Contract
                            </span>
                          ) : null}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>

              {routedImpactChoice && routedImpactChoice !== "full" ? (
                <label className="mt-4 block">
                  <span className="text-xs font-semibold text-slate-700">处置理由</span>
                  <Textarea
                    value={routedImpactRationale}
                    maxLength={2_000}
                    onChange={(event) => setRoutedImpactRationale(event.target.value)}
                    placeholder={routedImpactChoice === "partial"
                      ? "说明哪些输出受影响，以及为什么其他输出仍可继承…"
                      : "说明 Change Contract、现有基线和代码事实如何支持这个判断…"}
                    aria-invalid={Boolean(
                      routedImpactRationale
                      && routedImpactRationale.trim().length < 10
                    )}
                    className="mt-1.5 min-h-24 bg-white"
                  />
                  <span className="mt-1.5 block text-[11px] leading-4 text-slate-500">
                    至少 10 个字符；来源基线、选定输入、理由和受影响输出会一起留痕。
                  </span>
                </label>
              ) : routedImpactChoice === "full" ? (
                <p className="mt-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs leading-5 text-sky-800">
                  将在当前窗口直接选择输入与输出并启动 Codex；完整执行本身作为 execution 审计证据，
                  不另建 PhaseResolution，也不采集不会持久化的处置理由。
                </p>
              ) : (
                <p className="mt-3 text-xs leading-5 text-teal-800">请选择一种处置方式后继续。</p>
              )}
            </section>
          ) : null}

          {canAssessArchitectureImpact ? (
            <section
              className="mb-5 rounded-2xl border border-teal-200 bg-teal-50/50 p-4"
              aria-labelledby="architecture-impact-check-title"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 id="architecture-impact-check-title" className="text-sm font-semibold text-slate-950">
                    Architecture Impact Check
                  </h3>
                  <p className="mt-1 text-xs leading-5 text-slate-600">
                    先判断本次需求对已批准架构的影响，再决定是否运行架构师。
                  </p>
                </div>
                <Badge variant={architectureBaseline ? "info" : "muted"}>
                  {architectureBaseline
                    ? `基线 Option ${architectureBaseline.selection.optionId}`
                    : "暂无可复用架构基线"}
                </Badge>
              </div>
              {architectureBaseline ? (
                <p className="mt-3 rounded-lg bg-white/80 px-3 py-2 text-[11px] leading-5 text-slate-500 ring-1 ring-teal-100">
                  来源：{architectureBaseline.sourceRunTitle} · 批准于 {formatDate(architectureBaseline.approvedAt)}
                </p>
              ) : (
                <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800">
                  Reuse 与 Partial 需要已批准架构基线；当前仍可选择无需架构工作或完整重跑。
                </p>
              )}

              <fieldset className="mt-3">
                <legend className="sr-only">选择架构影响范围</legend>
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                  {ARCHITECTURE_IMPACT_OPTIONS.map((option) => {
                    const disabled = (
                      (option.value === "reuse" || option.value === "partial")
                      && !architectureBaseline
                    );
                    return (
                    <label
                      key={option.value}
                      className={cn(disabled ? "cursor-not-allowed opacity-55" : "cursor-pointer")}
                    >
                      <input
                        type="radio"
                        name={`architecture-impact-${phase.id ?? phase.phaseId}`}
                        value={option.value}
                        checked={architectureImpactChoice === option.value}
                        disabled={disabled}
                        onChange={() => selectArchitectureImpactChoice(option.value)}
                        className="peer sr-only"
                      />
                      <span
                        className={cn(
                          "block h-full rounded-xl border bg-white px-3 py-3 transition peer-focus-visible:ring-2 peer-focus-visible:ring-teal-500 peer-focus-visible:ring-offset-2",
                          architectureImpactChoice === option.value
                            ? "border-teal-400 ring-1 ring-teal-200"
                            : "border-slate-200 hover:border-slate-300",
                        )}
                      >
                        <span className="block text-xs font-semibold text-slate-900">{option.title}</span>
                          <span className="mt-1 block text-[11px] leading-4 text-slate-500">
                            {option.description}
                          </span>
                      </span>
                    </label>
                    );
                  })}
                </div>
              </fieldset>

              {architectureImpactChoice === "skip"
                || architectureImpactChoice === "reuse"
                || architectureImpactChoice === "partial" ? (
                <label className="mt-4 block">
                  <span className="text-xs font-semibold text-slate-700">判断依据</span>
                  <Textarea
                    value={architectureImpactRationale}
                    maxLength={2_000}
                    onChange={(event) => setArchitectureImpactRationale(event.target.value)}
                    placeholder={architectureImpactChoice === "skip"
                      ? "说明为什么该工作不影响系统边界、集成、数据、安全或 NFR…"
                      : architectureImpactChoice === "reuse"
                        ? "说明为什么本次需求不会改变边界、选型、NFR 或架构规则…"
                        : "说明受影响的架构范围，以及为什么无需重新选型…"}
                    aria-invalid={Boolean(
                      architectureImpactRationale
                      && !isArchitectureImpactRationaleValid(architectureImpactRationale)
                    )}
                    className="mt-1.5 min-h-24 bg-white"
                  />
                  <span className="mt-1.5 block text-[11px] leading-4 text-slate-500">
                    至少 10 个字符；该判断会随架构基线和上游产物一起留痕。
                  </span>
                </label>
              ) : architectureImpactChoice === "full" ? (
                <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                  完整重跑分两步：本次先刷新 Architecture、Discovery 与 Options，随后人工选型并生成完整架构包。
                </p>
              ) : (
                <p className="mt-3 text-xs leading-5 text-teal-800">请选择一种影响范围后继续。</p>
              )}
            </section>
          ) : hasAssessedPartialImpact && phase.architectureImpact ? (
            <section className="mb-5 rounded-xl border border-teal-200 bg-teal-50/50 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-semibold text-teal-950">已确认局部架构更新</div>
                <Badge variant="info">沿用 Option {phase.architectureImpact.selection.optionId}</Badge>
              </div>
              <p className="mt-1 text-xs leading-5 text-teal-800">
                本次 Codex 只能更新已评估范围：
                {partialAllowedOutputKeys.map(artifactLabel).join("、")}。
              </p>
            </section>
          ) : null}

          <div className="rounded-xl border border-slate-200 bg-slate-950 p-4 text-slate-100">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs font-semibold">
                <TerminalSquare className="h-4 w-4 text-teal-300" aria-hidden />
                {showsImpactAssessmentOnly
                  ? routedImpactPhaseId && canAssessRoutedImpact
                    ? phaseImpactTitle(routedImpactPhaseId)
                    : "Architecture Impact"
                  : "Codex Terminal"}
              </div>
              <Badge variant={showsImpactAssessmentOnly ? "info" : runnerMode === "fake" ? "warning" : runnerMode === "real" ? "success" : "muted"}>
                {showsImpactAssessmentOnly
                  ? routedImpactChoice || architectureImpactChoice ? "仅记录路由判断" : "等待选择"
                  : runnerMode === "fake" ? "模拟执行" : runnerMode === "real" ? "真实执行" : "检测中"}
              </Badge>
            </div>
            <p className="mt-2 text-xs leading-5 text-slate-400">
              {canAssessRoutedImpact && routedImpactPhaseId
                ? routedImpactChoice === "direct"
                  ? "平台会采用已确认的 Change Contract，不运行 PM / BA；本次路由判断仍会留痕。"
                  : routedImpactChoice === "skip"
                    ? "平台会记录无需设计工作的理由并完成本阶段，不启动 Designer。"
                    : routedImpactChoice === "reuse"
                      ? "平台会继承已批准基线并完成本阶段，本次不启动 Codex。"
                      : routedImpactChoice === "partial"
                        ? "平台会先记录局部影响范围；确认后再单独启动 Codex 更新这些输出。"
                        : routedImpactChoice === "full"
                          ? "平台会在本窗口直接启动当前角色，生成选定的完整阶段产物。"
                          : "请选择处置方式；选择前不会启动 Codex。"
                : showsArchitectureImpactOnly
                  ? architectureImpactChoice === "skip"
                    ? "平台会记录架构豁免理由并完成本阶段，本次生成 0 项架构产物。"
                    : architectureImpactChoice === "reuse"
                  ? "平台会复用已批准架构基线并完成本阶段，本次生成 0 项架构产物。"
                  : architectureImpactChoice === "partial"
                    ? "平台会继承已批准架构基线并记录局部更新范围；确认后再运行 Codex。"
                    : "请选择复用、局部更新或完整重跑；选择前不会启动 Codex。"
                : runnerMode === "fake"
                ? "当前服务处于 Fake 模式，只会生成模拟产物，不会调用 Codex。"
                : runnerMode === "real"
                  ? "Codex CLI 会在项目根目录真实执行当前角色任务。平台负责阶段边界、输入选择与审核。"
                  : healthQuery.isError
                    ? "无法确认服务运行模式，请检查本地 API 后重试。"
                  : "正在确认本地 API 的 Codex 运行模式…"}
            </p>
          </div>

        {!showsImpactAssessmentOnly ? (
        <section className="mt-5" aria-labelledby="codex-execution-settings-title">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 id="codex-execution-settings-title" className="text-sm font-semibold text-slate-900">
                本次 Codex 配置
              </h3>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                默认选中当前 Run 的有效配置；你可以只为这一次执行调整它。
              </p>
            </div>
            <Badge variant={usesDefaultCodexConfiguration ? "muted" : capabilities ? "info" : "muted"}>
              {runnerMode === "fake"
                ? "模拟模式不适用"
                : !capabilities
                  ? "读取中"
                  : usesDefaultCodexConfiguration
                    ? "当前默认"
                    : "本次自定义"}
            </Badge>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block min-w-0">
              <span className="text-xs font-semibold text-slate-700">模型</span>
              <select
                value={selectedModel}
                disabled={runnerMode !== "real" || !capabilities}
                onChange={(event) => selectModel(event.target.value)}
                aria-describedby="codex-model-help"
                className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 outline-none transition focus:border-teal-400 focus:ring-2 focus:ring-teal-100 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400"
              >
                {!capabilities ? <option value="">等待读取可用模型</option> : null}
                {(capabilities?.models ?? []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name === item.id ? item.id : `${item.name}（${item.id}）`}
                  </option>
                ))}
              </select>
              <span id="codex-model-help" className="mt-1.5 block text-[11px] leading-4 text-slate-400">
                {capabilities ? `当前 Run 默认：${capabilities.defaultModel}` : "由服务端读取 Codex 可用模型"}
              </span>
            </label>

            <label className="block min-w-0">
              <span className="text-xs font-semibold text-slate-700">Reasoning effort</span>
              <select
                value={selectedReasoningEffort}
                disabled={runnerMode !== "real" || !selectedModelCapability}
                onChange={(event) =>
                  setReasoningEffort(event.target.value as CodexReasoningEffort)
                }
                aria-describedby="codex-reasoning-help"
                className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 outline-none transition focus:border-teal-400 focus:ring-2 focus:ring-teal-100 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400"
              >
                {!selectedModelCapability ? <option value="">等待读取推理强度</option> : null}
                {(selectedModelCapability?.reasoningEfforts ?? []).map((item) => (
                  <option key={item} value={item}>
                    {reasoningEffortLabel(item)}
                  </option>
                ))}
              </select>
              <span id="codex-reasoning-help" className="mt-1.5 block text-[11px] leading-4 text-slate-400">
                {selectedModelCapability
                  ? `该模型默认：${reasoningEffortLabel(selectedModelCapability.defaultReasoningEffort)}`
                  : "切换模型时会自动校正为它支持的强度"}
              </span>
            </label>
          </div>

          <div
            className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-3 text-xs leading-5 text-slate-600"
            aria-live="polite"
          >
            {runnerMode === "fake" ? (
              "模拟执行不会调用模型，因此本次不能覆盖模型或推理强度。"
            ) : runnerMode !== "real" ? (
              "正在确认 Runner 与 Codex 配置…"
            ) : capabilitiesQuery.isLoading ? (
              <span className="inline-flex items-center gap-2">
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />
                正在读取可用模型与默认配置…
              </span>
            ) : capabilitiesQuery.isError ? (
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span>暂时无法读取当前 Run 的模型能力，真实 Codex 执行已暂停。</span>
                <button
                  type="button"
                  disabled={capabilitiesQuery.isFetching}
                  onClick={() => void capabilitiesQuery.refetch()}
                  className="inline-flex items-center gap-1 font-semibold text-teal-700 hover:text-teal-800 disabled:opacity-50"
                >
                  <RefreshCw
                    className={cn("h-3.5 w-3.5", capabilitiesQuery.isFetching && "animate-spin")}
                    aria-hidden
                  />
                  重新读取
                </button>
              </span>
            ) : (
              <>
                本次将使用模型
                <strong className="mx-1 font-mono text-slate-800">
                  {selectedModel}
                </strong>
                ，推理强度
                <strong className="mx-1 text-slate-800">
                  {selectedReasoningEffort
                    ? reasoningEffortLabel(selectedReasoningEffort)
                    : "等待解析"}
                </strong>
                。执行时会显式传入并记录这组实际配置。
              </>
            )}
          </div>
          {runnerMode === "real"
            && capabilities
            && capabilities.realExecution.state !== "ready" ? (
            <div
              role="alert"
              className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-xs leading-5 text-amber-900"
            >
              <strong className="block">真实执行还没有获准</strong>
              <span>{capabilities.realExecution.message}</span>
            </div>
          ) : null}
        </section>
        ) : null}

        <div className="mt-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">
              {isImplementationPhase ? "实施依据（平台自动选择）" : "上游审核产物"}
            </h3>
            {candidates.length && !isImplementationPhase ? (
              <button
                type="button"
                className="text-xs font-medium text-teal-700 hover:text-teal-800"
                onClick={() =>
                  setSelected((current) =>
                    current.length === candidates.length ? [] : candidates.map((artifact) => artifact.id),
                  )
                }
              >
                {selected.length === candidates.length ? "取消全选" : "全选"}
              </button>
            ) : null}
          </div>
          {isImplementationPhase ? (
            <p className="mb-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs leading-5 text-sky-800">
              这里没有需要你决定的选项。平台会自动采用当前 Run 已批准的 Product、Design 和 Architecture 输入；启动前还会检查文档内部是否仍写着 Blocked。
            </p>
          ) : null}
          {candidates.length ? (
            <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
              {candidates.map((artifact) => {
                const key = keyForArtifact(artifact);
                const checked = selected.includes(artifact.id);
                const required = requiredKeys.has(key);
                return (
                  <div
                    key={artifact.id}
                    onClick={isImplementationPhase ? undefined : () => {
                      if (mutation.isPending) return;
                      setSelected((current) =>
                        current.includes(artifact.id)
                          ? current.filter((id) => id !== artifact.id)
                          : [...current, artifact.id],
                      );
                    }}
                    className={cn(
                      "flex w-full items-start gap-3 rounded-xl border p-3.5 text-left transition",
                      checked ? "border-teal-200 bg-teal-50/60" : "border-slate-200 bg-white hover:bg-slate-50",
                      (mutation.isPending || isImplementationPhase) && "cursor-default",
                    )}
                  >
                    {isImplementationPhase ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-teal-600" aria-hidden />
                    ) : (
                      <Checkbox
                        checked={checked}
                        disabled={mutation.isPending}
                        onCheckedChange={() => {
                          if (mutation.isPending) return;
                          setSelected((current) =>
                            current.includes(artifact.id)
                              ? current.filter((id) => id !== artifact.id)
                              : [...current, artifact.id],
                          );
                        }}
                        aria-label={`选择 ${artifactLabel(key)}`}
                      />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                        {artifactLabel(key)}
                        {required ? <Badge variant="info">自动采用</Badge> : null}
                      </span>
                      <span className="mt-1 block truncate font-mono text-[10px] text-slate-400">
                        {artifact.filePath || artifact.path || key}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-7 text-center text-xs leading-5 text-slate-500">
              {allowMissingUpstreamInputs
                ? "Flexible Run 直接从本阶段开始；可选上下文会被采用，但不要求补齐前序阶段产物。"
                : effectiveInputKeys.length
                ? "暂时没有可用的上游产物。只有审核通过的产物才会出现在这里。"
                : "这是第一个阶段，不需要选择上游产物。"}
            </div>
          )}
          {missingRequiredInputKeys.length > 0 ? (
            <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
              还需选择有效阶段输入：{missingRequiredInputKeys.map(artifactLabel).join("、")}。
            </p>
          ) : null}
        </div>

        <div className="mt-6 border-t border-slate-100 pt-5">
          <div className="mb-3">
            <h3 className="text-sm font-semibold text-slate-900">
              {isImplementationPhase ? "工程证据包（平台自动生成）" : "本次预期输出"}
            </h3>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              {isImplementationPhase
                ? selectedOutputs.length === executableOutputKeys.length
                  ? "正常实施会自动生成完整证据包。它们记录同一次代码变更，不是七个需要你选择或手工填写的任务。"
                  : `这是从审核页发起的证据修复，本次只更新已选的 ${selectedOutputs.length} 份记录；只有实现事实未变化时才使用。`
              : canAssessRoutedImpact && !routedImpactChoice
                ? "先选择阶段处置方式；Partial 声明受影响输出，Full 直接选择本次 Codex 交付。"
                : canAssessRoutedImpact && routedImpactChoice === "partial"
                  ? routedImpactPhaseId === "design"
                    ? figmaEnabled
                      ? "Design Partial 必须包含设计规格；可按实际影响追加基线、HTML 原型或 Figma，未选产物保持只读。"
                      : "Design Partial 必须包含设计规格；可按实际影响追加基线或 HTML 原型，未选产物保持只读。"
                    : "勾选本次允许 Codex 更新的精确 PRD / Stories 输出；未选择的基线产物保持只读。"
                  : runsRoutedFullExecution
                    ? "选择本次完整执行要生成的产物；Change Contract 是不可变上下文，不会成为可写输出。"
                  : canAssessRoutedImpact
                    ? "本次只记录处置判断，不在这个步骤生成阶段产物。"
                : canAssessArchitectureImpact && !architectureImpactChoice
                ? "请选择复用、局部更新或完整重跑；平台不会替你推断影响范围。"
                : canAssessArchitectureImpact
                  && (architectureImpactChoice === "skip" || architectureImpactChoice === "reuse")
                  ? architectureImpactChoice === "skip"
                    ? "架构豁免不会生成产物；理由和当前输入会作为可审核处置证据。"
                    : "复用不会生成新架构产物；平台将完整继承已批准基线并完成架构阶段。"
                  : isArchitecturePartialMode
                    ? "只允许更新影响评估范围内的选型后产物；Architecture 索引必须同步刷新。"
              : phase.phaseId === "architecture" && !architectureSelectionRecorded
                ? REQUIRED_ARCHITECTURE_BOOTSTRAP_OUTPUT_KEYS.every((key) =>
                    existingOutputKeys.includes(key)
                  )
                  ? "当前停在人工选型检查点；只能重跑索引、发现上下文或 options，选型后产物暂时锁定。"
                  : "先补齐架构索引、发现上下文和 options；选型后产物将在人工记录有效 Option 后解锁。"
                : phase.phaseId === "architecture"
                  ? "已记录有效选型；默认刷新架构索引和全部选型后产物，已有完整包也可局部重跑。"
                : hasExistingArtifacts
                ? "已有阶段产物，可只选择需要调整的局部范围；未选择的产物会保持不变。"
                : isDesignPhase
                  ? figmaEnabled
                    ? "首次设计执行必须包含设计基线和设计规格，HTML 原型与 Figma 可按需追加。"
                    : "首次设计执行必须包含设计基线和设计规格，HTML 原型可按需追加。"
                  : "首次执行需要生成本阶段的全部注册产物。"}
            </p>
          </div>
          {isImplementationPhase ? (
            <div className="rounded-xl border border-teal-200 bg-teal-50/50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-semibold text-slate-900">
                  {selectedOutputs.length === executableOutputKeys.length
                    ? "1 个工程结果包"
                    : `仅更新：${selectedOutputs.map(artifactLabel).join("、")}`}
                </div>
                <Badge variant="info">自动更新 {selectedOutputs.length} 份记录</Badge>
              </div>
              {selectedOutputs.length === executableOutputKeys.length ? (
                <div className="mt-3 grid gap-2 sm:grid-cols-3">
                  {(["开工准备", "实现记录", "质量与交付"] as const).map((stage) => (
                    <div key={stage} className="rounded-lg bg-white px-3 py-2.5 ring-1 ring-teal-100">
                      <div className="text-xs font-semibold text-slate-800">{stage}</div>
                      <p className="mt-1 text-[11px] leading-4 text-slate-500">
                        {ENGINEERING_ARTIFACT_GUIDES
                          .filter((guide) => guide.stage === stage && selectedOutputs.includes(guide.key))
                          .map((guide) => artifactLabel(guide.key))
                          .join("、")}
                      </p>
                    </div>
                  ))}
                </div>
              ) : null}
              <p className="mt-3 text-xs leading-5 text-teal-900">
                {selectedOutputs.length === executableOutputKeys.length
                  ? "你不需要在这里选 Markdown。启动成功表示前置条件已通过；随后 Codex 才会开始改源码、补测试和写这些记录。"
                  : "你不需要手写 Markdown。本次目标是按机器反馈修复已选记录，并以现有代码、测试和命令结果为事实基线；若事实本身不成立，Codex 必须停下并如实报告，不能只改文字冒充通过。"}
              </p>
            </div>
          ) : (canAssessRoutedImpact
              && routedImpactChoice !== "partial"
              && routedImpactChoice !== "full")
            || (canAssessArchitectureImpact
              && (
                architectureImpactChoice === ""
                || architectureImpactChoice === "skip"
                || architectureImpactChoice === "reuse"
              )) ? (
            <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-xs leading-5 text-slate-500">
              {canAssessRoutedImpact
                ? routedImpactChoice
                  ? "本步骤生成 0 项产物；确认处置后，平台会完成或准备本阶段。"
                  : "选择处置方式后，这里会显示需要更新的产物范围。"
                : architectureImpactChoice === "skip"
                  ? "本次生成 0 项产物；确认后记录架构豁免并完成本阶段。"
                  : architectureImpactChoice === "reuse"
                  ? "本次生成 0 项产物；确认后复用基线中的完整架构包。"
                  : "选择影响范围后，这里会显示需要生成或更新的产物。"}
            </div>
          ) : (
          <div className="grid gap-2 sm:grid-cols-2">
              {visibleOutputOptions.map((output) => {
                const checked = selectedOutputs.includes(output.key);
                const isFigma = output.key === "figma-handoff";
                const locked = canAssessRoutedImpact && !runsRoutedFullExecution
                  ? routedImpactChoice !== "partial"
                  : phase.resolution?.mode === "partial"
                    ? phase.executions.length === 0
                  : isArchitecturePartialMode
                  ? output.key === "architecture" || isFirstAssessedPartialExecution
                  : isPhaseOutputLocked({
                    phaseId: phase.phaseId,
                    outputKey: output.key,
                    hasExistingArtifacts,
                    architectureSelectionRecorded,
                  });
                const disabled = locked || mutation.isPending;
                return (
                  <div
                    key={output.key}
                    onClick={() => !disabled && toggleOutput(output.key)}
                    className={cn(
                      "flex items-start gap-3 rounded-xl border p-3.5 text-left transition",
                      checked ? "border-teal-200 bg-teal-50/60" : "border-slate-200 bg-white",
                      disabled ? "cursor-default" : "cursor-pointer hover:bg-slate-50",
                    )}
                  >
                    <Checkbox
                      checked={checked}
                      disabled={disabled}
                      onCheckedChange={() => toggleOutput(output.key)}
                      aria-label={locked
                        ? `${artifactLabel(output.key)}（必选，已锁定）`
                        : `${checked ? "取消" : "选择"} ${artifactLabel(output.key)}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-800">
                        {artifactLabel(output.key)}
                        {output.downstreamRequired ? <Badge variant="info">后续阶段必需</Badge> : null}
                        {locked && !output.downstreamRequired ? (
                          <Badge variant="muted">
                            {isArchitecturePartialMode
                              ? isFirstAssessedPartialExecution
                                ? "首次局部更新必需"
                                : "局部更新必需"
                              : "首次执行必需"}
                          </Badge>
                        ) : null}
                        {isFigma && figmaOutputSelected && figmaReady ? (
                          <Badge variant="success">连接已授权</Badge>
                        ) : null}
                        {isFigma && figmaOutputSelected && figmaExecutionReady ? (
                          <Badge variant="info">写入目标已就绪</Badge>
                        ) : null}
                        {isFigma && figmaOutputSelected && figmaReady && !figmaExecutionReady ? (
                          <Badge variant="warning">待选择写入目标</Badge>
                        ) : null}
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-slate-500">
                        {output.description}
                      </span>
                      {output.engineeringGuide ? (
                        <span className="mt-2 block rounded-md bg-white/80 px-2.5 py-2 text-[11px] leading-4 text-slate-600 ring-1 ring-slate-200/70">
                          <strong>{output.engineeringGuide.stage} · {output.engineeringGuide.timing}</strong>
                          <br />你检查：{output.engineeringGuide.humanCheck}
                        </span>
                      ) : null}
                    </span>
                  </div>
                );
              })}
          </div>
          )}

            {isDesignPhase && figmaOutputSelected ? (
              figmaReady ? (
                <div
                  className="mt-3 rounded-xl border border-teal-200 bg-teal-50/50 px-4 py-4"
                  aria-labelledby="figma-target-title"
                >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h4 id="figma-target-title" className="text-xs font-semibold text-slate-900">
                      Figma 写入目标
                    </h4>
                    <p className="mt-1 text-xs leading-5 text-slate-600">
                      已选择交付 Figma 设计。请指定真实写入目标；目标完整前不会启动执行。
                    </p>
                  </div>
                  <Badge variant={figmaExecutionReady ? "success" : "warning"}>
                    {figmaExecutionReady ? "目标完整" : "需要配置"}
                  </Badge>
                </div>

                <fieldset className="mt-3">
                  <legend className="sr-only">选择 Figma 写入方式</legend>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="cursor-pointer">
                      <input
                        type="radio"
                        name={`figma-target-${phase.phaseId}`}
                        value="new_private_draft"
                        checked={figmaTargetMode === "new_private_draft"}
                        onChange={() => setFigmaTargetMode("new_private_draft")}
                        className="peer sr-only"
                      />
                      <span
                        className={cn(
                          "block rounded-xl border bg-white px-3.5 py-3 transition peer-focus-visible:ring-2 peer-focus-visible:ring-teal-500 peer-focus-visible:ring-offset-2",
                          figmaTargetMode === "new_private_draft"
                            ? "border-teal-400 ring-1 ring-teal-200"
                            : "border-slate-200 hover:border-slate-300",
                        )}
                      >
                        <span className="block text-xs font-semibold text-slate-900">
                          新建私人 Draft
                        </span>
                        <span className="mt-1 block text-[11px] leading-4 text-slate-500">
                          在所选账号计划下创建新的私人草稿
                        </span>
                      </span>
                    </label>
                    <label className="cursor-pointer">
                      <input
                        type="radio"
                        name={`figma-target-${phase.phaseId}`}
                        value="existing_file"
                        checked={figmaTargetMode === "existing_file"}
                        onChange={() => setFigmaTargetMode("existing_file")}
                        className="peer sr-only"
                      />
                      <span
                        className={cn(
                          "block rounded-xl border bg-white px-3.5 py-3 transition peer-focus-visible:ring-2 peer-focus-visible:ring-teal-500 peer-focus-visible:ring-offset-2",
                          figmaTargetMode === "existing_file"
                            ? "border-teal-400 ring-1 ring-teal-200"
                            : "border-slate-200 hover:border-slate-300",
                        )}
                      >
                        <span className="block text-xs font-semibold text-slate-900">
                          更新已有文件
                        </span>
                        <span className="mt-1 block text-[11px] leading-4 text-slate-500">
                          使用你有编辑权限的官方 Figma 文件 URL
                        </span>
                      </span>
                    </label>
                  </div>
                </fieldset>

                {figmaTargetMode === "new_private_draft" ? (
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <label className="block min-w-0">
                      <span className="text-xs font-semibold text-slate-700">账号计划</span>
                      <select
                        value={figmaPlanKey}
                        disabled={
                          figmaPlansQuery.isFetching
                          || figmaPlansRefreshMutation.isPending
                          || figmaPlans.length === 0
                        }
                        required
                        aria-required="true"
                        onChange={(event) => setFigmaPlanKey(event.target.value)}
                        aria-describedby="figma-plan-help"
                        className="mt-1.5 h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 outline-none transition focus:border-teal-500 focus:ring-4 focus:ring-teal-500/10 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400"
                      >
                        <option value="">
                          {isFigmaPlanLoading ? "正在读取账号计划…" : "请选择可写计划"}
                        </option>
                        {figmaPlans.map((plan) => (
                          <option key={plan.key} value={plan.key} disabled={!plan.writable}>
                            {plan.name} · {plan.tier} · {plan.seat}
                            {plan.writable ? "" : "（只读）"}
                          </option>
                        ))}
                      </select>
                      <span id="figma-plan-help" className="mt-1.5 block text-[11px] leading-4 text-slate-500">
                        {writableFigmaPlans.length > 1 && !figmaPlanKey
                          ? `检测到 ${writableFigmaPlans.length} 个可写计划，请明确选择；平台不会替你猜。`
                          : selectedFigmaPlan
                            ? `${selectedFigmaPlan.name} · ${selectedFigmaPlan.tier} · ${selectedFigmaPlan.seat}`
                            : "View 等只读席位会显示但不能选择。"}
                      </span>
                    </label>

                    <label className="block min-w-0">
                      <span className="text-xs font-semibold text-slate-700">新文件名称</span>
                      <Input
                        value={figmaFileName}
                        maxLength={160}
                        required
                        aria-required="true"
                        autoComplete="off"
                        onChange={(event) => setFigmaFileName(event.target.value)}
                        aria-describedby="figma-file-name-help"
                        aria-invalid={!trimmedFigmaFileName}
                        className="mt-1.5"
                      />
                      <span id="figma-file-name-help" className="mt-1.5 block text-[11px] leading-4 text-slate-500">
                        文件会创建到私人 Draft，不会自动加入团队项目。
                      </span>
                    </label>
                </div>
              ) : (
                  <label className="mt-4 block">
                    <span className="text-xs font-semibold text-slate-700">Figma 文件 URL</span>
                    <Input
                      type="url"
                      inputMode="url"
                      value={figmaFileUrl}
                      maxLength={2_048}
                      required
                      aria-required="true"
                      placeholder="https://www.figma.com/design/FILE_KEY/文件名"
                      autoComplete="off"
                      onChange={(event) => setFigmaFileUrl(event.target.value)}
                      aria-describedby="figma-file-url-help"
                      aria-invalid={Boolean(trimmedFigmaFileUrl && !hasValidExistingFigmaUrl)}
                      className="mt-1.5 font-mono text-xs"
                    />
                    <span
                      id="figma-file-url-help"
                      className={cn(
                        "mt-1.5 block text-[11px] leading-4",
                        trimmedFigmaFileUrl && !hasValidExistingFigmaUrl
                          ? "text-rose-600"
                          : "text-slate-500",
                      )}
                    >
                      {trimmedFigmaFileUrl && !hasValidExistingFigmaUrl
                        ? "请输入官方 https://figma.com/design/... 或 /file/... 文件地址。"
                        : "Codex 只会更新这个文件；仍会在执行后校验真实写入证据。"}
                    </span>
                  </label>
                )}

                <div
                  className={cn(
                    "mt-3 rounded-lg border px-3 py-2.5 text-xs leading-5",
                    figmaExecutionReady
                      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                      : hasFigmaPlanError
                        ? "border-rose-200 bg-rose-50 text-rose-700"
                        : "border-amber-200 bg-amber-50 text-amber-800",
                  )}
                  aria-live="polite"
                >
                  {isFigmaPlanLoading ? (
                    <span className="inline-flex items-center gap-2">
                      <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />
                      正在读取 Figma 账号和计划…
                    </span>
                  ) : hasFigmaPlanError ? (
                    "未能读取 Figma 账号计划；在验证成功前不会启动 Figma 写入。"
                  ) : !writableFigmaPlans.length && figmaTargetMode === "new_private_draft" ? (
                    "当前账号没有可写计划。可以切换到“更新已有文件”，或检查 Figma 席位权限。"
                  ) : figmaExecutionReady ? (
                    <span className="inline-flex items-center gap-2 font-semibold">
                      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                      真实写入目标已就绪，本次会交付 Figma 设计。
                    </span>
                  ) : figmaTargetMode === "new_private_draft" ? (
                    "请选择可写计划并填写文件名。"
                  ) : (
                    "请粘贴有效的官方 Figma 文件 URL。"
                  )}
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                  {figmaTargetMode === "new_private_draft" ? (
                    <button
                      type="button"
                      disabled={figmaPlansQuery.isFetching || figmaPlansRefreshMutation.isPending}
                      onClick={() => figmaPlansRefreshMutation.mutate()}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-teal-800 hover:text-teal-600 disabled:opacity-50"
                    >
                      <RefreshCw
                        className={cn(
                          "h-3.5 w-3.5",
                          (figmaPlansQuery.isFetching || figmaPlansRefreshMutation.isPending)
                            && "animate-spin",
                        )}
                        aria-hidden
                      />
                      重新读取账号计划
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedOutputs((current) =>
                        current.includes("design-prototype")
                          ? current
                          : [...current, "design-prototype"],
                      )
                    }
                    className="text-xs font-semibold text-teal-800 underline decoration-teal-300 underline-offset-4 hover:text-teal-600"
                  >
                    同时交付 HTML 原型
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900">
                <div className="flex items-start gap-2.5">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold">
                      {isFigmaDetecting
                        ? "正在检测 Figma 授权…"
                        : runnerMode === "fake"
                          ? "Figma 需要真实 Codex Runner"
                        : hasFigmaDetectionError
                          ? "无法确认 Figma 是否已授权"
                          : figmaQuery.data?.state === "authorization_required"
                            ? "Figma MCP 尚未授权"
                            : figmaQuery.data?.state === "unavailable"
                              ? "Figma MCP 当前不可用"
                              : "尚未配置 Figma MCP"}
                    </p>
                    {!figmaReady && !isFigmaDetecting && !hasFigmaDetectionError && figmaQuery.data?.message ? (
                      <p className="mt-1 text-xs leading-5 text-amber-800">
                        {figmaQuery.data.message}
                      </p>
                    ) : null}
                    <p className="mt-1 text-xs leading-5 text-amber-800">
                      {runnerMode === "fake"
                        ? "Figma 已加入本次交付；请先将服务切换到 Real 模式，完成前不会启动执行。"
                        : "Figma 已加入本次交付；完成授权或重新检测前不会启动执行。"}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        onClick={() =>
                          setSelectedOutputs((current) =>
                            setFigmaRequested(
                              current.includes("design-prototype")
                                ? current
                                : [...current, "design-prototype"],
                              false,
                            ),
                          )
                        }
                        className="inline-flex items-center gap-1 text-xs font-semibold text-amber-900 underline decoration-amber-400 underline-offset-4 hover:text-amber-700"
                      >
                        改为只交付 HTML 原型
                      </button>
                      {runnerMode !== "fake" && !figmaReady ? (
                        <a
                          href={figmaAuthorizationUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs font-semibold text-amber-900 underline decoration-amber-400 underline-offset-4 hover:text-amber-700"
                        >
                          查看授权指引
                          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                        </a>
                      ) : null}
                      {!figmaReady ? (
                        <button
                          type="button"
                          disabled={figmaQuery.isFetching || figmaRefreshMutation.isPending}
                          onClick={() => figmaRefreshMutation.mutate()}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-amber-900 hover:text-amber-700 disabled:opacity-50"
                        >
                          <RefreshCw
                            className={cn(
                              "h-3.5 w-3.5",
                              (figmaQuery.isFetching || figmaRefreshMutation.isPending) && "animate-spin",
                            )}
                            aria-hidden
                          />
                          重新检测
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
                </div>
              )
            ) : null}

          <div
              className="mt-4 rounded-xl border border-slate-200 bg-slate-50/70 px-4 py-3.5"
              aria-labelledby="delivery-summary-title"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id="delivery-summary-title" className="text-sm font-semibold text-slate-900">
                  {submitsRoutedImpactAssessment || submitsArchitectureImpactAssessment
                    ? "本次影响处理"
                    : "本次将交付"}
                </h3>
                <Badge variant="muted">
                  {(canAssessRoutedImpact
                      && routedImpactChoice !== "partial"
                      && routedImpactChoice !== "full")
                    || architectureImpactChoice === "skip"
                    || architectureImpactChoice === "reuse"
                    ? "0 项生成"
                    : `${selectedOutputs.length} 项产物`}
                </Badge>
              </div>
              {canAssessRoutedImpact
                && routedImpactChoice !== "partial"
                && routedImpactChoice !== "full" ? (
                <p className="mt-3 text-xs leading-5 text-slate-600">
                  本次只记录 {routedImpactChoice ? "已选择的阶段处置" : "待选择的阶段处置"}；不会启动 Codex。
                </p>
              ) : architectureImpactChoice === "skip" ? (
                <p className="mt-3 text-xs leading-5 text-slate-600">
                  本次不生成架构产物；平台会保存豁免理由和选定输入。
                </p>
              ) : architectureImpactChoice === "reuse" ? (
                <p className="mt-3 text-xs leading-5 text-slate-600">
                  完整复用 {architectureBaseline?.artifacts.length ?? 0} 项已批准架构产物；不会启动 Codex。
                </p>
              ) : selectedOutputs.length > 0 ? (
              <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                {selectedOutputs.map((key) => (
                  <li
                    key={key}
                    className="flex min-w-0 items-center justify-between gap-2 rounded-lg bg-white px-3 py-2 text-xs text-slate-700 ring-1 ring-slate-200"
                  >
                    <span className="inline-flex min-w-0 items-center gap-2 font-semibold">
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-teal-600" aria-hidden />
                      <span className="truncate">{artifactLabel(key)}</span>
                    </span>
                    {key === "figma-handoff" ? (
                      <Badge variant={figmaExecutionReady ? "success" : "warning"}>
                        {figmaExecutionReady ? "目标已就绪" : "目标未就绪"}
                      </Badge>
                    ) : null}
                  </li>
                ))}
              </ul>
              ) : (
                <p className="mt-3 text-xs leading-5 text-slate-500">尚未选择影响范围或预期输出。</p>
              )}
              {isDesignPhase && figmaOutputSelected ? (
                <p
                  className={cn(
                    "mt-3 text-xs leading-5",
                    figmaExecutionReady ? "text-emerald-700" : "text-amber-700",
                  )}
                  aria-live="polite"
                >
                  {figmaExecutionReady
                    ? figmaTargetMode === "new_private_draft"
                      ? `Figma：新建私人 Draft · ${selectedFigmaPlan?.name ?? "已选计划"} · ${trimmedFigmaFileName}`
                      : "Figma：更新已指定文件 · 写入目标已验证"
                    : isFigmaDetecting
                      ? "Figma：正在检测授权，检测完成且目标完整后才能启动。"
                      : !figmaReady
                        ? "Figma：授权或连接尚未就绪，当前不能启动。"
                        : "Figma：写入目标尚未完整，当前不能启动。"}
                </p>
              ) : null}
          </div>
        </div>
        {error ? (
          <div role="alert" className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm text-rose-700">
            {error}
          </div>
        ) : null}
        {implementationStartHelp ? (
          <div role="alert" className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
            <div className="font-semibold">{implementationStartHelp.title}</div>
            <p className="mt-1 text-xs leading-5 text-amber-900">{implementationStartHelp.summary}</p>
            <ol className="mt-3 space-y-2">
              {implementationStartHelp.actions.map((action, index) => (
                <li key={`${action.code}-${index}`} className="rounded-lg bg-white/80 px-3 py-2.5 ring-1 ring-amber-200/80">
                  <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
                    <Badge variant="warning">{action.roleLabel}</Badge>
                    <span>{index + 1}. {action.title}</span>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-amber-900">{action.description}</p>
                  {action.blockerIds.length > 0 ? (
                    <p className="mt-1 font-mono text-[10px] text-amber-700">
                      Blockers: {action.blockerIds.join("、")}
                    </p>
                  ) : null}
                  {action.blockers.length > 0 ? (
                    <ul className="mt-2 space-y-1.5 text-xs leading-5 text-amber-900">
                      {action.blockers.map((blocker) => (
                        <li key={`${action.code}-${blocker.id}`} className="rounded-md bg-amber-50/80 px-2.5 py-2">
                          <strong>{blocker.id || "待决定"}：</strong>{blocker.decision || "缺少明确决定"}
                          {blocker.nextAction ? <span className="block text-amber-700">下一步：{blocker.nextAction}</span> : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="mt-2"
                    onClick={() => onNavigatePhase(
                      action.role === "designer"
                        ? "design"
                        : action.role === "architect"
                          ? "architecture"
                          : "discovery",
                    )}
                  >
                    前往 {action.roleLabel}
                  </Button>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
          <div className="mt-6 flex justify-end gap-3 border-t border-slate-100 pt-5">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              loading={mutation.isPending}
              onClick={() => mutation.mutate()}
              disabled={
                !hasInputsForCurrentAction
                || !hasAllRequiredOutputs
                || !routedImpactAssessmentReady
                || !hasValidArchitectureImpactRationale
                || hasUnsupportedFigmaOutput
                || !canUseSelectedCodexConfiguration
                || (!showsImpactAssessmentOnly && !runnerMode)
              }
            >
              {submitsRoutedImpactAssessment || submitsArchitectureImpactAssessment ? (
                <CheckCircle2 className="h-4 w-4" aria-hidden />
              ) : (
                <Play className="h-4 w-4" aria-hidden />
              )}
              {canAssessRoutedImpact && !routedImpactChoice
                ? "请选择阶段处置方式"
                : canAssessRoutedImpact
                  ? routedImpactChoice === "partial"
                    ? "确认局部影响范围"
                    : routedImpactChoice === "full"
                      ? runnerMode === "fake" ? "启动完整模拟执行" : "启动完整 Codex 执行"
                      : routedImpactChoice === "reuse"
                        ? "确认复用基线"
                        : routedImpactChoice === "skip"
                          ? "确认跳过设计"
                          : "确认直接采用合同"
                : canAssessArchitectureImpact && !architectureImpactChoice
                ? "请选择架构影响范围"
                : architectureImpactChoice === "reuse"
                ? "确认复用架构"
                : architectureImpactChoice === "skip"
                  ? "确认无需架构工作"
                : canAssessArchitectureImpact && architectureImpactChoice === "partial"
                  ? "确认局部更新范围"
                  : hasAssessedPartialImpact
                    ? "启动局部架构更新"
                    : canAssessArchitectureImpact && architectureImpactChoice === "full"
                      ? "开始完整架构重跑"
                    : runnerMode === "fake"
                ? "启动模拟执行"
                : runnerMode === "real"
                  ? isE2eAuthoring
                    ? "生成脚本并进入人工审核"
                    : isE2eExecution
                      ? "运行真实 Chromium 并取证"
                  : isImplementationEvidenceRepair
                    ? "检查并修复工程证据"
                    : phase.phaseId === "implementation" ? "检查条件并开始写代码" : "启动真实 Codex"
                  : "检测运行模式"}
            </Button>
          </div>
        </div>
      </fieldset>
    </Dialog>
  );
}
