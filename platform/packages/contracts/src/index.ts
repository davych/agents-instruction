import { z } from "zod";

export const PHASE_IDS = [
  "discovery",
  "design",
  "architecture",
  "implementation",
  "verification",
  "release"
] as const;

export const phaseIdSchema = z.enum(PHASE_IDS);
export type PhaseId = z.infer<typeof phaseIdSchema>;

export const phaseStatusSchema = z.enum([
  "pending",
  "ready",
  "running",
  "awaiting_review",
  "approved",
  "changes_requested",
  "failed"
]);
export type PhaseStatus = z.infer<typeof phaseStatusSchema>;

export const reviewDecisionSchema = z.enum(["approve", "request_changes"]);
export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;

export const ticketStatusSchema = z.enum(["backlog", "todo", "in_progress", "done"]);
export type TicketStatus = z.infer<typeof ticketStatusSchema>;

export const updateTicketStatusSchema = z.object({
  status: ticketStatusSchema
});
export type UpdateTicketStatusInput = z.infer<typeof updateTicketStatusSchema>;

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(160).regex(/^[^\r\n]+$/u, "项目名称不能换行"),
  summary: z.string().trim().max(2_000).default("由 AI SDLC 平台管理的项目"),
  rootPath: z.string().trim().min(1),
  initialize: z.boolean().default(false)
});
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const workTypeSchema = z.enum(["feature", "change", "bug", "technical"]);
export type WorkType = z.infer<typeof workTypeSchema>;

const changeContractTextSchema = z.string()
  .trim()
  .min(1)
  .max(10_000)
  .regex(/^[^\u0000]*$/u, "变更合同文本不能包含空字符");

const changeContractListItemSchema = z.string()
  .trim()
  .min(1)
  .max(2_000)
  .regex(/^[^\u0000]*$/u, "变更合同条目不能包含空字符");

const uniqueChangeContractList = (minimum: number, maximum: number, fieldName: string) =>
  z.array(changeContractListItemSchema)
    .min(minimum)
    .max(maximum)
    .refine((items) => new Set(items).size === items.length, `${fieldName} 不能重复`);

const sourceRunIdsSchema = z.array(z.string().uuid())
  .min(1, "至少选择一个原始任务")
  .max(20)
  .refine((ids) => new Set(ids).size === ids.length, "sourceRunIds 不能重复");

/**
 * The immutable, run-scoped contract for one unit of work. Product/design/
 * architecture roles may be routed around, but this evidence is never skipped.
 */
export const changeContractSchema = z.object({
  workType: workTypeSchema,
  sourceRunIds: sourceRunIdsSchema.optional(),
  summary: changeContractTextSchema.max(2_000),
  currentBehavior: changeContractTextSchema.max(5_000),
  expectedBehavior: changeContractTextSchema.max(5_000),
  inScope: uniqueChangeContractList(1, 100, "inScope"),
  outOfScope: uniqueChangeContractList(0, 100, "outOfScope"),
  acceptanceCriteria: uniqueChangeContractList(1, 100, "acceptanceCriteria"),
  regressionScope: uniqueChangeContractList(1, 100, "regressionScope"),
  riskFlags: uniqueChangeContractList(0, 50, "riskFlags"),
  evidenceRefs: uniqueChangeContractList(0, 100, "evidenceRefs")
}).strict().superRefine((contract, context) => {
  if (contract.workType === "feature" && contract.sourceRunIds) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceRunIds"],
      message: "新功能不能关联原始任务",
    });
  }
});
export type ChangeContract = z.infer<typeof changeContractSchema>;
export type ChangeContractDto = ChangeContract;

const runTitleSchema = z.string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\u0000-\u001f\u007f]+$/u, "任务名称不能包含控制字符");

const legacyCreateRunSchema = z.object({
  title: runTitleSchema,
  objective: z.string().trim().min(1).max(10_000),
  // Optional for backward compatibility. New clients should always submit it.
  changeContract: changeContractSchema.optional()
}).strict();

const linkedCreateRunSchema = z.object({
  title: runTitleSchema,
  workType: z.enum(["change", "bug", "technical"]),
  sourceRunIds: sourceRunIdsSchema,
  expectedBehavior: z.string()
    .trim()
    .min(1, "请填写期望行为")
    .max(2_000)
    .regex(/^[^\u0000]*$/u, "期望行为不能包含空字符"),
}).strict();

export const createRunSchema = z.union([linkedCreateRunSchema, legacyCreateRunSchema]);
export type CreateRunInput = z.infer<typeof createRunSchema>;

export const createArtifactRevisionSchema = z.object({
  content: z.string()
    .min(1)
    .max(2_000_000)
    .refine((value) => value.trim().length > 0, "产物内容不能为空"),
  expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/u, "产物版本哈希无效")
});
export type CreateArtifactRevisionInput = z.infer<typeof createArtifactRevisionSchema>;

const artifactKeySchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);

export const CODEX_REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra"
] as const;

export const codexReasoningEffortSchema = z.enum(CODEX_REASONING_EFFORTS);
export type CodexReasoningEffort = z.infer<typeof codexReasoningEffortSchema>;

export const codexRunnerModeSchema = z.enum(["real", "fake"]);
export type CodexRunnerMode = z.infer<typeof codexRunnerModeSchema>;

export const codexModelSchema = z.string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u, "Codex model 标识无效");

const figmaPlanKeySchema = z.string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*::[a-zA-Z0-9_-]+$/u, "Figma planKey 无效");

export const figmaTargetSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("new_private_draft"),
    planKey: figmaPlanKeySchema,
    fileName: z.string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[^\u0000-\u001f\u007f]+$/u, "Figma 文件名不能包含控制字符")
  }),
  z.object({
    mode: z.literal("existing_file"),
    fileUrl: z.string().trim().url().max(2_048)
  })
]);
export type FigmaTarget = z.infer<typeof figmaTargetSchema>;

export const executePhaseSchema = z.object({
  selectedArtifactIds: z.array(z.string().uuid()).default([]),
  selectedOutputKeys: z.array(artifactKeySchema).min(1).optional(),
  model: codexModelSchema.optional(),
  reasoningEffort: codexReasoningEffortSchema.optional(),
  figmaTarget: figmaTargetSchema.optional()
});
export type ExecutePhaseInput = z.infer<typeof executePhaseSchema>;

export const codexModelCapabilitySchema = z.object({
  id: codexModelSchema,
  name: z.string().trim().min(1).max(160),
  defaultReasoningEffort: codexReasoningEffortSchema,
  reasoningEfforts: z.array(codexReasoningEffortSchema).min(1)
});
export type CodexModelCapabilityDto = z.infer<typeof codexModelCapabilitySchema>;

export const codexExecutionCapabilitiesSchema = z.object({
  models: z.array(codexModelCapabilitySchema).min(1),
  defaultModel: codexModelSchema,
  defaultReasoningEffort: codexReasoningEffortSchema
});
export type CodexExecutionCapabilitiesDto = z.infer<typeof codexExecutionCapabilitiesSchema>;

export const figmaIntegrationStateSchema = z.enum([
  "ready",
  "authorization_required",
  "not_configured",
  "unavailable"
]);
export type FigmaIntegrationState = z.infer<typeof figmaIntegrationStateSchema>;

export const figmaIntegrationStatusSchema = z.object({
  provider: z.literal("figma"),
  state: figmaIntegrationStateSchema,
  serverName: z.string().trim().min(1).nullable(),
  message: z.string().trim().min(1),
  authorizationUrl: z.string().url().nullable()
});
export type FigmaIntegrationStatusDto = z.infer<typeof figmaIntegrationStatusSchema>;

export const figmaPlanCapabilitySchema = z.object({
  key: figmaPlanKeySchema,
  name: z.string().trim().min(1).max(160),
  seat: z.string().trim().min(1).max(80),
  tier: z.string().trim().min(1).max(80),
  writable: z.boolean()
});
export type FigmaPlanCapabilityDto = z.infer<typeof figmaPlanCapabilitySchema>;

export const figmaPlanCapabilitiesSchema = z.object({
  provider: z.literal("figma"),
  plans: z.array(figmaPlanCapabilitySchema).max(100)
});
export type FigmaPlanCapabilitiesDto = z.infer<typeof figmaPlanCapabilitiesSchema>;

export const reviewPhaseSchema = z.object({
  decision: reviewDecisionSchema,
  comment: z.string().trim().min(1).max(10_000),
  expectedArtifactIds: z.array(z.string().uuid()).min(1).max(100)
    .refine((ids) => new Set(ids).size === ids.length, "expectedArtifactIds 不能重复")
});
export type ReviewPhaseInput = z.infer<typeof reviewPhaseSchema>;

export const architectureImpactModeSchema = z.enum(["reuse", "partial"]);
export type ArchitectureImpactMode = z.infer<typeof architectureImpactModeSchema>;

export const architectureSelectionEvidenceSchema = z.object({
  optionId: z.string().trim().min(1).max(160),
  reviewId: z.string().uuid(),
  optionsArtifactId: z.string().uuid(),
  selectedAt: z.string().datetime({ offset: true })
}).strict();
export type ArchitectureSelectionEvidenceDto = z.infer<typeof architectureSelectionEvidenceSchema>;

export const assessArchitectureImpactSchema = z.object({
  mode: architectureImpactModeSchema,
  rationale: z.string().trim().min(10).max(2_000),
  selectedArtifactIds: z.array(z.string().uuid()).min(1).max(100)
    .refine((ids) => new Set(ids).size === ids.length, "selectedArtifactIds 不能重复"),
  expectedBaselineArtifactIds: z.array(z.string().uuid()).min(1).max(100)
    .refine((ids) => new Set(ids).size === ids.length, "expectedBaselineArtifactIds 不能重复"),
  affectedOutputKeys: z.array(artifactKeySchema).max(100).default([])
    .refine((keys) => new Set(keys).size === keys.length, "affectedOutputKeys 不能重复")
}).strict().superRefine((input, context) => {
  if (input.mode === "reuse" && input.affectedOutputKeys.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["affectedOutputKeys"],
      message: "复用现有架构时不能声明待更新产物"
    });
  }
  if (input.mode === "partial" && !input.affectedOutputKeys.includes("architecture")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["affectedOutputKeys"],
      message: "局部架构更新必须包含 architecture 索引"
    });
  }
});
export type AssessArchitectureImpactInput = z.infer<typeof assessArchitectureImpactSchema>;

export const architectureImpactSchema = z.object({
  mode: architectureImpactModeSchema,
  rationale: z.string().trim().min(10).max(2_000),
  sourceRunId: z.string().uuid(),
  sourceRunTitle: z.string().trim().min(1).max(200),
  sourcePhaseRunId: z.string().uuid(),
  sourceArtifactIds: z.array(z.string().uuid()).min(1).max(100)
    .refine((ids) => new Set(ids).size === ids.length, "sourceArtifactIds 不能重复"),
  inputArtifactIds: z.array(z.string().uuid()).min(1).max(100)
    .refine((ids) => new Set(ids).size === ids.length, "inputArtifactIds 不能重复"),
  affectedOutputKeys: z.array(artifactKeySchema).max(100)
    .refine((keys) => new Set(keys).size === keys.length, "affectedOutputKeys 不能重复"),
  assessedAt: z.string().datetime({ offset: true }),
  selection: architectureSelectionEvidenceSchema
}).strict().superRefine((impact, context) => {
  if (impact.mode === "reuse" && impact.affectedOutputKeys.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["affectedOutputKeys"],
      message: "复用现有架构时不能声明待更新产物"
    });
  }
  if (impact.mode === "partial" && !impact.affectedOutputKeys.includes("architecture")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["affectedOutputKeys"],
      message: "局部架构更新必须包含 architecture 索引"
    });
  }
});
export type ArchitectureImpactDto = z.infer<typeof architectureImpactSchema>;

export const productImpactModeSchema = z.enum(["direct", "reuse", "partial", "full"]);
export type ProductImpactMode = z.infer<typeof productImpactModeSchema>;

export const designImpactModeSchema = z.enum(["skip", "reuse", "partial", "full"]);
export type DesignImpactMode = z.infer<typeof designImpactModeSchema>;

export const architectureDispositionModeSchema = z.enum(["skip", "reuse", "partial", "full"]);
export type ArchitectureDispositionMode = z.infer<typeof architectureDispositionModeSchema>;

export const phaseDispositionSchema = z.enum(["skip", "direct", "reuse", "partial", "full"]);
export type PhaseDisposition = z.infer<typeof phaseDispositionSchema>;

export const PHASE_ROUTE_VERSION = 1 as const;

const uniqueUuidList = (minimum: number, maximum: number, fieldName: string) =>
  z.array(z.string().uuid())
    .min(minimum)
    .max(maximum)
    .refine((ids) => new Set(ids).size === ids.length, `${fieldName} 不能重复`);

const uniqueArtifactKeyList = (minimum: number, maximum: number, fieldName: string) =>
  z.array(artifactKeySchema)
    .min(minimum)
    .max(maximum)
    .refine((keys) => new Set(keys).size === keys.length, `${fieldName} 不能重复`);

type ResolvablePhaseId = "discovery" | "design" | "architecture";
type ResolutionMode = ProductImpactMode | DesignImpactMode | ArchitectureDispositionMode;

function phaseResolutionObject<
  const TPhaseId extends ResolvablePhaseId,
  const TMode extends ResolutionMode
>(
  phaseId: TPhaseId,
  mode: TMode,
  source: "required" | "none",
  affected: "required" | "none",
  minimumInputs: 0 | 1
) {
  return z.object({
    phaseId: z.literal(phaseId),
    mode: z.literal(mode),
    rationale: z.string().trim().min(10).max(2_000),
    inputArtifactIds: uniqueUuidList(minimumInputs, 100, "inputArtifactIds"),
    sourceRunId: source === "required" ? z.string().uuid() : z.null(),
    sourceRunTitle: source === "required"
      ? z.string().trim().min(1).max(200)
      : z.null(),
    sourcePhaseRunId: source === "required" ? z.string().uuid() : z.null(),
    sourceArtifactIds: source === "required"
      ? uniqueUuidList(1, 100, "sourceArtifactIds")
      : uniqueUuidList(0, 0, "sourceArtifactIds"),
    affectedOutputKeys: affected === "required"
      ? uniqueArtifactKeyList(1, 100, "affectedOutputKeys")
      : uniqueArtifactKeyList(0, 0, "affectedOutputKeys"),
    routeVersion: z.literal(PHASE_ROUTE_VERSION),
    decidedAt: z.string().datetime({ offset: true })
  }).strict();
}

/** Product/BA routing. `direct` approves the run contract without invoking PM/BA. */
export const productImpactSchema = z.discriminatedUnion("mode", [
  phaseResolutionObject("discovery", "direct", "none", "none", 0),
  phaseResolutionObject("discovery", "reuse", "required", "none", 0),
  phaseResolutionObject("discovery", "partial", "required", "required", 0)
]);
export type ProductImpactDto = z.infer<typeof productImpactSchema>;

/** Design routing. `skip` is an auditable no-design-work decision, not missing data. */
export const designImpactSchema = z.discriminatedUnion("mode", [
  phaseResolutionObject("design", "skip", "none", "none", 1),
  phaseResolutionObject("design", "reuse", "required", "none", 1),
  phaseResolutionObject("design", "partial", "required", "required", 1)
]);
export type DesignImpactDto = z.infer<typeof designImpactSchema>;

/** Generic architecture routing view; the existing ArchitectureImpactDto remains canonical. */
export const architecturePhaseResolutionSchema = z.discriminatedUnion("mode", [
  phaseResolutionObject("architecture", "skip", "none", "none", 1),
  phaseResolutionObject("architecture", "reuse", "required", "none", 1),
  phaseResolutionObject("architecture", "partial", "required", "required", 1)
]);
export type ArchitecturePhaseResolutionDto = z.infer<typeof architecturePhaseResolutionSchema>;

export const phaseResolutionSchema = z.union([
  productImpactSchema,
  designImpactSchema,
  architecturePhaseResolutionSchema
]);
export type PhaseResolutionDto = z.infer<typeof phaseResolutionSchema>;

export function architectureImpactToPhaseResolution(
  impact: ArchitectureImpactDto
): ArchitecturePhaseResolutionDto {
  return architecturePhaseResolutionSchema.parse({
    phaseId: "architecture",
    mode: impact.mode,
    rationale: impact.rationale,
    inputArtifactIds: impact.inputArtifactIds,
    sourceRunId: impact.sourceRunId,
    sourceRunTitle: impact.sourceRunTitle,
    sourcePhaseRunId: impact.sourcePhaseRunId,
    sourceArtifactIds: impact.sourceArtifactIds,
    affectedOutputKeys: impact.affectedOutputKeys,
    routeVersion: PHASE_ROUTE_VERSION,
    decidedAt: impact.assessedAt
  });
}

const productAssessmentFields = {
  rationale: z.string().trim().min(10).max(2_000),
  selectedArtifactIds: uniqueUuidList(0, 100, "selectedArtifactIds")
};

const designAssessmentFields = {
  rationale: z.string().trim().min(10).max(2_000),
  selectedArtifactIds: uniqueUuidList(1, 100, "selectedArtifactIds")
};

export const assessProductImpactSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("direct"),
    ...productAssessmentFields,
    expectedBaselineArtifactIds: uniqueUuidList(0, 0, "expectedBaselineArtifactIds"),
    affectedOutputKeys: uniqueArtifactKeyList(0, 0, "affectedOutputKeys")
  }).strict(),
  z.object({
    mode: z.literal("reuse"),
    ...productAssessmentFields,
    expectedBaselineArtifactIds: uniqueUuidList(1, 100, "expectedBaselineArtifactIds"),
    affectedOutputKeys: uniqueArtifactKeyList(0, 0, "affectedOutputKeys")
  }).strict(),
  z.object({
    mode: z.literal("partial"),
    ...productAssessmentFields,
    expectedBaselineArtifactIds: uniqueUuidList(1, 100, "expectedBaselineArtifactIds"),
    affectedOutputKeys: uniqueArtifactKeyList(1, 100, "affectedOutputKeys")
  }).strict(),
]);
export type AssessProductImpactInput = z.infer<typeof assessProductImpactSchema>;

export const assessDesignImpactSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("skip"),
    ...designAssessmentFields,
    expectedBaselineArtifactIds: uniqueUuidList(0, 0, "expectedBaselineArtifactIds"),
    affectedOutputKeys: uniqueArtifactKeyList(0, 0, "affectedOutputKeys")
  }).strict(),
  z.object({
    mode: z.literal("reuse"),
    ...designAssessmentFields,
    expectedBaselineArtifactIds: uniqueUuidList(1, 100, "expectedBaselineArtifactIds"),
    affectedOutputKeys: uniqueArtifactKeyList(0, 0, "affectedOutputKeys")
  }).strict(),
  z.object({
    mode: z.literal("partial"),
    ...designAssessmentFields,
    expectedBaselineArtifactIds: uniqueUuidList(1, 100, "expectedBaselineArtifactIds"),
    affectedOutputKeys: uniqueArtifactKeyList(1, 100, "affectedOutputKeys")
  }).strict(),
]);
export type AssessDesignImpactInput = z.infer<typeof assessDesignImpactSchema>;

/** Explicit no-architecture-work decision for bugs/technical work without a baseline. */
export const assessArchitectureWaiverSchema = z.object({
  mode: z.literal("skip"),
  rationale: z.string().trim().min(10).max(2_000),
  selectedArtifactIds: uniqueUuidList(1, 100, "selectedArtifactIds"),
  expectedBaselineArtifactIds: uniqueUuidList(0, 0, "expectedBaselineArtifactIds"),
  affectedOutputKeys: uniqueArtifactKeyList(0, 0, "affectedOutputKeys")
}).strict();
export type AssessArchitectureWaiverInput = z.infer<typeof assessArchitectureWaiverSchema>;

/** Parser for the architecture impact endpoint, including an explicit skip waiver. */
export const assessArchitectureDispositionSchema = z.union([
  assessArchitectureImpactSchema,
  assessArchitectureWaiverSchema
]);
export type AssessArchitectureDispositionInput = z.infer<
  typeof assessArchitectureDispositionSchema
>;

export interface RoleDefinition {
  id: string;
  name: string;
  mission: string;
  responsibilities: string[];
}

export interface PhaseDefinition {
  id: PhaseId;
  owner: string;
  inputs: string[];
  outputs: string[];
  gate: string;
}

export interface WorkflowDefinition {
  version: number;
  project: { name: string; summary: string; locale?: string };
  roles: RoleDefinition[];
  phases: PhaseDefinition[];
}

export interface ProjectDto {
  id: string;
  name: string;
  summary: string;
  rootPath: string;
  configPath: string;
  runCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactDto {
  id: string;
  phaseRunId: string;
  artifactKey: string;
  filePath: string;
  content?: string;
  contentHash: string;
  reviewStatus: "pending" | "approved" | "changes_requested" | "superseded";
  revision: number;
  revisionSource: "ai" | "human";
  parentArtifactId: string | null;
  createdAt: string;
}

export interface ReviewDto {
  id: string;
  phaseRunId: string;
  decision: ReviewDecision;
  comment: string;
  artifactIds: string[];
  createdAt: string;
}

export interface ExecutionEventDto {
  id: string;
  executionId: string;
  sequence: number;
  eventType: string;
  payload: unknown;
  createdAt: string;
}

export interface ExecutionDto {
  id: string;
  phaseRunId: string;
  status: "queued" | "running" | "completed" | "failed";
  selectedArtifactIds: string[];
  selectedOutputKeys: string[];
  runnerMode: CodexRunnerMode | null;
  model: string | null;
  reasoningEffort: CodexReasoningEffort | null;
  command: string;
  exitCode: number | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface ArchitectureBaselineDto {
  sourceRunId: string;
  sourceRunTitle: string;
  sourcePhaseRunId: string;
  approvedAt: string;
  artifacts: Array<{
    id: string;
    artifactKey: string;
    contentHash: string;
  }>;
  selection: ArchitectureSelectionEvidenceDto;
}

export interface PhaseBaselineDto<
  TPhaseId extends "discovery" | "design" = "discovery" | "design"
> {
  phaseId: TPhaseId;
  sourceRunId: string;
  sourceRunTitle: string;
  sourcePhaseRunId: string;
  approvedAt: string;
  artifacts: Array<{
    id: string;
    artifactKey: string;
    contentHash: string;
  }>;
}

export type ProductBaselineDto = PhaseBaselineDto<"discovery">;
export type DesignBaselineDto = PhaseBaselineDto<"design">;

export interface PhaseRunDto {
  id: string;
  workflowRunId: string;
  phaseId: PhaseId;
  position: number;
  status: PhaseStatus;
  artifacts: ArtifactDto[];
  reviews: ReviewDto[];
  executions: ExecutionDto[];
  events: ExecutionEventDto[];
  availableArtifacts: ArtifactDto[];
  resolution?: PhaseResolutionDto | null;
  architectureImpact?: ArchitectureImpactDto | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRunDto {
  id: string;
  projectId: string;
  title: string;
  objective: string;
  changeContract?: ChangeContractDto | null;
  status: "active" | "completed";
  createdAt: string;
  updatedAt: string;
}

export interface TicketSummaryDto {
  id: string;
  workflowRunId: string;
  sourceArtifactId: string | null;
  identifier: string;
  title: string;
  category: string;
  sourcePath: string;
  status: TicketStatus;
  acceptanceCriteriaCount: number;
  sourceReviewStatus: ArtifactDto["reviewStatus"] | null;
  createdAt: string;
  updatedAt: string;
}

export interface TicketDto extends TicketSummaryDto {
  content: string;
}
