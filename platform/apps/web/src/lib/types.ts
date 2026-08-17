export type PhaseStatus =
  | "pending"
  | "locked"
  | "ready"
  | "running"
  | "awaiting_review"
  | "approved"
  | "changes_requested"
  | "rejected"
  | "failed";

export type ReviewDecision = "approve" | "request_changes";

export type TicketStatus = "backlog" | "todo" | "in_progress" | "done";

export interface HealthStatus {
  status: "ok";
  runner: {
    mode: "real" | "fake";
    command: string;
  };
}

export interface FigmaIntegrationStatus {
  provider: "figma";
  state: "ready" | "authorization_required" | "not_configured" | "unavailable";
  serverName: string | null;
  message: string;
  authorizationUrl: string | null;
}

export interface FigmaPlanCapability {
  key: string;
  name: string;
  seat: string;
  tier: string;
  writable: boolean;
}

export interface FigmaPlanCapabilities {
  provider: "figma";
  plans: FigmaPlanCapability[];
}

export type FigmaTarget =
  | {
      mode: "new_private_draft";
      planKey: string;
      fileName: string;
    }
  | {
      mode: "existing_file";
      fileUrl: string;
    };

export type CodexReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";

export interface CodexModelCapability {
  id: string;
  name: string;
  defaultReasoningEffort: CodexReasoningEffort;
  reasoningEfforts: CodexReasoningEffort[];
}

export interface CodexCapabilities {
  models: CodexModelCapability[];
  defaultModel: string;
  defaultReasoningEffort: CodexReasoningEffort;
}

export interface Project {
  id: string;
  name: string;
  summary?: string;
  rootPath: string;
  workspacePath?: string;
  initialized?: boolean;
  createdAt?: string;
  updatedAt?: string;
  runCount?: number;
}

export interface RoleDefinition {
  id: string;
  name: string;
  mission?: string;
  responsibilities?: string[];
}

export interface PhaseDefinition {
  id: string;
  name?: string;
  owner: string;
  inputs: string[];
  outputs: string[];
  gate?: string;
}

export interface ArtifactDefinition {
  id: string;
  owner?: string;
  path?: string;
}

export interface WorkflowDefinition {
  version?: number;
  project?: { name: string; summary: string; locale?: string };
  roles: RoleDefinition[];
  phases: PhaseDefinition[];
  artifacts?: ArtifactDefinition[];
}

export interface Artifact {
  id: string;
  phaseRunId?: string;
  artifactKey?: string;
  filePath?: string;
  contentHash?: string;
  artifactId?: string;
  type?: string;
  name?: string;
  path?: string;
  content?: string;
  phaseId?: string;
  reviewStatus?: "pending" | "approved" | "changes_requested" | "superseded";
  revision?: number;
  revisionSource?: "ai" | "human";
  parentArtifactId?: string | null;
  superseded?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateArtifactRevisionInput {
  content: string;
  expectedContentHash: string;
}

export interface Review {
  id: string;
  phaseRunId?: string;
  decision: ReviewDecision;
  comment?: string;
  createdAt?: string;
  reviewer?: string;
}

export interface Execution {
  id: string;
  phaseRunId?: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  command?: string;
  error?: string;
  exitCode?: number | null;
  selectedArtifactIds?: string[];
  selectedOutputKeys?: string[];
  model?: string | null;
  reasoningEffort?: CodexReasoningEffort | null;
  startedAt?: string;
  finishedAt?: string;
  createdAt?: string;
}

export interface RunEvent {
  id: string;
  executionId?: string;
  sequence?: number;
  eventType?: string;
  payload?: unknown;
  type?: string;
  message?: string;
  createdAt?: string;
  timestamp?: string;
  data?: Record<string, unknown>;
}

export interface PhaseRun {
  id?: string;
  workflowRunId?: string;
  position?: number;
  phaseId: string;
  status: PhaseStatus;
  artifacts: Artifact[];
  reviews: Review[];
  executions: Execution[];
  events: RunEvent[];
  selectedArtifactIds?: string[];
  availableArtifacts?: Artifact[];
  error?: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt?: string;
}

export interface WorkflowRun {
  id: string;
  projectId: string;
  title: string;
  objective?: string;
  brief?: string;
  status?: "active" | "completed" | "failed";
  currentPhaseId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface TicketSummary {
  id: string;
  workflowRunId: string;
  sourceArtifactId: string | null;
  identifier: string;
  title: string;
  category: string;
  sourcePath: string;
  status: TicketStatus;
  acceptanceCriteriaCount: number;
  sourceReviewStatus: "pending" | "approved" | "changes_requested" | "superseded" | null;
  createdAt: string;
  updatedAt: string;
}

export interface TicketDetail extends TicketSummary {
  content: string;
}

export interface ProjectDetail {
  project: Project;
  definition: WorkflowDefinition;
}

export interface RunDetail {
  run: WorkflowRun;
  project: Project;
  definition: WorkflowDefinition;
  phases: PhaseRun[];
}

export interface CreateProjectInput {
  name: string;
  summary: string;
  rootPath: string;
  initialize: boolean;
}

export interface CreateRunInput {
  title: string;
  objective: string;
}

export interface ApiErrorPayload {
  message?: string;
  error?: string;
  details?: string;
}
