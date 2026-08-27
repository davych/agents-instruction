import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Clock3,
  FileCheck2,
  FileText,
  GitBranch,
  LoaderCircle,
  Pencil,
  RefreshCw,
  RotateCcw,
  Save,
  XCircle,
} from "lucide-react";

import { keyForArtifact } from "@/components/run/run-page-helpers";
import { EmptyState, ErrorState, Field } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/api";
import {
  artifactReviewHeadKey,
  artifactRevisionByteLength,
  artifactRevisionContentInvalid,
  currentArtifactHeadIds,
  isArtifactHeadsChangedError,
  isArtifactRevisionRefreshError,
  reviewExitPolicy,
  unviewedCurrentArtifactHeads,
  updateArchitectureSelectionMarker,
} from "@/lib/artifact-review";
import {
  ENGINEERING_ARTIFACT_GUIDES,
  engineeringEvidenceGateGuidance,
  type EngineeringGateGuidance,
} from "@/lib/engineering-workflow";
import {
  HUMAN_DECISION_PHASE_LABELS,
  HUMAN_DECISION_ROLE_LABELS,
  actionableHumanDecisionItems,
  deferredHumanDecisionItems,
  dependentHumanDecisionItems,
  humanDecisionGateHeadline,
  humanDecisionKindLabel,
  humanDecisionPresets,
  nonBlockingHumanDecisionItems,
} from "@/lib/human-decisions";
import { registerNavigationGuard } from "@/lib/navigation-guard";
import { TEST_REPORT_REVIEW_POINTS } from "@/lib/tester-workflow";
import {
  RELEASE_COMPLETION_BOUNDARY,
  RELEASE_REVIEW_POINTS,
} from "@/lib/release-workflow";
import {
  architectureOptionSummaries,
  architectureOutputKeysRequiringRefresh,
  architectureSelectionFromReviews,
  isArchitectureImpactOutputMutable,
  isArchitectureReselectionBlockedByImpact,
  parseArchitectureSelectionId,
  requiredPhaseApprovalOutputKeys,
} from "@/lib/phase-output-selection";
import { isResolutionOutputMutable } from "@/lib/phase-impact";
import type {
  HumanDecisionPhaseId,
  PhaseHumanDecisionGate,
  PhaseDefinition,
  PhaseRun,
  ReviewDecision,
} from "@/lib/types";
import { cn, formatDate } from "@/lib/utils";
import {
  STATUS_LABELS,
  artifactLabel,
  getPhaseName,
} from "@/lib/workflow";

const MarkdownPreview = lazy(() =>
  import("@/components/markdown-preview").then((module) => ({ default: module.MarkdownPreview })),
);
const HtmlPreview = lazy(() =>
  import("@/components/html-preview").then((module) => ({ default: module.HtmlPreview })),
);
const MermaidPreview = lazy(() =>
  import("@/components/mermaid-preview").then((module) => ({ default: module.MermaidPreview })),
);

export function ReviewDialog({
  runId,
  phase,
  definition,
  decisionGate,
  initialArtifactId,
  open,
  onOpenChange,
  onRerunArtifact,
  onRerunOutputs,
  onNavigateDecisionPhase,
  onDecisionSaved,
}: {
  runId: string;
  phase: PhaseRun;
  definition: PhaseDefinition;
  decisionGate?: PhaseHumanDecisionGate;
  initialArtifactId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRerunArtifact: (artifactKey: string) => void;
  onRerunOutputs: (artifactKeys: string[]) => void;
  onNavigateDecisionPhase: (phaseId: HumanDecisionPhaseId) => void;
  onDecisionSaved: (phaseId: HumanDecisionPhaseId) => void;
}) {
  const queryClient = useQueryClient();
  const implementationReviewOrder = [
    "implementation-notes",
    "engineering-test-evidence",
    "engineering-review",
    "implementation-plan",
    "implementation-tasks",
    "engineering-session-log",
    "engineering-provenance",
  ];
  const reviewArtifacts = phase.phaseId === "implementation"
    ? [...phase.artifacts].sort((left, right) => {
        const leftIndex = implementationReviewOrder.indexOf(keyForArtifact(left));
        const rightIndex = implementationReviewOrder.indexOf(keyForArtifact(right));
        return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex)
          - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex);
      })
    : phase.artifacts;
  const preservedDraftRef = useRef<{
    artifactId: string;
    content: string;
  }>();
  const decisionResponsesBaselineRef = useRef<Record<string, string>>({});
  const artifactHeadsSignatureRef = useRef("");
  const [selectedArtifactId, setSelectedArtifactId] = useState(
    initialArtifactId ?? reviewArtifacts[0]?.id ?? "",
  );
  const [artifactView, setArtifactView] = useState<"preview" | "edit">("preview");
  const [draftContent, setDraftContent] = useState("");
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string>();
  const [engineeringGateHelp, setEngineeringGateHelp] = useState<EngineeringGateGuidance>();
  const [revisionError, setRevisionError] = useState<string>();
  const [reviewConflict, setReviewConflict] = useState<string>();
  const [decisionResponses, setDecisionResponses] = useState<Record<string, string>>({});
  const [viewedArtifactHeadKeys, setViewedArtifactHeadKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const actionableDecisionItems = actionableHumanDecisionItems(decisionGate);
  const dependentDecisionItems = dependentHumanDecisionItems(decisionGate);
  const deferredDecisionItems = deferredHumanDecisionItems(decisionGate);
  const nonBlockingDecisionItems = nonBlockingHumanDecisionItems(decisionGate);
  const selectedSummary = phase.artifacts.find((artifact) => artifact.id === selectedArtifactId);
  const artifactQuery = useQuery({
    queryKey: ["artifact", selectedArtifactId],
    queryFn: () => api.getArtifact(selectedArtifactId),
    enabled: Boolean(selectedArtifactId),
  });
  const artifact = artifactQuery.data ?? selectedSummary;
  const content = artifact?.content;
  const artifactKey = artifact ? keyForArtifact(artifact) : "";
  const selectedEngineeringGuide = ENGINEERING_ARTIFACT_GUIDES.find(
    (guide) => guide.key === artifactKey,
  );
  const artifactPath = artifact?.filePath || artifact?.path || "";
  const isHtmlArtifact =
    artifactKey === "design-prototype" || /\.(?:html?|xhtml)$/iu.test(artifactPath);
  const isMermaidArtifact =
    ["architecture-c4-context", "architecture-c4-containers"].includes(artifactKey)
    || /\.(?:mmd|mermaid)$/iu.test(artifactPath);
  const artifactFormat = isHtmlArtifact ? "HTML" : isMermaidArtifact ? "Mermaid" : "Markdown";
  const isSuperseded = artifact?.superseded || artifact?.reviewStatus === "superseded";
  const isImpactReadOnly = artifactKey === "change-contract" || (phase.resolution
    ? !isResolutionOutputMutable(phase.resolution, artifactKey)
    : phase.phaseId === "architecture"
      && !isArchitectureImpactOutputMutable(
        phase.architectureImpact?.mode,
        phase.architectureImpact?.affectedOutputKeys,
        artifactKey,
      ));
  const isDirty = typeof content === "string" && draftContent !== content;
  const revisionByteLength = artifactRevisionByteLength(draftContent);
  const revisionContentInvalid = artifactRevisionContentInvalid(draftContent);
  const canEdit =
    typeof content === "string"
    && Boolean(artifact?.contentHash)
    && !isSuperseded
    && !isImpactReadOnly
    && [
      "ready",
      "awaiting_review",
      "approved",
      "changes_requested",
      "rejected",
      "failed",
    ].includes(phase.status);
  const canRerunArtifact =
    Boolean(artifactKey)
    && !isSuperseded
    && !isImpactReadOnly
    && [
      "ready",
      "awaiting_review",
      "approved",
      "changes_requested",
      "rejected",
      "failed",
    ].includes(phase.status);
  const currentArtifactHeads = phase.artifacts.filter(
    (candidate) => !candidate.superseded && candidate.reviewStatus !== "superseded",
  );
  const artifactHeadsSignature = currentArtifactHeads
    .map((candidate) => artifactReviewHeadKey(candidate) ?? `${candidate.id}:missing-content-hash`)
    .sort()
    .join("|");
  const unviewedArtifactHeads = unviewedCurrentArtifactHeads(
    phase.artifacts,
    viewedArtifactHeadKeys,
  );
  const decisionResponseKeys = new Set([
    ...Object.keys(decisionResponsesBaselineRef.current),
    ...Object.keys(decisionResponses),
  ]);
  const hasDirtyDecisionResponses = [...decisionResponseKeys].some(
    (key) => (decisionResponses[key] ?? "") !== (decisionResponsesBaselineRef.current[key] ?? ""),
  );
  const currentArtifactKeys = new Set(currentArtifactHeads.map((candidate) => keyForArtifact(candidate)));
  const missingApprovalOutputKeys = requiredPhaseApprovalOutputKeys(
    phase.phaseId,
    definition.outputs,
  ).filter((key) => !currentArtifactKeys.has(key));
  const currentOptionsHead = currentArtifactHeads.find(
    (candidate) => keyForArtifact(candidate) === "architecture-options",
  );
  const currentDiscoveryHead = currentArtifactHeads.find(
    (candidate) => keyForArtifact(candidate) === "architecture-discovery-context",
  );
  const currentOptionsQuery = useQuery({
    queryKey: ["artifact", currentOptionsHead?.id ?? "architecture-options-missing"],
    queryFn: () => api.getArtifact(currentOptionsHead!.id),
    enabled: Boolean(currentOptionsHead?.id),
  });
  const currentOptionsContent = currentOptionsQuery.data?.content
    ?? currentOptionsHead?.content
    ?? "";
  const architectureOptions = useMemo(
    () => architectureOptionSummaries(currentOptionsContent),
    [currentOptionsContent],
  );
  const architectureSelection = phase.phaseId === "architecture"
    ? phase.architectureImpact?.selection
      ?? (
        currentOptionsHead
        && currentDiscoveryHead
        ? architectureSelectionFromReviews(
            phase.reviews,
            currentOptionsHead.id,
            [currentOptionsHead.id, currentDiscoveryHead.id],
          )
        : undefined
      )
    : undefined;
  const isPartialArchitectureImpactReview = phase.phaseId === "architecture"
    && phase.architectureImpact?.mode === "partial";
  const staleArchitectureOutputKeys = architectureSelection
    ? architectureOutputKeysRequiringRefresh({
        impactMode: phase.architectureImpact?.mode,
        affectedOutputKeys: phase.architectureImpact?.affectedOutputKeys,
        availableOutputKeys: definition.outputs,
        artifacts: currentArtifactHeads.map((artifactHead) => ({
          artifactKey: keyForArtifact(artifactHead),
          revision: artifactHead.revision,
          createdAt: artifactHead.createdAt,
        })),
        selectedAt: architectureSelection.selectedAt,
      })
    : [];
  const isArchitectureSelectionCheckpoint =
    phase.phaseId === "architecture" && !architectureSelection;
  const architectureSelectionIdInComment = parseArchitectureSelectionId(comment.trim());
  const architectureReselectionBlocked = isArchitectureReselectionBlockedByImpact(
    phase.architectureImpact?.mode,
    comment.trim(),
  );
  const showsArchitectureSelectionAction = Boolean(architectureSelectionIdInComment)
    && !architectureReselectionBlocked;

  useEffect(() => {
    const preservedDraft = preservedDraftRef.current;
    if (preservedDraft?.artifactId === selectedArtifactId) {
      setDraftContent(preservedDraft.content);
      setArtifactView("edit");
      setRevisionError(undefined);
      if (
        artifactQuery.data?.id === selectedArtifactId
        && typeof artifactQuery.data.content === "string"
      ) {
        preservedDraftRef.current = undefined;
      }
      return;
    }
    setDraftContent(content ?? "");
    setArtifactView("preview");
    setRevisionError(undefined);
  }, [selectedArtifactId, artifact?.contentHash, artifactQuery.data, content]);

  useEffect(() => {
    const nextDecisionResponses = Object.fromEntries(
      actionableDecisionItems.map((item) => [
        item.id,
        item.response
          ?? (item.kind === "work" ? `请完成该待办并更新正式产物：${item.nextAction}` : ""),
      ]),
    );
    decisionResponsesBaselineRef.current = nextDecisionResponses;
    setDecisionResponses(nextDecisionResponses);
  }, [
    decisionGate?.phaseId,
    decisionGate?.items.map(({ id, response, blocking, actionPhaseId }) => (
      `${id}:${response ?? ""}:${blocking}:${actionPhaseId}`
    )).join("|"),
  ]);

  useEffect(() => {
    if (artifactHeadsSignatureRef.current === artifactHeadsSignature) return;
    artifactHeadsSignatureRef.current = artifactHeadsSignature;
    setViewedArtifactHeadKeys(new Set());
  }, [artifactHeadsSignature]);

  useEffect(() => {
    const loadedArtifact = artifactQuery.data;
    if (!artifactQuery.isSuccess || loadedArtifact?.id !== selectedArtifactId) return;
    const currentHead = currentArtifactHeads.find(
      (candidate) => candidate.id === loadedArtifact.id
        && candidate.contentHash === loadedArtifact.contentHash,
    );
    const reviewedHeadKey = currentHead ? artifactReviewHeadKey(currentHead) : undefined;
    if (!reviewedHeadKey) return;
    setViewedArtifactHeadKeys((current) => {
      if (current.has(reviewedHeadKey)) return current;
      const next = new Set(current);
      next.add(reviewedHeadKey);
      return next;
    });
  }, [
    artifactHeadsSignature,
    artifactQuery.data?.contentHash,
    artifactQuery.data?.id,
    artifactQuery.isSuccess,
    selectedArtifactId,
  ]);

  const revisionMutation = useMutation({
    mutationFn: (variables: {
      artifactId: string;
      nextContent: string;
      expectedContentHash: string;
      artifactKey: string;
    }) => api.createArtifactRevision(variables.artifactId, {
      content: variables.nextContent,
      expectedContentHash: variables.expectedContentHash,
    }),
    onMutate: () => setRevisionError(undefined),
    onSuccess: async (revision, variables) => {
      const hydratedRevision = {
        ...revision,
        content: revision.content ?? variables.nextContent,
      };
      queryClient.setQueryData(["artifact", revision.id], hydratedRevision);
      setSelectedArtifactId(revision.id);
      setDraftContent(hydratedRevision.content);
      setArtifactView("preview");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["artifact", variables.artifactId] }),
        queryClient.invalidateQueries({ queryKey: ["run", runId] }),
      ]);
    },
    onError: async (mutationError, variables) => {
      if (!isArtifactRevisionRefreshError(mutationError)) {
        setRevisionError(
          mutationError instanceof Error ? mutationError.message : "保存人工修订失败",
        );
        return;
      }

      const conflictCode = (mutationError as { code?: string }).code;
      const preservedDraft = variables.nextContent;
      try {
        const refreshedRun = await api.getRun(runId);
        queryClient.setQueryData(["run", runId], refreshedRun);
        const refreshedPhase = refreshedRun.phases.find(
          (candidate) => candidate.phaseId === phase.phaseId,
        );
        const refreshedArtifact = refreshedPhase?.artifacts.find(
          (candidate) =>
            !candidate.superseded
            && candidate.reviewStatus !== "superseded"
            && keyForArtifact(candidate) === variables.artifactKey,
        );

        if (!refreshedArtifact) {
          setRevisionError(
            "检测到产物冲突，但未找到同类型的最新 head。你的编辑草稿仍已保留，请刷新后比较。",
          );
          return;
        }

        preservedDraftRef.current = {
          artifactId: refreshedArtifact.id,
          content: preservedDraft,
        };
        setSelectedArtifactId(refreshedArtifact.id);
        await queryClient.fetchQuery({
          queryKey: ["artifact", refreshedArtifact.id],
          queryFn: () => api.getArtifact(refreshedArtifact.id),
        });
        setRevisionError(
          conflictCode === "ARTIFACT_WORKSPACE_DIVERGED"
            ? "工作区文件与当前审核快照已经分叉。已刷新最新 head 和内容，且未覆盖你的草稿；请比较后再保存。"
            : "产物已产生更新的 revision。已刷新最新 head 和内容，且未覆盖你的草稿；请比较后再保存。",
        );
      } catch (refreshError) {
        setRevisionError(
          `检测到产物冲突，但自动刷新失败：${
            refreshError instanceof Error ? refreshError.message : "请稍后重试"
          }。你的编辑草稿仍已保留。`,
        );
        await queryClient.invalidateQueries({ queryKey: ["run", runId] });
      }
    },
  });
  const reviewMutation = useMutation({
    mutationFn: ({
      decision,
      expectedArtifactIds,
    }: {
      decision: ReviewDecision;
      expectedArtifactIds: string[];
      architectureSelectionId?: string;
    }) => api.reviewPhase(
      runId,
      phase.phaseId,
      decision,
      comment.trim(),
      expectedArtifactIds,
    ),
    onSuccess: async (_, variables) => {
      setEngineeringGateHelp(undefined);
      await queryClient.invalidateQueries({ queryKey: ["run", runId] });
      if (variables.architectureSelectionId) {
        onDecisionSaved("architecture");
        return;
      }
      onOpenChange(false);
    },
    onError: async (mutationError) => {
      if (mutationError instanceof ApiError && mutationError.code === "PHASE_HUMAN_DECISIONS_REQUIRED") {
        setEngineeringGateHelp(undefined);
        setError("这个阶段还有未关闭的决定或角色待办。请先在上方处理，再让对应角色更新正式产物。");
        await queryClient.invalidateQueries({ queryKey: ["run", runId] });
        return;
      }
      const gateHelp = engineeringEvidenceGateGuidance(mutationError);
      if (gateHelp) {
        setError(undefined);
        setEngineeringGateHelp(gateHelp);
        return;
      }
      if (!isArtifactHeadsChangedError(mutationError)) {
        setError(mutationError instanceof Error ? mutationError.message : "提交审核失败");
        return;
      }

      setError(undefined);
      setReviewConflict(
        "审核期间产物已更新。已刷新到最新 revision，请重新审阅后再次提交；你的审核意见和编辑草稿已保留。",
      );
      const currentArtifactKey = artifactKey;
      const draftToPreserve = artifactView === "edit" ? draftContent : undefined;

      try {
        const refreshedRun = await api.getRun(runId);
        queryClient.setQueryData(["run", runId], refreshedRun);
        const refreshedPhase = refreshedRun.phases.find(
          (candidate) => candidate.phaseId === phase.phaseId,
        );
        const refreshedHeads = refreshedPhase?.artifacts.filter(
          (candidate) => !candidate.superseded && candidate.reviewStatus !== "superseded",
        ) ?? [];
        const refreshedArtifact =
          refreshedHeads.find((candidate) => keyForArtifact(candidate) === currentArtifactKey)
          ?? refreshedHeads[0];

        if (refreshedArtifact) {
          if (draftToPreserve !== undefined) {
            preservedDraftRef.current = {
              artifactId: refreshedArtifact.id,
              content: draftToPreserve,
            };
          }
          setSelectedArtifactId(refreshedArtifact.id);
          await queryClient.fetchQuery({
            queryKey: ["artifact", refreshedArtifact.id],
            queryFn: () => api.getArtifact(refreshedArtifact.id),
          });
        }
      } catch (refreshError) {
        setReviewConflict(
          `产物已变化，但自动刷新失败：${
            refreshError instanceof Error ? refreshError.message : "请稍后手动重试"
          }。审核意见和编辑草稿仍已保留。`,
        );
        await queryClient.invalidateQueries({ queryKey: ["run", runId] });
      }
    },
  });
  const decisionCaptureMutation = useMutation({
    mutationFn: (variables: {
      phaseId: HumanDecisionPhaseId;
      responses: Array<{ id: string; response: string }>;
      expectedArtifactIds: string[];
    }) => api.captureHumanDecisions(
      runId,
      variables.phaseId,
      variables.responses,
      variables.expectedArtifactIds,
    ),
    onMutate: () => setError(undefined),
    onSuccess: async (_, variables) => {
      await queryClient.invalidateQueries({ queryKey: ["run", runId] });
      onDecisionSaved(variables.phaseId);
    },
    onError: async (mutationError) => {
      setError(
        isArtifactHeadsChangedError(mutationError)
          ? "保存期间正式产物已经变化。页面已刷新，请确认最新内容后再次保存决定。"
          : mutationError instanceof Error
            ? mutationError.message
            : "保存决定失败",
      );
      await queryClient.invalidateQueries({ queryKey: ["run", runId] });
    },
  });
  const hasPendingReviewWork = revisionMutation.isPending
    || reviewMutation.isPending
    || decisionCaptureMutation.isPending;
  const hasUnsavedReviewWork = isDirty
    || comment.length > 0
    || hasDirtyDecisionResponses;
  const isReviewable = phase.status === "awaiting_review";
  const confirmReviewExit = () => {
    const exitPolicy = reviewExitPolicy({
      pending: hasPendingReviewWork,
      dirty: hasUnsavedReviewWork,
    });
    if (exitPolicy === "block") {
      setError("审核操作仍在处理中，请等待完成后再关闭窗口。");
      return false;
    }
    if (
      exitPolicy === "confirm"
      && !window.confirm("关闭后将丢弃尚未提交的审核意见、决定回答或人工编辑。确定关闭吗？")
    ) {
      return false;
    }
    return true;
  };

  useEffect(() => {
    if (!open) return undefined;
    return registerNavigationGuard(confirmReviewExit);
  }, [open, hasPendingReviewWork, hasUnsavedReviewWork]);

  useEffect(() => {
    if (!open || (!hasPendingReviewWork && !hasUnsavedReviewWork)) return undefined;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [open, hasPendingReviewWork, hasUnsavedReviewWork]);

  const submitDecisionResponses = () => {
    if (!decisionGate || actionableDecisionItems.length === 0) return;
    if (isDirty || revisionMutation.isPending) {
      setError("请先保存或取消当前人工编辑，再提交决定。");
      return;
    }
    const responses = actionableDecisionItems.map((item) => ({
      id: item.id,
      response: (decisionResponses[item.id] ?? "").trim(),
    }));
    const missingDecision = actionableDecisionItems.find(
      (item) => item.kind === "decision" && (decisionResponses[item.id] ?? "").trim().length < 3,
    );
    if (missingDecision) {
      setError(`请回答 ${missingDecision.id}：${missingDecision.title}`);
      return;
    }
    const incompleteMonitoringDecision = actionableDecisionItems.find((item) => {
      const response = (decisionResponses[item.id] ?? "").trim();
      return item.id === "ARCH-OBS-002"
        && /已有监控平台/u.test(response)
        && /【请填写】|平台名称\s*=\s*(?:[；;]|$)|负责人\s*=\s*(?:[；;]|$)/u.test(response);
    });
    if (incompleteMonitoringDecision) {
      setError("选择已有监控平台时，请先把平台名称和负责人补完整；如果目前没有平台，可选择“本地最小诊断（推荐）”。");
      return;
    }
    const expectedArtifactIds = currentArtifactHeadIds(phase.artifacts);
    if (expectedArtifactIds.length === 0) {
      setError("当前阶段没有可用于承接决定的正式产物，请先运行对应角色。");
      return;
    }
    if (
      comment.length > 0
      && !window.confirm("保存决定后会进入下一步，尚未提交的审核意见不会被保存。仍要继续吗？")
    ) {
      return;
    }
    decisionCaptureMutation.mutate({
      phaseId: decisionGate.phaseId,
      responses,
      expectedArtifactIds,
    });
  };
  const submit = (decision: ReviewDecision) => {
    setEngineeringGateHelp(undefined);
    if (isDirty || revisionMutation.isPending) {
      setError("请先保存或取消当前人工编辑，再提交审核结论。");
      return;
    }
    if (!comment.trim()) {
      setError(decision === "approve" ? "请留下简短的审核结论。" : "请说明需要修改的内容。");
      return;
    }
    if (decision === "approve" && decisionGate && decisionGate.blockingCount > 0) {
      setError("还有未关闭的决定、角色待办或上游依赖。请先处理上方清单并让对应角色更新正式产物。");
      return;
    }
    if (decision === "approve" && unviewedArtifactHeads.length > 0) {
      setError(
        `还需逐份查看当前版本：${unviewedArtifactHeads
          .map((candidate) => artifactLabel(keyForArtifact(candidate)))
          .join("、")}。`,
      );
      return;
    }
    if (decision === "request_changes" && architectureReselectionBlocked) {
      setError("局部更新不能重新选型，请完整重跑。");
      return;
    }
    if (
      decision === "request_changes"
      && architectureSelectionIdInComment
      && decisionGate
      && decisionGate.blockingCount > 0
    ) {
      setError("先完成上方具体架构决定，再让 Architect 刷新 options；刷新后才能选择当前版本的方案。");
      return;
    }
    if (decision === "approve" && isArchitectureSelectionCheckpoint) {
      setError("请先使用 `Selected option: <ID>` 记录一个针对当前 options revision 的人工选型。");
      return;
    }
    if (decision === "approve" && missingApprovalOutputKeys.length > 0) {
      setError(`阶段产物尚未齐全，不能通过：${missingApprovalOutputKeys.join(", ")}`);
      return;
    }
    if (decision === "approve" && staleArchitectureOutputKeys.length > 0) {
      setError(
        isPartialArchitectureImpactReview
          ? `这些产物尚未在本次影响评估后更新：${staleArchitectureOutputKeys.join(", ")}`
          : `这些产物早于人工选型，必须重新生成：${staleArchitectureOutputKeys.join(", ")}`,
      );
      return;
    }
    if (
      decision === "request_changes"
      && architectureSelectionIdInComment
      && !currentOptionsHead
    ) {
      setError("必须先生成 architecture-options 才能记录选型。");
      return;
    }
    const expectedArtifactIds = currentArtifactHeadIds(phase.artifacts);
    if (expectedArtifactIds.length === 0) {
      setError("当前阶段没有可审核的有效产物，请刷新后再试。");
      return;
    }
    setError(undefined);
    reviewMutation.mutate({
      decision,
      expectedArtifactIds,
      architectureSelectionId: decision === "request_changes"
        ? architectureSelectionIdInComment
        : undefined,
    });
  };
  const saveRevision = () => {
    if (!artifact?.id || !artifact.contentHash) {
      setRevisionError("当前产物缺少可用于并发校验的内容哈希，请重新读取后再试。");
      return;
    }
    if (revisionContentInvalid) {
      setRevisionError("修订内容不能为空，且不能超过 2,000,000 字节。");
      return;
    }
    if (!isDirty) {
      setArtifactView("preview");
      return;
    }
    revisionMutation.mutate({
      artifactId: artifact.id,
      nextContent: draftContent,
      expectedContentHash: artifact.contentHash,
      artifactKey,
    });
  };
  const changeArtifact = (artifactId: string) => {
    if (isDirty || revisionMutation.isPending) {
      setRevisionError("请先保存或取消当前人工编辑，再切换产物。");
      return;
    }
    setSelectedArtifactId(artifactId);
  };
  const leaveReviewFor = (action: () => void) => {
    if (confirmReviewExit()) action();
  };
  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      onOpenChange(true);
      return;
    }
    if (!confirmReviewExit()) return;
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      closeDisabled={hasPendingReviewWork}
      title={`人工审核 · ${getPhaseName(definition)}`}
      description={phase.phaseId === "implementation"
        ? "你只需看实现、测试和风险，不要求编辑 Markdown；确认没有阻塞后，通过并解锁 Tester。"
        : phase.phaseId === "verification"
          ? `先确认 ${TEST_REPORT_REVIEW_POINTS.join("；")}。通过只代表 Verification 证据完整，不代表 PR、合并或发布已批准。`
          : phase.phaseId === "release"
            ? `先确认 ${RELEASE_REVIEW_POINTS.join("；")}。${RELEASE_COMPLETION_BOUNDARY}`
            : "逐份查看或人工修订阶段产物，也可只重跑当前产物。通过后会解锁下一角色。"}
      className="max-w-6xl"
    >
      {reviewConflict ? (
        <div
          role="alert"
          className="flex shrink-0 items-start gap-2.5 border-b border-amber-200 bg-amber-50 px-5 py-3 text-xs leading-5 text-amber-900"
        >
          <RefreshCw className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{reviewConflict}</span>
        </div>
      ) : null}
      {isReviewable ? (
        <div
          role="status"
          aria-live="polite"
          className="flex min-w-0 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-sky-50 px-5 py-2.5 text-xs text-sky-950"
        >
          <span className="font-semibold">
            当前版本已查看 {currentArtifactHeads.length - unviewedArtifactHeads.length} / {currentArtifactHeads.length}
          </span>
          <span className="min-w-0 break-words text-sky-800">
            {unviewedArtifactHeads.length > 0
              ? `通过前还需打开：${unviewedArtifactHeads
                  .map((candidate) => artifactLabel(keyForArtifact(candidate)))
                  .join("、")}`
              : "当前所有产物 head 均已加载并查看。"}
          </span>
        </div>
      ) : null}
      <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)] overflow-y-auto lg:grid-cols-[minmax(0,1fr)_340px] lg:overflow-hidden">
        <div className="flex min-h-0 min-w-0 max-w-full flex-col border-b border-slate-200 lg:border-b-0 lg:border-r">
          {reviewArtifacts.length > 1 ? (
            <div className="scrollbar-thin shrink-0 overflow-x-auto border-b border-slate-100 p-3">
              {phase.phaseId === "implementation" ? (
                <div className="mb-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-[11px] leading-4 text-sky-800">
                  <strong>建议先看 3 份：</strong>实现说明 → 独立测试证据 → 工程七镜。计划、任务、会话日志和交付追溯清单由 Codex 维护，通常不用逐字阅读；交付追溯清单不是实际 PR，且明确 Software Engineer 未创建或发布 PR。审批门仍会自动检查全部 7 份。
                </div>
              ) : null}
              <Tabs value={selectedArtifactId} onValueChange={changeArtifact}>
                <TabsList className="w-max">
                  {reviewArtifacts.map((item) => {
                    const reviewedHeadKey = artifactReviewHeadKey(item);
                    const hasViewedCurrentHead = Boolean(
                      reviewedHeadKey && viewedArtifactHeadKeys.has(reviewedHeadKey),
                    );
                    return (
                      <TabsTrigger key={item.id} value={item.id}>
                        {hasViewedCurrentHead ? <Check className="h-3.5 w-3.5" aria-hidden /> : null}
                        {artifactLabel(keyForArtifact(item))}
                        {item.revision ? ` · v${item.revision}` : ""}
                      </TabsTrigger>
                    );
                  })}
                </TabsList>
              </Tabs>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 bg-slate-50/60 px-5 py-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-slate-700">
                <span className="truncate">{artifact ? artifactLabel(artifactKey) : "阶段产物"}</span>
                {artifact?.revision ? <Badge variant="muted">v{artifact.revision}</Badge> : null}
                {artifact?.revisionSource === "human" ? <Badge variant="info">人工修订</Badge> : null}
                {isSuperseded ? <Badge variant="muted">已被替代</Badge> : null}
              </div>
              <div className="mt-0.5 truncate font-mono text-[10px] text-slate-400">
                {artifactPath || `${artifactFormat} preview`}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{artifactFormat}</Badge>
              {canEdit && artifactView === "preview" ? (
                <Button size="sm" variant="outline" onClick={() => setArtifactView("edit")}>
                  <Pencil className="h-3.5 w-3.5" aria-hidden />
                  人工编辑
                </Button>
              ) : null}
              {canRerunArtifact ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isDirty || hasPendingReviewWork}
                  onClick={() => leaveReviewFor(() => onRerunArtifact(artifactKey))}
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                  仅重跑当前产物
                </Button>
              ) : null}
            </div>
          </div>
          <div className="min-h-[280px] min-w-0 max-w-full flex-1 overflow-x-hidden bg-white p-5 sm:p-7 lg:max-h-[65vh] lg:min-h-[340px] lg:overflow-y-auto">
            {artifactQuery.isLoading ? (
              <div className="flex h-52 items-center justify-center gap-2 text-sm text-slate-400">
                <LoaderCircle className="h-4 w-4 animate-spin" /> 读取产物…
              </div>
            ) : artifactQuery.isError ? (
              <ErrorState error={artifactQuery.error} retry={() => void artifactQuery.refetch()} />
            ) : artifactView === "edit" && typeof content === "string" ? (
              <div>
                <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                  保存会创建新的人工 revision，不会覆盖当前历史版本。
                  {isHtmlArtifact
                    ? " HTML 将在保存后继续通过隔离沙箱预览。"
                    : isMermaidArtifact
                      ? " Mermaid 将在保存后直接于浏览器中重新渲染。"
                      : ""}
                </div>
                <Textarea
                  autoFocus
                  value={draftContent}
                  onChange={(event) => setDraftContent(event.target.value)}
                  disabled={revisionMutation.isPending}
                  spellCheck={false}
                  aria-label={`编辑 ${artifactLabel(artifactKey)}`}
                  className="min-h-[48vh] resize-y font-mono text-xs leading-6"
                />
                <div className="mt-1.5 text-right text-[10px] text-slate-400">
                  {revisionByteLength.toLocaleString()} / 2,000,000 字节
                </div>
                {revisionError ? (
                  <div role="alert" className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-xs text-rose-700">
                    {revisionError}
                  </div>
                ) : null}
                <div className="mt-3 flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    disabled={revisionMutation.isPending}
                    onClick={() => {
                      setDraftContent(content);
                      setArtifactView("preview");
                      setRevisionError(undefined);
                    }}
                  >
                    取消编辑
                  </Button>
                  <Button
                    variant="primary"
                    loading={revisionMutation.isPending}
                    disabled={!isDirty || revisionContentInvalid}
                    onClick={saveRevision}
                  >
                    <Save className="h-4 w-4" aria-hidden />
                    保存新修订
                  </Button>
                </div>
              </div>
            ) : typeof content === "string" && content.length > 0 ? (
              <Suspense
                fallback={
                  <div className="flex h-52 items-center justify-center gap-2 text-sm text-slate-400">
                    <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
                    正在渲染 {artifactFormat}…
                  </div>
                }
              >
                {isHtmlArtifact ? (
                  <HtmlPreview content={content} />
                ) : isMermaidArtifact ? (
                  <MermaidPreview content={content} />
                ) : (
                  <MarkdownPreview content={content} />
                )}
              </Suspense>
            ) : (
              <EmptyState
                title="没有可预览的内容"
                description="该产物可能是目录、尚未写入，或后端只返回了文件引用。"
              />
            )}
            {artifactView === "preview" && revisionError ? (
              <div role="alert" className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-xs text-rose-700">
                {revisionError}
              </div>
            ) : null}
          </div>
        </div>

        <aside className="min-w-0 max-w-full bg-slate-50/60 p-5 lg:max-h-[75vh] lg:overflow-y-auto">
          {deferredDecisionItems.length > 0 ? (
            <section
              className="mb-5 rounded-xl border border-sky-200 bg-sky-50 p-4"
              aria-label="实现后验证交接"
            >
              <div className="flex items-start gap-2.5">
                <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-sky-700" aria-hidden />
                <div>
                  <div className="text-sm font-semibold text-slate-950">
                    实现后验证 · 当前不阻塞
                  </div>
                  <p className="mt-1 text-xs leading-5 text-slate-700">
                    这些检查依赖可运行实现。确认设计已经写清行为和通过条件即可；Software Engineer 完成代码后，由 Tester 在 Verification 记录真实证据。
                  </p>
                </div>
              </div>
              <div className="mt-3 space-y-2">
                {deferredDecisionItems.map((item) => (
                  <div key={item.id} className="rounded-lg border border-sky-100 bg-white p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-xs font-semibold text-slate-900">{item.id} · {item.title}</div>
                      <Badge variant="muted">{humanDecisionKindLabel(item)}</Badge>
                    </div>
                    <p className="mt-1.5 text-[11px] leading-4 text-slate-600">{item.prompt}</p>
                    <p className="mt-1.5 text-[10px] leading-4 text-slate-500">
                      验证负责人：{item.owner} · 证据要求：{item.nextAction}
                    </p>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
          {nonBlockingDecisionItems.length > 0 ? (
            <section className="mb-5 rounded-xl border border-slate-200 bg-white p-4" aria-label="不阻塞的开放问题">
              <div className="text-sm font-semibold text-slate-950">开放问题 · 当前不阻塞</div>
              <p className="mt-1 text-xs leading-5 text-slate-600">
                这些问题不改变当前实现合同，不需要你现在回答；若答案会改变范围或行为，应重新执行 Impact Check。
              </p>
              <ul className="mt-3 space-y-2">
                {nonBlockingDecisionItems.map((item) => (
                  <li key={item.id} className="rounded-lg bg-slate-50 px-3 py-2 text-[11px] leading-4 text-slate-700">
                    <span className="font-semibold">{item.id} · {item.title}</span>
                    <span className="mt-1 block">{item.prompt}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {decisionGate && decisionGate.blockingCount > 0 ? (
            <section
              className={cn(
                "mb-5 rounded-xl border p-4",
                decisionGate.inconsistentApproval
                  ? "border-rose-200 bg-rose-50"
                  : "border-amber-200 bg-amber-50",
              )}
              aria-label="本阶段决定与待办"
            >
              <div className="flex items-start gap-2.5">
                <AlertCircle className={cn(
                  "mt-0.5 h-4 w-4 shrink-0",
                  decisionGate.inconsistentApproval ? "text-rose-700" : "text-amber-700",
                )} aria-hidden />
                <div>
                  <div className="text-sm font-semibold text-slate-950">
                    {humanDecisionGateHeadline(decisionGate)}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-slate-700">
                    {decisionGate.inconsistentApproval
                      ? "这是旧流程留下的不一致：通过状态不代表这些问题已经解决。"
                      : "先完成这里的决定与待办；正式产物更新后，审批门才会放行。"}
                  </p>
                </div>
              </div>

              {dependentDecisionItems.length > 0 ? (
                <div className="mt-4 space-y-2">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    应回到上游处理
                  </div>
                  {dependentDecisionItems.map((item) => (
                    <div key={item.id} className="rounded-lg border border-slate-200 bg-white p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="text-xs font-semibold text-slate-900">{item.id} · {item.title}</div>
                          <p className="mt-1 text-[11px] leading-4 text-slate-600">{item.prompt}</p>
                        </div>
                        <Badge variant="muted" className="shrink-0">{humanDecisionKindLabel(item)}</Badge>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-2 bg-white"
                        onClick={() => leaveReviewFor(() => onNavigateDecisionPhase(item.actionPhaseId))}
                      >
                        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
                        去 {HUMAN_DECISION_PHASE_LABELS[item.actionPhaseId]} 处理
                      </Button>
                    </div>
                  ))}
                </div>
              ) : null}

              {actionableDecisionItems.length > 0 ? (
                <div className="mt-4 space-y-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    在本阶段处理
                  </div>
                  {actionableDecisionItems.map((item) => (
                    <div key={item.id} className="rounded-lg border border-slate-200 bg-white p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-xs font-semibold text-slate-900">{item.id} · {item.title}</div>
                        <Badge variant={item.kind === "decision" ? "warning" : "info"}>
                          {humanDecisionKindLabel(item)}
                        </Badge>
                      </div>
                      <p className="mt-1.5 text-[11px] leading-4 text-slate-600">{item.prompt}</p>
                      <p className="mt-1.5 text-[10px] leading-4 text-slate-500">
                        负责人：{item.owner} · 下一步：{item.nextAction}
                      </p>
                      {item.response ? (
                        <div className="mt-2 rounded-md bg-teal-50 px-2.5 py-2 text-[10px] leading-4 text-teal-800">
                          上次已记录：{item.response}。正式产物仍需由角色更新后才算关闭。
                        </div>
                      ) : null}
                      {item.kind === "decision" ? (
                        <>
                          {humanDecisionPresets(item).length > 0 ? (
                            <div className="mt-2 grid gap-2">
                              {humanDecisionPresets(item).map((preset) => (
                                <button
                                  key={preset.label}
                                  type="button"
                                  className={cn(
                                    "rounded-lg border px-3 py-2 text-left transition",
                                    decisionResponses[item.id] === preset.value
                                      ? "border-teal-500 bg-teal-50 ring-1 ring-teal-500"
                                      : "border-slate-200 bg-slate-50 hover:border-teal-300 hover:bg-teal-50/50",
                                  )}
                                  disabled={decisionCaptureMutation.isPending}
                                  onClick={() => setDecisionResponses((current) => ({
                                    ...current,
                                    [item.id]: preset.value,
                                  }))}
                                >
                                  <span className="block text-xs font-semibold text-slate-900">{preset.label}</span>
                                  <span className="mt-0.5 block text-[10px] leading-4 text-slate-600">{preset.description}</span>
                                </button>
                              ))}
                            </div>
                          ) : null}
                          <Textarea
                            className="mt-2 min-h-24 bg-white text-xs"
                            value={decisionResponses[item.id] ?? ""}
                            disabled={decisionCaptureMutation.isPending}
                            onChange={(event) => setDecisionResponses((current) => ({
                              ...current,
                              [item.id]: event.target.value,
                            }))}
                            placeholder="选择上方建议，或写下明确规则；不要只写“同意”。"
                            aria-label={`回答 ${item.id}`}
                          />
                        </>
                      ) : (
                        <div className="mt-2 rounded-md bg-sky-50 px-2.5 py-2 text-[10px] leading-4 text-sky-800">
                          这不是让你拍板；保存后会退回 {HUMAN_DECISION_ROLE_LABELS[decisionGate.phaseId]} 完成。
                        </div>
                      )}
                    </div>
                  ))}
                  <Button
                    variant="primary"
                    className="w-full"
                    loading={decisionCaptureMutation.isPending}
                    disabled={
                      decisionCaptureMutation.isPending
                      || revisionMutation.isPending
                      || isDirty
                      || dependentDecisionItems.length > 0
                    }
                    onClick={submitDecisionResponses}
                  >
                    <Save className="h-4 w-4" aria-hidden />
                    {actionableDecisionItems.some(({ kind }) => kind === "decision")
                      ? `保存决定并让 ${HUMAN_DECISION_ROLE_LABELS[decisionGate.phaseId]} 更新`
                      : `让 ${HUMAN_DECISION_ROLE_LABELS[decisionGate.phaseId]} 完成待办`}
                  </Button>
                  {dependentDecisionItems.length > 0 ? (
                    <p className="rounded-md bg-amber-100/70 px-2.5 py-2 text-[10px] leading-4 text-amber-900">
                      先处理上游依赖；本阶段变为 Ready 后直接重新运行 {HUMAN_DECISION_ROLE_LABELS[decisionGate.phaseId]}，让它同步最新上游产物并完成自己的待办。
                    </p>
                  ) : null}
                  <p className="text-[10px] leading-4 text-slate-500">
                    保存会记录为“要求修改”，使下游旧结果失效，并立即打开当前角色的重新执行窗口。
                  </p>
                </div>
              ) : null}

              {phase.status === "ready" && (
                dependentDecisionItems.length > 0 || decisionGate.workCount > 0
              ) ? (
                <Button
                  variant="primary"
                  className="mt-4 w-full"
                  disabled={hasPendingReviewWork}
                  onClick={() => leaveReviewFor(() => onDecisionSaved(decisionGate.phaseId))}
                >
                  <RotateCcw className="h-4 w-4" aria-hidden />
                  运行 {HUMAN_DECISION_ROLE_LABELS[decisionGate.phaseId]} 同步并处理清单
                </Button>
              ) : null}

              {!isReviewable && error ? (
                <div role="alert" className="mt-3 rounded-lg border border-rose-200 bg-white px-3 py-2 text-xs leading-5 text-rose-700">
                  {error}
                </div>
              ) : null}
            </section>
          ) : null}
          {selectedEngineeringGuide ? (
            <div className="mb-4 rounded-xl border border-teal-200 bg-teal-50/60 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="info">{selectedEngineeringGuide.stage}</Badge>
                <span className="text-[11px] font-semibold text-teal-800">{selectedEngineeringGuide.timing}</span>
              </div>
              <p className="mt-2 text-xs leading-5 text-slate-700">{selectedEngineeringGuide.purpose}</p>
              <p className="mt-2 rounded-lg bg-white/80 px-3 py-2 text-xs leading-5 text-slate-700 ring-1 ring-teal-100">
                <strong>你只需检查：</strong>{selectedEngineeringGuide.humanCheck}
              </p>
            </div>
          ) : null}
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
              <CheckCircle2 className="h-4 w-4 text-teal-600" aria-hidden />
              审核标准
            </div>
            <p className="mt-2 text-xs leading-5 text-slate-600">
              {definition.gate || "确认产物准确、完整，且足以支持下一角色继续工作。"}
            </p>
          </div>

          {phase.reviews.length ? (
            <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
              <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">审核记录</div>
              <div className="space-y-3">
                {phase.reviews.map((review) => (
                  <div key={review.id} className="border-l-2 border-slate-200 pl-3">
                    <div className="flex items-center gap-2">
                      <Badge variant={review.decision === "approve" ? "success" : "danger"}>
                        {review.decision === "approve" ? "已通过" : "要求修改"}
                      </Badge>
                      <span className="text-[10px] text-slate-400">{formatDate(review.createdAt)}</span>
                    </div>
                    <p className="mt-1.5 text-xs leading-5 text-slate-600">{review.comment}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {isReviewable ? (
            <div className="mt-5">
              {isArchitectureSelectionCheckpoint ? (
                <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">
                  <div className="flex items-center gap-2 font-semibold">
                    <GitBranch className="h-4 w-4" aria-hidden />
                    {decisionGate && decisionGate.blockingCount > 0
                      ? "先做决定，再选方案"
                      : "请选择当前版本的架构方案"}
                  </div>
                  {decisionGate && decisionGate.blockingCount > 0 ? (
                    <p className="mt-1">
                      上方还有具体决定。先保存答案并让 Architect 刷新 options；此时不要继续重跑，也不要提前选方案。
                    </p>
                  ) : (
                    <>
                      <p className="mt-1">
                        选方案不是批准架构。你只是在 A/B/C 中确认方向；保存后 Architect 会生成该方向的正式架构包，再由你做最终审核。
                      </p>
                      <div className="mt-3 grid gap-2">
                        {architectureOptions.map((option) => (
                          <button
                            key={option.id}
                            type="button"
                            className={cn(
                              "rounded-lg border bg-white p-3 text-left transition",
                              architectureSelectionIdInComment === option.id
                                ? "border-teal-500 ring-2 ring-teal-500/20"
                                : "border-amber-200 hover:border-teal-400",
                            )}
                            disabled={hasPendingReviewWork}
                            onClick={() => setComment((current) => (
                              updateArchitectureSelectionMarker(current, option.id)
                            ))}
                          >
                            <span className="flex items-center justify-between gap-2">
                              <span className="font-semibold text-slate-950">Option {option.id} · {option.title}</span>
                              {option.recommended ? <Badge variant="success">Architect 推荐</Badge> : null}
                            </span>
                            {option.summary ? <span className="mt-1 block text-slate-700">{option.summary}</span> : null}
                            {option.optimizes ? <span className="mt-1 block text-[11px] text-slate-600">优势：{option.optimizes}</span> : null}
                            {option.givesUp ? <span className="block text-[11px] text-slate-600">代价：{option.givesUp}</span> : null}
                            <span className="mt-2 block font-semibold text-teal-700">选择 Option {option.id}</span>
                          </button>
                        ))}
                        {currentOptionsQuery.isLoading ? (
                          <span className="text-[11px] text-slate-600">正在读取当前 options…</span>
                        ) : architectureOptions.length === 0 ? (
                          <span className="rounded-md bg-white px-2.5 py-2 text-[11px] text-amber-800">
                            当前 options 还不能解析为选项卡；请让 Architect 按标准标题刷新 options。
                          </span>
                        ) : null}
                      </div>
                    </>
                  )}
                  {missingApprovalOutputKeys.length > 0 ? (
                    <p className="mt-1 text-amber-700">
                      待生成：{missingApprovalOutputKeys.map(artifactLabel).join("、")}
                    </p>
                  ) : null}
                </div>
              ) : staleArchitectureOutputKeys.length > 0 ? (
                <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">
                  {isPartialArchitectureImpactReview
                    ? `以下产物尚未在本次影响评估后更新：${staleArchitectureOutputKeys.map(artifactLabel).join("、")}。请完成本次局部更新后再提交批准。`
                    : `已记录 Option ${architectureSelection?.optionId}，但以下产物仍早于该选型：${staleArchitectureOutputKeys.map(artifactLabel).join("、")}。请执行选型后的默认输出集，再提交批准。`}
                </div>
              ) : null}
              <Field label="审核意见" hint="必填" required>
                <Textarea
                  className="min-h-32 bg-white"
                  placeholder={
                    isArchitectureSelectionCheckpoint
                      ? "Selected option: B\n条件：先验证外部依赖的限流能力。"
                      : phase.phaseId === "implementation"
                        ? "例如：已核对实现、自动化测试与风险，无未解决工程阻塞，同意进入 Tester。"
                      : "记录你的判断，或者准确描述需要修改的地方…"
                  }
                  value={comment}
                  disabled={hasPendingReviewWork}
                  onChange={(event) => setComment(event.target.value)}
                  required
                  aria-required="true"
                  aria-invalid={Boolean(error || engineeringGateHelp)}
                  aria-describedby={error || engineeringGateHelp ? "review-comment-error" : undefined}
                />
              </Field>
              {architectureReselectionBlocked ? (
                <div
                  role="alert"
                  className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-900"
                >
                  局部更新不能重新选型，请完整重跑。请删除 Selected option 标记后提交普通修改意见。
                </div>
              ) : null}
              {error ? (
                <div
                  id="review-comment-error"
                  role="alert"
                  className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-xs leading-5 text-rose-700"
                >
                  {error}
                </div>
              ) : null}
              {engineeringGateHelp ? (
                <div
                  id="review-comment-error"
                  role="alert"
                  className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3.5 text-xs leading-5 text-amber-950"
                >
                  <div className="font-semibold">{engineeringGateHelp.title}</div>
                  <p className="mt-1 text-amber-900">{engineeringGateHelp.summary}</p>
                  <div className="mt-3 rounded-lg border border-amber-300 bg-amber-100/70 px-3 py-2.5">
                    <div className="font-semibold">推荐下一步：{engineeringGateHelp.recommendation.title}</div>
                    <p className="mt-0.5 text-amber-900">{engineeringGateHelp.recommendation.description}</p>
                    <Button
                      type="button"
                      size="sm"
                      className="mt-2"
                      onClick={() => {
                        if (engineeringGateHelp.recommendation.kind === "repair-upstream") {
                          leaveReviewFor(() => onNavigateDecisionPhase("discovery"));
                          return;
                        }
                        leaveReviewFor(() => onRerunOutputs(
                          engineeringGateHelp.recommendation.outputKeys,
                        ));
                      }}
                    >
                      <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                      {engineeringGateHelp.recommendation.kind === "repair-evidence"
                        ? `让 Software Engineer 只修复这 ${engineeringGateHelp.affectedArtifactKeys.length} 份证据`
                        : engineeringGateHelp.recommendation.title}
                    </Button>
                  </div>
                  <ol className="mt-3 space-y-2">
                    {engineeringGateHelp.actions.map((action, index) => {
                      const targetArtifact = action.artifactKey
                        ? phase.artifacts.find((candidate) => keyForArtifact(candidate) === action.artifactKey)
                        : undefined;
                      return (
                        <li key={action.id} className="rounded-lg bg-white/80 px-3 py-2 ring-1 ring-amber-200/80">
                          <div className="font-semibold">
                            {index + 1}. {action.title} · {action.issueCount} 项
                          </div>
                          <p className="mt-0.5 text-amber-900">{action.description}</p>
                          <ul className="mt-1.5 space-y-1 text-amber-950">
                            {action.reasons.map((reason) => (
                              <li key={reason} className="flex gap-1.5">
                                <span aria-hidden>•</span>
                                <span>{reason}</span>
                              </li>
                            ))}
                          </ul>
                          {targetArtifact || (
                            action.artifactKey
                            && engineeringGateHelp.recommendation.kind === "repair-evidence"
                          ) ? (
                            <div className="mt-2 flex flex-wrap gap-3">
                              {targetArtifact ? (
                                <button
                                  type="button"
                                  className="font-semibold text-teal-700 underline underline-offset-4"
                                  onClick={() => changeArtifact(targetArtifact.id)}
                                >
                                  查看{artifactLabel(action.artifactKey ?? "")}
                                </button>
                              ) : null}
                              {action.artifactKey
                              && engineeringGateHelp.recommendation.kind === "repair-evidence" ? (
                                <button
                                  type="button"
                                  className="font-semibold text-teal-700 underline underline-offset-4"
                                  onClick={() => leaveReviewFor(() => onRerunOutputs([
                                    action.artifactKey!,
                                  ]))}
                                >
                                  只重跑这 1 份证据
                                </button>
                              ) : null}
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ol>
                  {engineeringGateHelp.diagnostics.length > 0 ? (
                    <details className="mt-3">
                      <summary className="cursor-pointer font-semibold">
                        全部 {engineeringGateHelp.issueCount} 条原始校验信息（开发者详情）
                      </summary>
                      <ul className="mt-1.5 space-y-1 font-mono text-[10px] leading-4 text-amber-800">
                        {engineeringGateHelp.diagnostics.map((diagnostic, index) => (
                          <li key={`${index}-${diagnostic}`}>• {diagnostic}</li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </div>
              ) : null}
              <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Button
                  variant={showsArchitectureSelectionAction ? "primary" : "destructive"}
                  className="h-auto min-h-10 whitespace-normal px-2 py-2"
                  loading={
                    reviewMutation.isPending
                    && reviewMutation.variables?.decision === "request_changes"
                  }
                  disabled={
                    hasPendingReviewWork
                    || isDirty
                    || architectureReselectionBlocked
                    || Boolean(
                      architectureSelectionIdInComment
                      && decisionGate
                      && decisionGate.blockingCount > 0
                    )
                  }
                  onClick={() => submit("request_changes")}
                >
                  {showsArchitectureSelectionAction ? (
                    <GitBranch className="h-4 w-4" aria-hidden />
                  ) : (
                    <XCircle className="h-4 w-4" aria-hidden />
                  )}
                  {showsArchitectureSelectionAction ? "记录选型并继续" : "要求修改"}
                </Button>
                <Button
                  variant="success"
                  className="h-auto min-h-10 whitespace-normal px-2 py-2"
                  loading={
                    reviewMutation.isPending
                    && reviewMutation.variables?.decision === "approve"
                  }
                  disabled={
                    hasPendingReviewWork
                    || isDirty
                    || unviewedArtifactHeads.length > 0
                    || missingApprovalOutputKeys.length > 0
                    || isArchitectureSelectionCheckpoint
                    || staleArchitectureOutputKeys.length > 0
                    || Boolean(decisionGate && decisionGate.blockingCount > 0)
                  }
                  onClick={() => submit("approve")}
                >
                  <CheckCircle2 className="h-4 w-4" aria-hidden />
                  {phase.phaseId === "implementation"
                    ? "检查证据并解锁 Tester"
                    : phase.phaseId === "release"
                      ? "确认发布准备已就绪"
                      : "通过并解锁"}
                </Button>
              </div>
            </div>
          ) : phase.status === "approved" ? (
            <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-xs leading-5 text-emerald-800">
              <div className="flex items-center gap-2 font-semibold">
                <FileCheck2 className="h-4 w-4" aria-hidden />
                {phase.phaseId === "release" ? "发布准备材料已完成审核" : "本阶段已完成审核"}
              </div>
              <p className="mt-1">
                {phase.phaseId === "release"
                  ? RELEASE_COMPLETION_BOUNDARY
                  : "可以继续创建人工修订，或只重跑需要调整的当前产物。"}
              </p>
            </div>
          ) : phase.status === "changes_requested" || phase.status === "rejected" ? (
            <div className="mt-5 rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs leading-5 text-rose-800">
              <div className="flex items-center gap-2 font-semibold">
                <RotateCcw className="h-4 w-4" aria-hidden />
                本阶段已要求修改
              </div>
              <p className="mt-1">可以直接人工修订，或根据审核意见仅重跑当前产物。</p>
            </div>
          ) : phase.status === "failed" ? (
            <div className="mt-5 rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs leading-5 text-rose-800">
              <div className="flex items-center gap-2 font-semibold">
                <AlertCircle className="h-4 w-4" aria-hidden />
                上次执行失败
              </div>
              <p className="mt-1">现有产物仍可人工修订，或只重跑需要恢复的当前产物。</p>
            </div>
          ) : (
            <div className="mt-5 rounded-xl border border-slate-200 bg-white p-4 text-xs leading-5 text-slate-600">
              <div className="flex items-center gap-2 font-semibold text-slate-700">
                <FileText className="h-4 w-4" aria-hidden />
                当前状态：{STATUS_LABELS[phase.status] ?? phase.status}
              </div>
              <p className="mt-1">
                {phase.status === "ready"
                  ? "阶段已就绪；可以人工修订现有产物，或选择局部范围重新执行。"
                  : "当前状态仅支持查看，阶段解锁后才能编辑或重跑产物。"}
              </p>
            </div>
          )}
        </aside>
      </div>
    </Dialog>
  );
}
