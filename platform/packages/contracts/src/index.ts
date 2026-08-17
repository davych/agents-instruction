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

export const createRunSchema = z.object({
  title: z.string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\u0000-\u001f\u007f]+$/u, "任务名称不能包含控制字符"),
  objective: z.string().trim().min(1).max(10_000)
});
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
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRunDto {
  id: string;
  projectId: string;
  title: string;
  objective: string;
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
