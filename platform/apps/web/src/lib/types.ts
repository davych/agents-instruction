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

export type WorkType = "feature" | "change" | "bug" | "technical";

export interface ChangeContract {
  workType: WorkType;
  sourceRunIds?: string[];
  summary: string;
  currentBehavior: string;
  expectedBehavior: string;
  inScope: string[];
  outOfScope: string[];
  acceptanceCriteria: string[];
  regressionScope: string[];
  riskFlags: string[];
  evidenceRefs: string[];
}

export type DiscoveryResolutionMode = "direct" | "reuse" | "partial" | "full";
export type DesignResolutionMode = "skip" | "reuse" | "partial" | "full";
export type ArchitectureResolutionMode = "skip" | "reuse" | "partial" | "full";
export type PhaseResolutionMode =
  | Exclude<DiscoveryResolutionMode, "full">
  | Exclude<DesignResolutionMode, "full">
  | Exclude<ArchitectureResolutionMode, "full">;

export interface PhaseResolution {
  phaseId: "discovery" | "design" | "architecture";
  mode: PhaseResolutionMode;
  rationale: string;
  inputArtifactIds: string[];
  sourceRunId: string | null;
  sourceRunTitle: string | null;
  sourcePhaseRunId: string | null;
  sourceArtifactIds: string[];
  affectedOutputKeys: string[];
  routeVersion: 1;
  decidedAt: string;
}

export interface PhaseBaseline {
  phaseId: "discovery" | "design";
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

export interface AssessProductImpactInput {
  mode: Exclude<DiscoveryResolutionMode, "full">;
  rationale: string;
  selectedArtifactIds: string[];
  expectedBaselineArtifactIds: string[];
  affectedOutputKeys: string[];
}

export interface AssessDesignImpactInput {
  mode: Exclude<DesignResolutionMode, "full">;
  rationale: string;
  selectedArtifactIds: string[];
  expectedBaselineArtifactIds: string[];
  affectedOutputKeys: string[];
}

export type ArchitectureImpactMode = "reuse" | "partial";

export interface ArchitectureSelectionEvidence {
  optionId: string;
  reviewId: string;
  optionsArtifactId: string;
  selectedAt: string;
}

export interface ArchitectureBaseline {
  sourceRunId: string;
  sourceRunTitle: string;
  sourcePhaseRunId: string;
  approvedAt: string;
  artifacts: Array<{
    id: string;
    artifactKey: string;
    contentHash: string;
  }>;
  selection: ArchitectureSelectionEvidence;
}

export interface ArchitectureImpact {
  mode: ArchitectureImpactMode;
  rationale: string;
  sourceRunId: string;
  sourceRunTitle: string;
  sourcePhaseRunId: string;
  sourceArtifactIds: string[];
  inputArtifactIds: string[];
  affectedOutputKeys: string[];
  assessedAt: string;
  selection: ArchitectureSelectionEvidence;
}

export interface AssessArchitectureImpactInput {
  mode: ArchitectureImpactMode;
  rationale: string;
  selectedArtifactIds: string[];
  expectedBaselineArtifactIds: string[];
  affectedOutputKeys: string[];
}

export interface AssessArchitectureDispositionInput {
  mode: "skip" | ArchitectureImpactMode;
  rationale: string;
  selectedArtifactIds: string[];
  expectedBaselineArtifactIds: string[];
  affectedOutputKeys: string[];
}

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

export type E2ePackageManager = "npm";
export type E2eBrowser = "chromium";

export interface ConfigureE2eWorkspaceInput {
  rootPath: string;
  initialize: boolean;
  baseUrl: string;
  packageManager: E2ePackageManager;
  /** Reviewed package-script key, never a free-form shell command. */
  sourceStartScript: string;
  /** Reviewed package-script key, never a free-form shell command. */
  testScript: string;
  browser: E2eBrowser;
  playwrightVersion: string;
}

export interface E2eWorkspace {
  version: 1;
  productProjectId: string;
  rootPath: string;
  descriptorPath: string;
  baseUrl: string;
  packageManager: E2ePackageManager;
  sourceStartScript: string;
  testScript: string;
  browser: E2eBrowser;
  playwrightVersion: string;
  descriptorHash: string;
  updatedAt: string;
}

export type VerificationE2eFlowState =
  | "unconfigured"
  | "preflight_blocked"
  | "needs_authoring"
  | "authoring"
  | "awaiting_script_review"
  | "ready_to_execute"
  | "executing"
  | "awaiting_verification_review"
  | "failed";

export type E2eReadinessState =
  | "ready"
  | "missing"
  | "invalid"
  | "unreachable"
  | "failed"
  | "not_checked";

export interface E2eReadinessItem {
  state: E2eReadinessState;
  message: string;
  detail?: string;
}

export interface E2eWorkspaceReadiness {
  ready: boolean;
  workspace: E2eReadinessItem;
  playwright: E2eReadinessItem;
  browser: E2eReadinessItem;
  sourceStartScript: E2eReadinessItem;
  target: E2eReadinessItem;
  checkedAt: string;
}

export interface E2eAuthoredFile {
  path: string;
  sha256: string;
  bytes: number;
  content?: string;
}

export interface VerificationE2eAuthoring {
  runId: string;
  executionId: string;
  status: "awaiting_review" | "approved" | "changes_requested";
  patchHash: string;
  productRevisionToken: string;
  e2eRevisionToken: string;
  criterionIds: string[];
  files: E2eAuthoredFile[];
  reviewComment: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface VerificationE2eFlow {
  runId: string;
  state: VerificationE2eFlowState;
  workspace: E2eWorkspace | null;
  readiness: E2eWorkspaceReadiness | null;
  blockers: string[];
  criterionIds: string[];
  contractSource: "change_contract" | "legacy_approved_artifacts" | "unavailable";
  authoring: VerificationE2eAuthoring | null;
  execution: Execution | null;
  recommendedAction: string;
}

export interface VerificationE2eSelectionInput {
  selectedArtifactIds: string[];
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
}

export type VerificationE2eAction = "standard" | "author_e2e" | "run_e2e";

export interface VerificationE2eScriptReviewInput {
  decision: ReviewDecision;
  expectedPatchHash: string;
  comment: string;
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
  artifactIds?: string[];
  createdAt?: string;
  reviewer?: string;
}

export type HumanDecisionPhaseId = "discovery" | "design" | "architecture";
export type HumanDecisionKind = "decision" | "work" | "dependency" | "acceptance";
export type HumanDecisionGateState =
  | "clear"
  | "awaiting_decision"
  | "awaiting_role_work"
  | "inconsistent_approval";

export interface HumanDecisionItem {
  id: string;
  phaseId: HumanDecisionPhaseId;
  actionPhaseId: HumanDecisionPhaseId;
  artifactKey: string;
  kind: HumanDecisionKind;
  title: string;
  prompt: string;
  owner: string;
  nextAction: string;
  blocking: boolean;
  response: string | null;
}

export interface PhaseHumanDecisionGate {
  phaseId: HumanDecisionPhaseId;
  roleId: "pm-ba" | "designer" | "architect";
  state: HumanDecisionGateState;
  items: HumanDecisionItem[];
  blockingCount: number;
  decisionCount: number;
  workCount: number;
  dependencyCount: number;
  inconsistentApproval: boolean;
}

export interface HumanDecisionSummary {
  totalBlocking: number;
  totalDecisions: number;
  totalRoleWork: number;
  inconsistentPhaseIds: HumanDecisionPhaseId[];
  phases: PhaseHumanDecisionGate[];
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
  resolution?: PhaseResolution | null;
  architectureImpact?: ArchitectureImpact | null;
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
  changeContract?: ChangeContract | null;
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
  productBaseline?: PhaseBaseline | null;
  designBaseline?: PhaseBaseline | null;
  architectureBaseline?: ArchitectureBaseline | null;
}

export interface CreateProjectInput {
  name: string;
  summary: string;
  rootPath: string;
  initialize: boolean;
  agentClient?: "codex" | "claude" | "copilot";
}

export type CreateRunInput =
  | {
      title: string;
      objective: string;
      changeContract?: ChangeContract;
    }
  | {
      title: string;
      workType: Exclude<WorkType, "feature">;
      sourceRunIds: string[];
      expectedBehavior: string;
    };

export interface ApiErrorPayload {
  message?: string;
  error?: string;
  details?: string;
}
