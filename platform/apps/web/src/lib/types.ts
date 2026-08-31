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

export type WorkflowPhaseId =
  | "discovery"
  | "design"
  | "architecture"
  | "implementation"
  | "verification"
  | "release";

export type RunExecutionModel = "legacy" | "flexible";

export interface RunIntent {
  kind: "full-flow" | "single-stage" | "quick-change";
  summary: string;
}

export interface RunContextReferences {
  sourceRunIds: string[];
  artifactIds: string[];
  filePaths: string[];
  externalReferences: string[];
}

export interface RunEnvironmentRequest {
  strategy: "none" | "reuse" | "create";
  keepAlive: boolean;
}

export type ReviewDecision = "approve" | "request_changes";

export type WorkType = "feature" | "change" | "bug" | "technical";

export interface WorkItemAdapterSummary {
  id: string;
  label: string;
  kind: "mcp-stdio";
  configured: boolean;
  message: string | null;
}

export interface WorkItemProvenance {
  kind: "mcp";
  adapterId: string;
  adapterLabel: string;
  reference: string;
  externalId: string;
  url: string | null;
  fetchedAt: string;
  fingerprint: string;
}

export interface WorkItemDraft {
  source: WorkItemProvenance;
  title: string;
  description: string;
  suggestedWorkType: WorkType;
  acceptanceCriteria: string[];
  labels: string[];
}

export interface ResolveWorkItemInput {
  adapterId: string;
  reference: string;
}

export type AskProviderId = "openai" | "lmstudio" | "ollama" | "custom";

export type AskProviderProtocol =
  | "openai-responses"
  | "openai-chat"
  | "ollama-chat";

export type AskProviderAvailability =
  | "ready"
  | "not_configured"
  | "unreachable"
  | "authentication_failed"
  | "model_unavailable"
  | "protocol_error";

export interface AskProviderCapabilities {
  streaming: boolean;
  structuredOutput: boolean;
  toolCalling: boolean;
}

export interface AskProviderStatus {
  id: AskProviderId;
  label: string;
  configured: boolean;
  model: string | null;
  protocol: AskProviderProtocol;
  dataBoundary: "remote" | "local" | "operator-configured";
  endpointLabel: string;
  capabilities: AskProviderCapabilities;
  message: string;
}

export interface AskProviderCheck {
  providerId: AskProviderId;
  state: AskProviderAvailability;
  model: string | null;
  message: string;
  checkedAt: string;
}

export type AskProviderSecretUpdate =
  | { action: "keep" }
  | { action: "replace"; value: string }
  | { action: "clear" };

export type AskProviderEndpointUpdate =
  | { action: "keep" }
  | { action: "replace"; value: string }
  | { action: "clear" };

/** Write-only configuration input. Secret values must never appear in a response DTO. */
export interface SaveAskProviderConfigurationInput {
  expectedVersion: number;
  label: string;
  protocol: AskProviderProtocol;
  model: string | null;
  endpoint: AskProviderEndpointUpdate;
  credential: AskProviderSecretUpdate;
  structuredOutput: boolean;
  toolCalling: boolean;
  allowInsecureHttp: boolean;
}

export interface AskProviderConfigurationCheck extends AskProviderCheck {
  version: number;
  configVersion: number;
}

/** Control-plane DTO. It deliberately contains neither credential nor full endpoint. */
export interface AskProviderConfiguration {
  providerId: AskProviderId;
  label: string;
  enabled: boolean;
  configured: boolean;
  model: string | null;
  protocol: AskProviderProtocol;
  dataBoundary: AskProviderStatus["dataBoundary"];
  endpointLabel: string;
  hasEndpoint: boolean;
  hasCredential: boolean;
  structuredOutput: boolean;
  toolCalling: boolean;
  allowInsecureHttp: boolean;
  version: number;
  configVersion: number;
  lastCheck: AskProviderConfigurationCheck | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AskCitation {
  sourceId: string;
  path: string;
  startLine: number;
  endLine: number;
  sha256: string;
  revision: string;
  excerpt: string;
  summary: string;
}

export interface AskWorkItemDraft {
  title: string;
  objective: string;
  acceptanceCriteria: string[];
}

export interface AskAnswer {
  answer: string;
  citations: AskCitation[];
  invalidCitationIds: string[];
  uncertainties: string[];
  suggestedQuestions: string[];
  workItemDraft: AskWorkItemDraft | null;
  provider: {
    id: AskProviderId;
    label: string;
    model: string;
  };
  revision: string;
  dirty: boolean;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
  };
  durationMs: number;
  answeredAt: string;
}

export interface AskHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AskThreadMessage {
  id: string;
  sequence: number;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  answer: AskAnswer | null;
}

export interface AskThreadSummary {
  id: string;
  projectId: string;
  providerId: AskProviderId;
  /** Immutable Git object id behind the public Ask revision token. */
  sourceRevision: string;
  revision: string;
  title: string;
  status: "active" | "archived";
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AskThread extends AskThreadSummary {
  messages: AskThreadMessage[];
}

export interface CreateAskThreadInput {
  providerId: AskProviderId;
  revision?: string;
  title?: string;
}

export interface AskThreadQuestionInput {
  question: string;
  expectedRevision: string;
}

export interface AskProjectInput {
  providerId: AskProviderId;
  question: string;
  history: AskHistoryMessage[];
  expectedRevision?: string;
}

export interface ChangeContract {
  workType: WorkType;
  sourceRunIds?: string[];
  workItem?: WorkItemProvenance;
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
  authentication?: {
    required: boolean;
  };
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
  realExecution: {
    state: "ready" | "simulated" | "worker_not_configured" | "operator_approval_required";
    message: string;
  };
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

export interface RepositoryCredentialProfile {
  id: string;
  label: string;
  host: string;
  available: boolean;
}

export interface ProjectRepository {
  url: string;
  host: string;
  requestedRef: string | null;
  credentialProfile: RepositoryCredentialProfile | null;
  activeSnapshot: {
    revision: string;
    resolvedRef: string;
    indexedAt: string;
  } | null;
  operation: {
    id: string;
    kind: "import" | "sync";
    state: "queued" | "running" | "failed";
    stage: "validating" | "fetching" | "resolving" | "materializing" | "indexing" | "publishing";
    progress: number;
    message: string;
  } | null;
}

export interface ProjectKnowledgePathSignal {
  path: string;
  kind: "entry" | "document" | "test" | "build" | "key-path";
  summary: string;
}

export interface ProjectKnowledgeSummary {
  fileCount: number;
  totalBytes: number;
  languages: Array<{ language: string; files: number; bytes: number }>;
  entryPoints: ProjectKnowledgePathSignal[];
  documents: ProjectKnowledgePathSignal[];
  tests: ProjectKnowledgePathSignal[];
  builds: ProjectKnowledgePathSignal[];
  keyPaths: ProjectKnowledgePathSignal[];
  truncated: boolean;
}

export interface ProjectKnowledge {
  id: string;
  status: "indexing" | "ready" | "failed";
  revision: string;
  indexedAt: string | null;
  summary: ProjectKnowledgeSummary | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectAvailableActions {
  ask: boolean;
  createRun: boolean;
  sync: boolean;
}

export interface Project {
  id: string;
  name: string;
  summary: string;
  sourceKind: "remote-git" | "legacy-local";
  repository: ProjectRepository | null;
  knowledge: ProjectKnowledge | null;
  availableActions: ProjectAvailableActions;
  runCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Minimal browser input for the default chat-first repository binding. */
export interface BindRemoteRepositoryInput {
  repositoryUrl: string;
  requestedRef?: string;
  credentialProfileId?: string | null;
}

export interface AgentProviderCapabilities {
  chat: boolean;
  deepWiki: boolean;
  toolCalling: boolean;
}

export interface ProjectAgentSettings {
  projectId: string;
  repoAlias: string;
  defaultProviderId: AskProviderId;
  sandboxBlueprintId: string;
  sandboxBlueprintVersion: string;
  enabledMcpServerIds: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface SandboxBlueprintSummary {
  id: string;
  label: string;
  version: string;
  description: string;
  capabilities: {
    persistentWorkspace: boolean;
    testExecution: boolean;
    servicePorts: boolean;
    restrictedNetwork: boolean;
  };
  configured: boolean;
  installHint: string | null;
}

export type McpToolPermissionClass =
  | "read"
  | "sandbox_write"
  | "external_write"
  | "destructive"
  | "release";

export interface McpInstallationSummary {
  id: string;
  label: string;
  description: string;
  kind: "mcp-stdio" | "mcp-http";
  installed: boolean;
  authorization: "ready" | "missing" | "not-required";
  permissionClasses: McpToolPermissionClass[];
  installHint: string | null;
}

export interface AgentSessionRepository {
  sessionId: string;
  projectId: string;
  repoAlias: string;
  accessMode: "write" | "read";
  sourceRevision: string;
  createdAt: string;
}

export interface AgentSessionRun {
  sessionId: string;
  triggerMessageId: string;
  workflowRunId: string;
  providerId: AskProviderId;
  createdAt: string;
}

export interface AgentSandbox {
  id: string;
  sessionId: string;
  projectId: string;
  sourceRevision: string;
  blueprintId: string;
  blueprintVersion: string;
  state: "starting" | "ready" | "busy" | "stopped" | "failed";
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentMessage {
  id: string;
  sessionId: string;
  sequence: number;
  role: "user" | "assistant";
  status: "running" | "completed" | "failed" | "cancelled";
  content: string;
  providerId: AskProviderId;
  model: string | null;
  clientMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AgentEventKind =
  | "session.created"
  | "message.accepted"
  | "provider.started"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "sandbox.starting"
  | "sandbox.ready"
  | "sandbox.failed"
  | "sdlc.run-created"
  | "sdlc.phase-started"
  | "sdlc.phase-completed"
  | "human-gate.required"
  | "human-gate.resolved"
  | "turn.completed"
  | "turn.failed"
  | "deepwiki.started"
  | "deepwiki.completed"
  | "deepwiki.failed";

export interface AgentEvent {
  id: string;
  sessionId: string;
  sequence: number;
  kind: AgentEventKind;
  status: "started" | "completed" | "failed" | "waiting";
  summary: string;
  messageId: string | null;
  toolCallId: string | null;
  projectId: string | null;
  workflowRunId: string | null;
  phaseId: string | null;
  createdAt: string;
}

export interface AgentToolCall {
  id: string;
  sessionId: string;
  messageId: string;
  mcpServerId: string;
  toolName: string;
  permissionClass: McpToolPermissionClass;
  approval: "not-required" | "required" | "approved" | "denied";
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  argumentsSha256: string;
  outputSha256: string | null;
  summary: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface AgentHumanGate {
  id: string;
  sessionId: string;
  messageId: string;
  category: "scope" | "architecture" | "security" | "ddl" | "secret" | "destructive" | "external_write" | "deployment" | "release";
  status: "pending" | "approved" | "rejected" | "cancelled";
  question: string;
  choices: Array<{
    id: string;
    label: string;
    description: string;
    recommended: boolean;
  }>;
  selectedChoiceId: string | null;
  responseComment: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface AgentSession {
  id: string;
  title: string;
  status: "active" | "archived";
  turnState: "idle" | "running" | "waiting_human" | "interrupted";
  currentProviderId: AskProviderId;
  lastMessageSequence: number;
  lastEventSequence: number;
  repositories: AgentSessionRepository[];
  sandbox: AgentSandbox | null;
  messages?: AgentMessage[];
  events?: AgentEvent[];
  toolCalls?: AgentToolCall[];
  humanGates?: AgentHumanGate[];
  runs?: AgentSessionRun[];
  createdAt: string;
  updatedAt: string;
}

export type AgentRunPhaseId =
  | "discovery"
  | "design"
  | "architecture"
  | "implementation"
  | "verification"
  | "release";

export type AgentRunRoleId =
  | "pm-ba"
  | "designer"
  | "architect"
  | "software-engineer"
  | "tester"
  | "devops";

export interface AgentRunExecution {
  id: string;
  phaseRunId: string;
  status: "queued" | "running" | "completed" | "failed";
  selectedArtifactIds: string[];
  selectedOutputKeys: string[];
  runnerMode: "real" | "fake" | null;
  model: string | null;
  reasoningEffort: CodexReasoningEffort | null;
  command: string;
  exitCode: number | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export type AgentRunAdvanceResult =
  | {
      state: "started";
      runId: string;
      phaseId: AgentRunPhaseId;
      roleId: AgentRunRoleId;
      execution?: AgentRunExecution;
      selectedArtifactIds: string[];
    }
  | {
      state: "running" | "awaiting_review" | "blocked" | "failed";
      runId: string;
      phaseId: AgentRunPhaseId;
      roleId: AgentRunRoleId;
      artifactKeys: string[];
      reason: string;
    }
  | {
      state: "completed";
      runId: string;
      artifactKeys: string[];
      reason: string;
    };

export interface SendAgentMessageInput {
  clientMessageId: string;
  expectedSequence: number;
  content: string;
  providerId?: AskProviderId;
}

export interface DeepWikiCitation {
  path: string;
  startLine: number;
  endLine: number;
  sha256: string;
  summary: string;
}

export interface DeepWikiGeneration {
  id: string;
  projectId: string;
  revision: string;
  providerId: AskProviderId;
  model: string | null;
  promptVersion: string;
  status: "queued" | "scanning" | "generating" | "validating" | "ready" | "failed" | "stale";
  manifestHash: string | null;
  content: string | null;
  citations: DeepWikiCitation[];
  usage: { inputTokens: number | null; outputTokens: number | null };
  errorMessage: string | null;
  generatedAt: string | null;
  staleAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RepositoryBindingResult {
  project: Project;
  session: AgentSession;
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
  baseRevision?: string | null;
  definitionVersion?: string | null;
  executionModel?: RunExecutionModel | null;
  targetPhaseId?: WorkflowPhaseId | null;
  runIntent?: RunIntent | null;
  runContextReferences?: RunContextReferences | null;
  runEnvironmentRequest?: RunEnvironmentRequest | null;
  resultReceiptVersion?: number | null;
  workspaceState?: "provisioning" | "ready" | "busy" | "failed" | "destroyed" | null;
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
  agentSession: { sessionId: string } | null;
  productBaseline?: PhaseBaseline | null;
  designBaseline?: PhaseBaseline | null;
  architectureBaseline?: ArchitectureBaseline | null;
}

export interface CreateRemoteProjectInput {
  sourceKind: "remote-git";
  name: string;
  summary: string;
  repositoryUrl: string;
  requestedRef?: string;
  credentialProfileId?: string | null;
}

/** Compatibility-only input. The Cloud project dialog never constructs it. */
export interface CreateLocalProjectInput {
  sourceKind?: "legacy-local";
  name: string;
  summary: string;
  rootPath: string;
  initialize: boolean;
  agentClient?: "codex" | "claude" | "copilot";
}

export type CreateProjectInput = CreateRemoteProjectInput | CreateLocalProjectInput;

export interface FlexibleRunOptions {
  targetPhaseId?: WorkflowPhaseId;
  runIntent?: RunIntent;
  runContextReferences?: RunContextReferences;
  runEnvironmentRequest?: RunEnvironmentRequest;
}

export type CreateRunInput = (
  | {
      title: string;
      objective: string;
      changeContract?: ChangeContract;
      baseRevision?: string;
    }
  | {
      title: string;
      workType: Exclude<WorkType, "feature">;
      sourceRunIds: string[];
      expectedBehavior: string;
      baseRevision?: string;
    }
) & FlexibleRunOptions;

export interface RunChangeset {
  runId: string;
  baseRevision: string;
  headRevision: string | null;
  dirty: boolean;
  files: Array<{
    path: string;
    status: "added" | "modified" | "deleted" | "renamed" | "copied" | "type_changed" | "unmerged";
    oldPath: string | null;
    binary: boolean;
  }>;
  patchBytes: number;
  patchSha256: string;
  generatedAt: string;
  downloadAvailable: boolean;
}

export interface RunResultReceipt {
  runId: string;
  resultReceiptVersion: number;
  title: string;
  objective: string;
  status: "active" | "completed";
  outcome: "pending" | "running" | "blocked" | "failed" | "completed";
  targetPhaseId: WorkflowPhaseId | null;
  summary: string;
  intent: RunIntent | null;
  contextReferences: RunContextReferences | null;
  files: { created: string[]; modified: string[]; deleted: string[] };
  artifacts: Array<{
    phaseId: WorkflowPhaseId;
    artifactId: string;
    artifactKey: string;
    filePath: string;
    reviewStatus: Artifact["reviewStatus"];
    contentHash: string;
    revision: number;
  }>;
  executions: Array<{
    phaseId: WorkflowPhaseId;
    executionId: string;
    status: Execution["status"];
    command: string;
    exitCode: number | null;
    durationMs: number | null;
    runnerMode: string | null;
    model: string | null;
    error: string | null;
  }>;
  environment: {
    request: RunEnvironmentRequest | null;
    workspaceState: WorkflowRun["workspaceState"];
  };
  tests: {
    totalExecutions: number;
    passedExecutions: number;
    failedExecutions: number;
    pendingExecutions: number;
  };
  git: RunChangeset | null;
  externalOperations: string[];
  permissionDecisions: string[];
  risks: string[];
  recommendations: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ApiErrorPayload {
  message?: string;
  error?: string;
  details?: string;
}
