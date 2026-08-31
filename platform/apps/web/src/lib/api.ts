import type {
  AgentEvent,
  AgentHumanGate,
  AgentMessage,
  AgentRunAdvanceResult,
  AgentRunPhaseId,
  AgentSession,
  AgentSessionRun,
  AgentToolCall,
  Artifact,
  AskAnswer,
  AskCitation,
  AskProjectInput,
  AskProviderCheck,
  AskProviderConfiguration,
  AskProviderConfigurationCheck,
  SaveAskProviderConfigurationInput,
  AskProviderId,
  AskProviderStatus,
  AskThread,
  AskThreadQuestionInput,
  AskThreadSummary,
  AssessArchitectureDispositionInput,
  AssessDesignImpactInput,
  AssessProductImpactInput,
  BindRemoteRepositoryInput,
  CodexCapabilities,
  CodexReasoningEffort,
  ConfigureE2eWorkspaceInput,
  CreateArtifactRevisionInput,
  CreateAskThreadInput,
  CreateProjectInput,
  CreateRunInput,
  DeepWikiGeneration,
  Execution,
  E2eWorkspace,
  E2eWorkspaceReadiness,
  FigmaIntegrationStatus,
  FigmaPlanCapabilities,
  FigmaTarget,
  HealthStatus,
  HumanDecisionPhaseId,
  HumanDecisionSummary,
  McpInstallationSummary,
  Project,
  ProjectAgentSettings,
  ProjectDetail,
  ProjectKnowledge,
  RepositoryBindingResult,
  RepositoryCredentialProfile,
  Review,
  ReviewDecision,
  RunDetail,
  RunEvent,
  RunChangeset,
  RunResultReceipt,
  SandboxBlueprintSummary,
  SendAgentMessageInput,
  ResolveWorkItemInput,
  TicketDetail,
  TicketStatus,
  TicketSummary,
  WorkflowRun,
  WorkItemAdapterSummary,
  WorkItemDraft,
  VerificationE2eFlow,
  VerificationE2eAction,
  VerificationE2eScriptReviewInput,
  VerificationE2eSelectionInput,
} from "./types";
import { parseApiErrorBody } from "./api-error";
import {
  ApiError,
  hasStringFields,
  isRecord,
  parseCollectionResponse,
  parseDirectResponse,
  parseEntityResponse,
} from "./api-response";

export { ApiError } from "./api-response";

const configuredApiUrl = import.meta.env?.VITE_API_URL?.trim();
const API_URL = (
  configuredApiUrl
  || (typeof window === "undefined" ? "http://localhost:4100" : window.location.origin)
).replace(/\/$/, "");
export const ACCESS_TOKEN_STORAGE_KEY = "aiSdlcAccessToken";

export function getAccessToken(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.sessionStorage.getItem(ACCESS_TOKEN_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function setAccessToken(token: string): void {
  if (typeof window === "undefined") return;
  try {
    const normalized = token.trim();
    if (normalized) window.sessionStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, normalized);
    else window.sessionStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
  } catch {
    // A disabled sessionStorage must not cause the token to leak to another store.
  }
}

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const isProjectKnowledge = (value: unknown): value is ProjectKnowledge =>
  hasStringFields(value, ["id", "status", "revision", "createdAt", "updatedAt"]) &&
  ["indexing", "ready", "failed"].includes(value.status as string) &&
  isNullableString(value.indexedAt) &&
  isNullableString(value.errorMessage) &&
  (value.summary === null || (
    isRecord(value.summary) &&
    Number.isSafeInteger(value.summary.fileCount) &&
    Number.isSafeInteger(value.summary.totalBytes) &&
    Array.isArray(value.summary.languages) &&
    Array.isArray(value.summary.entryPoints) &&
    Array.isArray(value.summary.documents) &&
    Array.isArray(value.summary.tests) &&
    Array.isArray(value.summary.builds) &&
    Array.isArray(value.summary.keyPaths) &&
    typeof value.summary.truncated === "boolean"
  ));

const isProject = (value: unknown): value is Project => {
  if (!hasStringFields(value, ["id", "name", "summary", "sourceKind", "createdAt", "updatedAt"])) {
    return false;
  }
  if (!["remote-git", "legacy-local"].includes(value.sourceKind as string)) return false;
  if (!Number.isSafeInteger(value.runCount) || (value.runCount as number) < 0) return false;
  if (!isRecord(value.availableActions) ||
      typeof value.availableActions.ask !== "boolean" ||
      typeof value.availableActions.createRun !== "boolean" ||
      typeof value.availableActions.sync !== "boolean") {
    return false;
  }
  if (value.repository !== null) {
    if (!isRecord(value.repository) ||
        !hasStringFields(value.repository, ["url", "host"]) ||
        !isNullableString(value.repository.requestedRef) ||
        !(value.repository.credentialProfile === null || isRepositoryCredential(value.repository.credentialProfile)) ||
        !(value.repository.activeSnapshot === null || (
          hasStringFields(value.repository.activeSnapshot, ["revision", "resolvedRef", "indexedAt"])
        )) ||
        !(value.repository.operation === null || (
          hasStringFields(value.repository.operation, ["id", "kind", "state", "stage", "message"]) &&
          ["import", "sync"].includes(value.repository.operation.kind as string) &&
          ["queued", "running", "failed"].includes(value.repository.operation.state as string) &&
          ["validating", "fetching", "resolving", "materializing", "indexing", "publishing"].includes(
            value.repository.operation.stage as string,
          ) &&
          Number.isSafeInteger(value.repository.operation.progress) &&
          (value.repository.operation.progress as number) >= 0 &&
          (value.repository.operation.progress as number) <= 100
        ))) {
      return false;
    }
  }
  return (value.knowledge === null || isProjectKnowledge(value.knowledge)) &&
    (value.sourceKind === "remote-git" ? value.repository !== null : value.repository === null);
};

const isAgentRepository = (value: unknown): boolean =>
  hasStringFields(value, ["sessionId", "projectId", "repoAlias", "accessMode", "sourceRevision", "createdAt"]) &&
  ["write", "read"].includes(value.accessMode as string);

const AGENT_SESSION_RUN_KEYS = new Set([
  "sessionId",
  "triggerMessageId",
  "workflowRunId",
  "providerId",
  "createdAt",
]);

const isAgentSessionRun = (value: unknown): value is AgentSessionRun =>
  isRecord(value) &&
  hasOnlyKeys(value, AGENT_SESSION_RUN_KEYS) &&
  hasStringFields(value, [
    "sessionId", "triggerMessageId", "workflowRunId", "providerId", "createdAt",
  ]) &&
  isAskProviderId(value.providerId);

const isAgentSandbox = (value: unknown): boolean =>
  hasStringFields(value, [
    "id", "sessionId", "projectId", "sourceRevision", "blueprintId",
    "blueprintVersion", "state", "createdAt", "updatedAt",
  ]) &&
  ["starting", "ready", "busy", "stopped", "failed"].includes(value.state as string) &&
  isNullableString(value.expiresAt);

const isAgentMessage = (value: unknown): value is AgentMessage =>
  hasStringFields(value, [
    "id", "sessionId", "role", "status", "content", "providerId", "createdAt", "updatedAt",
  ]) &&
  Number.isSafeInteger(value.sequence) && (value.sequence as number) > 0 &&
  ["user", "assistant"].includes(value.role as string) &&
  ["running", "completed", "failed", "cancelled"].includes(value.status as string) &&
  isAskProviderId(value.providerId) &&
  isNullableString(value.model) &&
  isNullableString(value.clientMessageId);

const isAgentEvent = (value: unknown): value is AgentEvent =>
  hasStringFields(value, ["id", "sessionId", "kind", "status", "summary", "createdAt"]) &&
  Number.isSafeInteger(value.sequence) && (value.sequence as number) > 0 &&
  ["started", "completed", "failed", "waiting"].includes(value.status as string) &&
  ["messageId", "toolCallId", "projectId", "workflowRunId", "phaseId"]
    .every((key) => isNullableString(value[key]));

const isAgentToolCall = (value: unknown): value is AgentToolCall =>
  hasStringFields(value, [
    "id", "sessionId", "messageId", "mcpServerId", "toolName", "permissionClass",
    "approval", "status", "argumentsSha256", "createdAt",
  ]) &&
  ["read", "sandbox_write", "external_write", "destructive", "release"]
    .includes(value.permissionClass as string) &&
  ["not-required", "required", "approved", "denied"].includes(value.approval as string) &&
  ["queued", "running", "completed", "failed", "cancelled"].includes(value.status as string) &&
  ["outputSha256", "summary", "errorMessage", "startedAt", "finishedAt"]
    .every((key) => isNullableString(value[key]));

const isAgentHumanGate = (value: unknown): value is AgentHumanGate =>
  hasStringFields(value, ["id", "sessionId", "messageId", "category", "status", "question", "createdAt"]) &&
  Array.isArray(value.choices) &&
  value.choices.every((choice) => (
    hasStringFields(choice, ["id", "label", "description"]) && typeof choice.recommended === "boolean"
  )) &&
  isNullableString(value.selectedChoiceId) &&
  isNullableString(value.responseComment) &&
  isNullableString(value.resolvedAt);

const isAgentSession = (value: unknown): value is AgentSession =>
  hasStringFields(value, ["id", "title", "status", "turnState", "currentProviderId", "createdAt", "updatedAt"]) &&
  ["active", "archived"].includes(value.status as string) &&
  ["idle", "running", "waiting_human", "interrupted"].includes(value.turnState as string) &&
  isAskProviderId(value.currentProviderId) &&
  Number.isSafeInteger(value.lastMessageSequence) &&
  Number.isSafeInteger(value.lastEventSequence) &&
  Array.isArray(value.repositories) && value.repositories.every(isAgentRepository) &&
  (value.sandbox === null || isAgentSandbox(value.sandbox)) &&
  (value.messages === undefined || (Array.isArray(value.messages) && value.messages.every(isAgentMessage))) &&
  (value.events === undefined || (Array.isArray(value.events) && value.events.every(isAgentEvent))) &&
  (value.toolCalls === undefined || (Array.isArray(value.toolCalls) && value.toolCalls.every(isAgentToolCall))) &&
  (value.humanGates === undefined || (Array.isArray(value.humanGates) && value.humanGates.every(isAgentHumanGate))) &&
  (value.runs === undefined || (Array.isArray(value.runs) && value.runs.every(isAgentSessionRun)));

const AGENT_RUN_PHASE_IDS = new Set<AgentRunPhaseId>([
  "discovery",
  "design",
  "architecture",
  "implementation",
  "verification",
  "release",
]);

const AGENT_RUN_ROLE_IDS = new Set([
  "pm-ba",
  "designer",
  "architect",
  "software-engineer",
  "tester",
  "devops",
]);

const AGENT_RUN_EXECUTION_KEYS = new Set([
  "id",
  "phaseRunId",
  "status",
  "selectedArtifactIds",
  "selectedOutputKeys",
  "runnerMode",
  "model",
  "reasoningEffort",
  "command",
  "exitCode",
  "error",
  "startedAt",
  "finishedAt",
  "createdAt",
]);

const isAgentRunExecution = (value: unknown): boolean =>
  isRecord(value) &&
  hasOnlyKeys(value, AGENT_RUN_EXECUTION_KEYS) &&
  hasStringFields(value, ["id", "phaseRunId", "status", "command", "createdAt"]) &&
  ["queued", "running", "completed", "failed"].includes(value.status as string) &&
  isStringArray(value.selectedArtifactIds) &&
  isStringArray(value.selectedOutputKeys) &&
  (value.runnerMode === null || ["real", "fake"].includes(value.runnerMode as string)) &&
  isNullableString(value.model) &&
  (value.reasoningEffort === null || [
    "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
  ].includes(value.reasoningEffort as string)) &&
  (value.exitCode === null || Number.isSafeInteger(value.exitCode)) &&
  isNullableString(value.error) &&
  isNullableString(value.startedAt) &&
  isNullableString(value.finishedAt);

const AGENT_RUN_STARTED_KEYS = new Set([
  "state", "runId", "phaseId", "roleId", "execution", "selectedArtifactIds",
]);
const AGENT_RUN_PROGRESS_KEYS = new Set([
  "state", "runId", "phaseId", "roleId", "artifactKeys", "reason",
]);
const AGENT_RUN_COMPLETED_KEYS = new Set([
  "state", "runId", "artifactKeys", "reason",
]);

const isAgentRunAdvanceResult = (value: unknown): value is AgentRunAdvanceResult => {
  if (!isRecord(value) || typeof value.state !== "string" || typeof value.runId !== "string") {
    return false;
  }
  if (value.state === "started") {
    return hasOnlyKeys(value, AGENT_RUN_STARTED_KEYS) &&
      typeof value.phaseId === "string" && AGENT_RUN_PHASE_IDS.has(value.phaseId as AgentRunPhaseId) &&
      typeof value.roleId === "string" && AGENT_RUN_ROLE_IDS.has(value.roleId) &&
      isStringArray(value.selectedArtifactIds) &&
      (value.execution === undefined || isAgentRunExecution(value.execution));
  }
  if (["running", "awaiting_review", "blocked", "failed"].includes(value.state)) {
    return hasOnlyKeys(value, AGENT_RUN_PROGRESS_KEYS) &&
      typeof value.phaseId === "string" && AGENT_RUN_PHASE_IDS.has(value.phaseId as AgentRunPhaseId) &&
      typeof value.roleId === "string" && AGENT_RUN_ROLE_IDS.has(value.roleId) &&
      isStringArray(value.artifactKeys) &&
      typeof value.reason === "string";
  }
  return value.state === "completed" &&
    hasOnlyKeys(value, AGENT_RUN_COMPLETED_KEYS) &&
    isStringArray(value.artifactKeys) &&
    typeof value.reason === "string";
};

const HUMAN_DECISION_PHASE_IDS = new Set(["discovery", "design", "architecture"]);
const HUMAN_DECISION_KINDS = new Set(["decision", "work", "dependency", "acceptance"]);
const HUMAN_DECISION_GATE_STATES = new Set([
  "clear",
  "awaiting_decision",
  "awaiting_role_work",
  "inconsistent_approval",
]);
const HUMAN_DECISION_ITEM_KEYS = new Set([
  "id", "phaseId", "actionPhaseId", "artifactKey", "kind", "title", "prompt",
  "owner", "nextAction", "blocking", "response",
]);
const HUMAN_DECISION_GATE_KEYS = new Set([
  "phaseId", "roleId", "state", "items", "blockingCount", "decisionCount",
  "workCount", "dependencyCount", "inconsistentApproval",
]);
const HUMAN_DECISION_SUMMARY_KEYS = new Set([
  "totalBlocking", "totalDecisions", "totalRoleWork", "inconsistentPhaseIds", "phases",
]);

const isNonnegativeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const isHumanDecisionItem = (value: unknown): boolean =>
  isRecord(value) &&
  hasOnlyKeys(value, HUMAN_DECISION_ITEM_KEYS) &&
  hasStringFields(value, [
    "id", "phaseId", "actionPhaseId", "artifactKey", "kind", "title", "prompt",
    "owner", "nextAction",
  ]) &&
  HUMAN_DECISION_PHASE_IDS.has(value.phaseId as string) &&
  HUMAN_DECISION_PHASE_IDS.has(value.actionPhaseId as string) &&
  HUMAN_DECISION_KINDS.has(value.kind as string) &&
  typeof value.blocking === "boolean" &&
  isNullableString(value.response);

const isPhaseHumanDecisionGate = (value: unknown): boolean =>
  isRecord(value) &&
  hasOnlyKeys(value, HUMAN_DECISION_GATE_KEYS) &&
  hasStringFields(value, ["phaseId", "roleId", "state"]) &&
  HUMAN_DECISION_PHASE_IDS.has(value.phaseId as string) &&
  ["pm-ba", "designer", "architect"].includes(value.roleId as string) &&
  HUMAN_DECISION_GATE_STATES.has(value.state as string) &&
  Array.isArray(value.items) && value.items.every(isHumanDecisionItem) &&
  [value.blockingCount, value.decisionCount, value.workCount, value.dependencyCount]
    .every(isNonnegativeInteger) &&
  typeof value.inconsistentApproval === "boolean";

const isHumanDecisionSummary = (value: unknown): value is HumanDecisionSummary =>
  isRecord(value) &&
  hasOnlyKeys(value, HUMAN_DECISION_SUMMARY_KEYS) &&
  [value.totalBlocking, value.totalDecisions, value.totalRoleWork].every(isNonnegativeInteger) &&
  Array.isArray(value.inconsistentPhaseIds) &&
  value.inconsistentPhaseIds.every((phaseId) => (
    typeof phaseId === "string" && HUMAN_DECISION_PHASE_IDS.has(phaseId)
  )) &&
  Array.isArray(value.phases) && value.phases.every(isPhaseHumanDecisionGate);

const isProjectAgentSettings = (value: unknown): value is ProjectAgentSettings =>
  hasStringFields(value, [
    "projectId", "repoAlias", "defaultProviderId", "sandboxBlueprintId",
    "sandboxBlueprintVersion", "createdAt", "updatedAt",
  ]) &&
  isAskProviderId(value.defaultProviderId) &&
  Array.isArray(value.enabledMcpServerIds) && value.enabledMcpServerIds.every((id) => typeof id === "string") &&
  Number.isSafeInteger(value.version) && (value.version as number) > 0;

const isSandboxBlueprint = (value: unknown): value is SandboxBlueprintSummary =>
  hasStringFields(value, ["id", "label", "version", "description"]) &&
  isRecord(value.capabilities) &&
  ["persistentWorkspace", "testExecution", "servicePorts", "restrictedNetwork"]
    .every((key) => typeof (value.capabilities as Record<string, unknown>)[key] === "boolean") &&
  typeof value.configured === "boolean" &&
  isNullableString(value.installHint);

const isMcpInstallation = (value: unknown): value is McpInstallationSummary =>
  hasStringFields(value, ["id", "label", "description", "kind", "authorization"]) &&
  ["mcp-stdio", "mcp-http"].includes(value.kind as string) &&
  ["ready", "missing", "not-required"].includes(value.authorization as string) &&
  typeof value.installed === "boolean" &&
  Array.isArray(value.permissionClasses) && value.permissionClasses.every((item) => typeof item === "string") &&
  isNullableString(value.installHint);

const isDeepWikiGeneration = (value: unknown): value is DeepWikiGeneration =>
  hasStringFields(value, [
    "id", "projectId", "revision", "providerId", "promptVersion", "status", "createdAt", "updatedAt",
  ]) &&
  isAskProviderId(value.providerId) &&
  ["queued", "scanning", "generating", "validating", "ready", "failed", "stale"]
    .includes(value.status as string) &&
  ["model", "manifestHash", "content", "errorMessage", "generatedAt", "staleAt"]
    .every((key) => isNullableString(value[key])) &&
  Array.isArray(value.citations) &&
  isRecord(value.usage);

const isWorkflowRun = (value: unknown): value is WorkflowRun =>
  hasStringFields(value, ["id", "projectId", "title"]) &&
  (value.baseRevision === undefined || isNullableString(value.baseRevision));

const isTicketSummary = (value: unknown): value is TicketSummary =>
  hasStringFields(value, ["id", "workflowRunId", "identifier", "title", "status"]) &&
  ["backlog", "todo", "in_progress", "done"].includes(value.status as string);

const isTicketDetail = (value: unknown): value is TicketDetail =>
  isTicketSummary(value) &&
  typeof (value as TicketSummary & { content?: unknown }).content === "string";

const isRunEvent = (value: unknown): value is RunEvent =>
  hasStringFields(value, ["id"]);

const ASK_PROVIDER_IDS: readonly AskProviderId[] = [
  "openai",
  "lmstudio",
  "ollama",
  "custom",
];

const isAskProviderId = (value: unknown): value is AskProviderId =>
  typeof value === "string" && ASK_PROVIDER_IDS.includes(value as AskProviderId);

const isNullableTokenCount = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isAskCitation = (value: unknown): value is AskCitation =>
  hasStringFields(value, ["sourceId", "path", "sha256", "revision", "excerpt", "summary"]) &&
  typeof value.startLine === "number" &&
  Number.isSafeInteger(value.startLine) &&
  value.startLine >= 1 &&
  typeof value.endLine === "number" &&
  Number.isSafeInteger(value.endLine) &&
  value.endLine >= value.startLine;

const isAskProviderStatus = (value: unknown): value is AskProviderStatus =>
  hasStringFields(value, ["id", "label", "protocol", "dataBoundary", "endpointLabel", "message"]) &&
  isAskProviderId(value.id) &&
  typeof value.configured === "boolean" &&
  (value.model === null || typeof value.model === "string") &&
  ["openai-responses", "openai-chat", "ollama-chat"].includes(value.protocol as string) &&
  ["remote", "local", "operator-configured"].includes(value.dataBoundary as string) &&
  isRecord(value.capabilities) &&
  typeof value.capabilities.streaming === "boolean" &&
  typeof value.capabilities.structuredOutput === "boolean" &&
  typeof value.capabilities.toolCalling === "boolean";

const isAskProviderCheck = (value: unknown): value is AskProviderCheck =>
  hasStringFields(value, ["providerId", "state", "message", "checkedAt"]) &&
  isAskProviderId(value.providerId) &&
  [
    "ready",
    "not_configured",
    "unreachable",
    "authentication_failed",
    "model_unavailable",
    "protocol_error",
  ].includes(value.state as string) &&
  (value.model === null || typeof value.model === "string");

const isPositiveVersion = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const isAskProviderConfigurationCheck = (value: unknown): value is AskProviderConfigurationCheck =>
  isRecord(value) &&
  hasOnlyKeys(value, PROVIDER_CONFIGURATION_CHECK_KEYS) &&
  isAskProviderCheck(value) &&
  isPositiveVersion(value.version) &&
  isPositiveVersion(value.configVersion);

const isAskProviderConfiguration = (value: unknown): value is AskProviderConfiguration =>
  hasStringFields(value, ["providerId", "label", "protocol", "dataBoundary", "endpointLabel"]) &&
  hasOnlyKeys(value, PROVIDER_CONFIGURATION_KEYS) &&
  !("credential" in value) &&
  !("endpoint" in value) &&
  isAskProviderId(value.providerId) &&
  typeof value.enabled === "boolean" &&
  typeof value.configured === "boolean" &&
  (value.model === null || typeof value.model === "string") &&
  ["openai-responses", "openai-chat", "ollama-chat"].includes(value.protocol as string) &&
  ["remote", "local", "operator-configured"].includes(value.dataBoundary as string) &&
  typeof value.hasEndpoint === "boolean" &&
  typeof value.hasCredential === "boolean" &&
  typeof value.structuredOutput === "boolean" &&
  typeof value.toolCalling === "boolean" &&
  typeof value.allowInsecureHttp === "boolean" &&
  isPositiveVersion(value.version) &&
  isPositiveVersion(value.configVersion) &&
  (value.lastCheck === null || isAskProviderConfigurationCheck(value.lastCheck)) &&
  isNullableString(value.createdAt) &&
  isNullableString(value.updatedAt);

const PROVIDER_CONFIGURATION_CHECK_KEYS = new Set([
  "providerId", "state", "model", "message", "checkedAt", "version", "configVersion",
]);

const PROVIDER_CONFIGURATION_KEYS = new Set([
  "providerId", "label", "enabled", "configured", "model", "protocol",
  "dataBoundary", "endpointLabel", "hasEndpoint", "hasCredential",
  "structuredOutput", "toolCalling", "allowInsecureHttp", "version",
  "configVersion", "lastCheck", "createdAt", "updatedAt",
]);

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

const isAskAnswer = (value: unknown): value is AskAnswer =>
  hasStringFields(value, ["answer", "revision", "answeredAt"]) &&
  Array.isArray(value.citations) &&
  value.citations.every((citation) =>
    isAskCitation(citation) && citation.revision === value.revision
  ) &&
  isStringArray(value.invalidCitationIds) &&
  isStringArray(value.uncertainties) &&
  isStringArray(value.suggestedQuestions) &&
  (value.workItemDraft === null || (
    isRecord(value.workItemDraft) &&
    hasStringFields(value.workItemDraft, ["title", "objective"]) &&
    isStringArray(value.workItemDraft.acceptanceCriteria)
  )) &&
  isRecord(value.provider) &&
  hasStringFields(value.provider, ["id", "label", "model"]) &&
  isAskProviderId(value.provider.id) &&
  typeof value.dirty === "boolean" &&
  isRecord(value.usage) &&
  isNullableTokenCount(value.usage.inputTokens) &&
  isNullableTokenCount(value.usage.outputTokens) &&
  typeof value.durationMs === "number" &&
  Number.isFinite(value.durationMs) &&
  value.durationMs >= 0;

const isAskThreadMessage = (value: unknown): boolean =>
  hasStringFields(value, ["id", "role", "content", "createdAt"]) &&
  Number.isSafeInteger(value.sequence) &&
  (value.sequence as number) > 0 &&
  ["user", "assistant"].includes(value.role as string) &&
  (value.answer === null || isAskAnswer(value.answer));

const isAskThreadSummary = (value: unknown): value is AskThreadSummary =>
  hasStringFields(value, [
    "id",
    "projectId",
    "providerId",
    "revision",
    "sourceRevision",
    "title",
    "status",
    "createdAt",
    "updatedAt",
  ]) &&
  isAskProviderId(value.providerId) &&
  ["active", "archived"].includes(value.status as string) &&
  Number.isSafeInteger(value.messageCount) &&
  (value.messageCount as number) >= 0;

const isAskThread = (value: unknown): value is AskThread =>
  isAskThreadSummary(value) &&
  isRecord(value) &&
  Array.isArray(value["messages"]) &&
  value["messages"].every(isAskThreadMessage);

const isRepositoryCredential = (value: unknown): value is RepositoryCredentialProfile =>
  hasStringFields(value, ["id", "label", "host"]) &&
  typeof value.available === "boolean";

const isWorkItemAdapterSummary = (value: unknown): value is WorkItemAdapterSummary =>
  hasStringFields(value, ["id", "label", "kind"]) &&
  value.kind === "mcp-stdio" &&
  typeof value.configured === "boolean" &&
  isNullableString(value.message);

const isWorkItemDraft = (value: unknown): value is WorkItemDraft =>
  isRecord(value) &&
  hasStringFields(value, ["title", "description", "suggestedWorkType"]) &&
  ["feature", "change", "bug", "technical"].includes(value.suggestedWorkType as string) &&
  isStringArray(value.acceptanceCriteria) &&
  isStringArray(value.labels) &&
  isRecord(value.source) &&
  hasStringFields(value.source, [
    "kind",
    "adapterId",
    "adapterLabel",
    "reference",
    "externalId",
    "fetchedAt",
    "fingerprint",
  ]) &&
  value.source.kind === "mcp" &&
  isNullableString(value.source.url);

const isRunChangeset = (value: unknown): value is RunChangeset =>
  isRecord(value) &&
  hasStringFields(value, ["runId", "baseRevision", "patchSha256", "generatedAt"]) &&
  isNullableString(value.headRevision) &&
  typeof value.dirty === "boolean" &&
  Number.isSafeInteger(value.patchBytes) &&
  (value.patchBytes as number) >= 0 &&
  typeof value.downloadAvailable === "boolean" &&
  Array.isArray(value.files) &&
  value.files.every((file) =>
    hasStringFields(file, ["path", "status"]) &&
    ["added", "modified", "deleted", "renamed", "copied", "type_changed", "unmerged"].includes(file.status as string) &&
    isNullableString(file.oldPath) &&
      typeof file.binary === "boolean"
  );

const WORKFLOW_PHASE_IDS = [
  "discovery", "design", "architecture", "implementation", "verification", "release",
] as const;

const isRunResultReceipt = (value: unknown): value is RunResultReceipt =>
  isRecord(value) &&
  hasStringFields(value, [
    "runId", "title", "objective", "status", "outcome", "summary", "createdAt", "updatedAt",
  ]) &&
  Number.isSafeInteger(value.resultReceiptVersion) &&
  (value.resultReceiptVersion as number) > 0 &&
  (value.targetPhaseId === null || WORKFLOW_PHASE_IDS.includes(value.targetPhaseId as never)) &&
  isRecord(value.files) &&
  isStringArray(value.files.created) &&
  isStringArray(value.files.modified) &&
  isStringArray(value.files.deleted) &&
  Array.isArray(value.artifacts) &&
  value.artifacts.every((artifact) =>
    hasStringFields(artifact, ["phaseId", "artifactId", "artifactKey", "filePath", "reviewStatus", "contentHash"]) &&
    Number.isSafeInteger(artifact.revision)
  ) &&
  Array.isArray(value.executions) &&
  value.executions.every((execution) =>
    hasStringFields(execution, ["phaseId", "executionId", "status", "command"]) &&
    isNullableString(execution.model) &&
    isNullableString(execution.error) &&
    (execution.exitCode === null || Number.isSafeInteger(execution.exitCode)) &&
    (execution.durationMs === null || (typeof execution.durationMs === "number" && execution.durationMs >= 0))
  ) &&
  isRecord(value.environment) &&
  isRecord(value.tests) &&
  ["totalExecutions", "passedExecutions", "failedExecutions", "pendingExecutions"]
    .every((key) =>
      Number.isSafeInteger((value.tests as Record<string, unknown>)[key])
      && ((value.tests as Record<string, unknown>)[key] as number) >= 0
    ) &&
  (value.git === null || isRunChangeset(value.git)) &&
  isStringArray(value.externalOperations) &&
  isStringArray(value.permissionDecisions) &&
  isStringArray(value.risks) &&
  isStringArray(value.recommendations);

const isWorkflowDefinition = (
  value: unknown,
): value is ProjectDetail["definition"] =>
  isRecord(value) && Array.isArray(value.roles) && Array.isArray(value.phases);

const isProjectDetail = (value: unknown): value is ProjectDetail =>
  isRecord(value) &&
  isProject(value.project) &&
  isWorkflowDefinition(value.definition);

const isPhaseRun = (value: unknown): boolean =>
  hasStringFields(value, ["phaseId", "status"]) &&
  ["artifacts", "reviews", "executions", "events"].every((field) =>
    Array.isArray(value[field]),
  );

const isRunDetail = (value: unknown): value is RunDetail =>
  isRecord(value) &&
  isWorkflowRun(value.run) &&
  isProject(value.project) &&
  isWorkflowDefinition(value.definition) &&
  (value.agentSession === null || (
    isRecord(value.agentSession) &&
    hasStringFields(value.agentSession, ["sessionId"])
  )) &&
  Array.isArray(value.phases) &&
  value.phases.every(isPhaseRun);

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    const accessToken = getAccessToken();
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...init?.headers,
      },
    });
  } catch (error) {
    if (init?.signal?.aborted) throw error;
    throw new ApiError(`无法连接 AI SDLC 服务（${API_URL}）`, 0);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const parsedError = parseApiErrorBody(body);
    throw new ApiError(
      parsedError.message || `请求失败（${response.status}）`,
      response.status,
      parsedError.code,
      parsedError.details,
    );
  }

  return body as T;
}

async function requestBlob(path: string, options: { signal?: AbortSignal } = {}): Promise<Blob> {
  const accessToken = getAccessToken();
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      signal: options.signal,
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ApiError(`无法连接 AI SDLC 服务（${API_URL}）`, 0);
  }
  if (!response.ok) {
    const body = await response.text();
    const parsedError = parseApiErrorBody(body);
    throw new ApiError(parsedError.message || `下载失败（${response.status}）`, response.status);
  }
  return response.blob();
}

function mergeAgentSessionDetail(value: unknown): AgentSession {
  if (!isRecord(value) || !isAgentSession(value.session)) {
    throw new ApiError("服务端返回的 Agent 会话无效。", 502, "INVALID_API_RESPONSE");
  }
  const session = value.session;
  const messages = value.messages ?? [];
  const events = value.events ?? [];
  const toolCalls = value.toolCalls ?? [];
  const humanGates = value.humanGates ?? [];
  // Older Agent Session detail responses predate durable Run associations.
  // Preserve the event-based fallback in the workspace while validating every
  // association whenever the field is present.
  const runs = value.runs ?? [];
  if (
    !Array.isArray(messages) || !messages.every(isAgentMessage) ||
    !Array.isArray(events) || !events.every(isAgentEvent) ||
    !Array.isArray(toolCalls) || !toolCalls.every(isAgentToolCall) ||
    !Array.isArray(humanGates) || !humanGates.every(isAgentHumanGate) ||
    !Array.isArray(runs) || !runs.every(isAgentSessionRun) ||
    !runs.every((run) => run.sessionId === session.id)
  ) {
    throw new ApiError("服务端返回的 Agent 时间线无效。", 502, "INVALID_API_RESPONSE");
  }
  return { ...session, messages, events, toolCalls, humanGates, runs };
}

export const api = {
  baseUrl: API_URL,

  getHealth(): Promise<HealthStatus> {
    return request<HealthStatus>("/api/health");
  },

  async bindRemoteRepository(
    input: BindRemoteRepositoryInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<RepositoryBindingResult> {
    const response = await request<unknown>("/api/repository-bindings", {
      method: "POST",
      body: JSON.stringify(input),
      signal: options.signal,
    });
    if (!isRecord(response) || !isProject(response.project) || !isAgentSession(response.session)) {
      throw new ApiError("服务端返回的仓库绑定结果无效。", 502, "INVALID_API_RESPONSE");
    }
    return { project: response.project, session: response.session };
  },

  async listAgentSessions(
    projectId?: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<AgentSession[]> {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    const response = await request<unknown>(`/api/agent-sessions${query}`, { signal: options.signal });
    return parseCollectionResponse(response, "sessions", "Agent 会话列表响应", isAgentSession);
  },

  async createAgentSession(
    input: {
      clientRequestId?: string;
      title?: string;
      providerId?: AskProviderId;
      primaryProjectId?: string;
    } = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<AgentSession> {
    const response = await request<unknown>("/api/agent-sessions", {
      method: "POST",
      body: JSON.stringify(input),
      signal: options.signal,
    });
    return parseEntityResponse(response, "session", "Agent 会话响应", isAgentSession);
  },

  async getAgentSession(
    sessionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<AgentSession> {
    const response = await request<unknown>(
      `/api/agent-sessions/${encodeURIComponent(sessionId)}`,
      { signal: options.signal },
    );
    return mergeAgentSessionDetail(response);
  },

  async archiveAgentSession(
    sessionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<AgentSession> {
    const response = await request<unknown>(
      `/api/agent-sessions/${encodeURIComponent(sessionId)}`,
      { method: "DELETE", signal: options.signal },
    );
    return parseEntityResponse(response, "session", "Agent 会话归档响应", isAgentSession);
  },

  async sendAgentMessage(
    sessionId: string,
    input: SendAgentMessageInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<AgentSession> {
    const response = await request<unknown>(
      `/api/agent-sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify(input),
        signal: options.signal,
      },
    );
    return mergeAgentSessionDetail(response);
  },

  async advanceAgentRun(
    sessionId: string,
    runId: string,
    input: { expectedPhaseId: AgentRunPhaseId; providerId: AskProviderId },
    options: { signal?: AbortSignal } = {},
  ): Promise<AgentRunAdvanceResult> {
    const response = await request<unknown>(
      `/api/agent-sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/advance`,
      {
        method: "POST",
        body: JSON.stringify(input),
        signal: options.signal,
      },
    );
    return parseDirectResponse(
      response,
      "Agent Run 推进响应",
      isAgentRunAdvanceResult,
    );
  },

  async getProjectAgentSettings(
    projectId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ProjectAgentSettings> {
    const response = await request<unknown>(
      `/api/projects/${encodeURIComponent(projectId)}/agent-settings`,
      { signal: options.signal },
    );
    return parseEntityResponse(response, "settings", "Agent 设置响应", isProjectAgentSettings);
  },

  async updateProjectAgentSettings(
    projectId: string,
    input: {
      expectedVersion: number;
      repoAlias?: string;
      defaultProviderId?: AskProviderId;
      sandboxBlueprintId?: string;
      sandboxBlueprintVersion?: string;
      enabledMcpServerIds?: string[];
    },
  ): Promise<ProjectAgentSettings> {
    const response = await request<unknown>(
      `/api/projects/${encodeURIComponent(projectId)}/agent-settings`,
      { method: "PATCH", body: JSON.stringify(input) },
    );
    return parseEntityResponse(response, "settings", "Agent 设置响应", isProjectAgentSettings);
  },

  async listSandboxBlueprints(
    options: { signal?: AbortSignal } = {},
  ): Promise<SandboxBlueprintSummary[]> {
    const response = await request<unknown>("/api/sandbox-blueprints", { signal: options.signal });
    return parseCollectionResponse(response, "blueprints", "Sandbox 蓝图响应", isSandboxBlueprint);
  },

  async listMcpInstallations(
    options: { signal?: AbortSignal } = {},
  ): Promise<McpInstallationSummary[]> {
    const response = await request<unknown>("/api/mcp/installations", { signal: options.signal });
    return parseCollectionResponse(response, "installations", "MCP 安装列表响应", isMcpInstallation);
  },

  async activateMcp(projectId: string, serverId: string, enabled: boolean): Promise<void> {
    await request<unknown>(
      `/api/projects/${encodeURIComponent(projectId)}/mcp-activations/${encodeURIComponent(serverId)}`,
      { method: "PATCH", body: JSON.stringify({ enabled }) },
    );
  },

  async getLatestDeepWiki(
    projectId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<DeepWikiGeneration | null> {
    const response = await request<unknown>(
      `/api/projects/${encodeURIComponent(projectId)}/deepwiki/generations/latest`,
      { signal: options.signal },
    );
    if (!isRecord(response) || !("generation" in response)) {
      throw new ApiError("DeepWiki 响应无效。", 502, "INVALID_API_RESPONSE");
    }
    if (response.generation === null) return null;
    if (!isDeepWikiGeneration(response.generation)) {
      throw new ApiError("DeepWiki 响应无效。", 502, "INVALID_API_RESPONSE");
    }
    return response.generation;
  },

  async getLatestPublishedDeepWiki(
    projectId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<DeepWikiGeneration | null> {
    const response = await request<unknown>(
      `/api/projects/${encodeURIComponent(projectId)}/deepwiki/generations/published`,
      { signal: options.signal },
    );
    if (!isRecord(response) || !("generation" in response)) {
      throw new ApiError("DeepWiki 已发布版本响应无效。", 502, "INVALID_API_RESPONSE");
    }
    if (response.generation === null) return null;
    if (!isDeepWikiGeneration(response.generation)) {
      throw new ApiError("DeepWiki 已发布版本响应无效。", 502, "INVALID_API_RESPONSE");
    }
    return response.generation;
  },

  async generateDeepWiki(
    projectId: string,
    input: { expectedRevision: string; providerId?: AskProviderId; clientRequestId?: string },
  ): Promise<DeepWikiGeneration> {
    const response = await request<unknown>(
      `/api/projects/${encodeURIComponent(projectId)}/deepwiki/generations`,
      { method: "POST", body: JSON.stringify(input) },
    );
    return parseEntityResponse(response, "generation", "DeepWiki 响应", isDeepWikiGeneration);
  },

  async checkAuth(token?: string): Promise<void> {
    const normalized = token?.trim();
    const response = await request<unknown>("/api/auth/check", {
      headers: normalized ? { Authorization: `Bearer ${normalized}` } : undefined,
    });
    if (!isRecord(response) || !(
      response.authenticated === true || response.ok === true || response.status === "ok"
    )) {
      throw new ApiError("云端 API 没有确认这个访问令牌。", 401, "AUTHENTICATION_FAILED");
    }
  },

  async listAskProviders(
    options: { signal?: AbortSignal } = {},
  ): Promise<AskProviderStatus[]> {
    const response = await request<unknown>("/api/ask/providers", {
      signal: options.signal,
    });
    return parseCollectionResponse(
      response,
      "providers",
      "Ask 模型服务列表响应",
      isAskProviderStatus,
    );
  },

  async checkAskProvider(
    providerId: AskProviderId,
    options: { signal?: AbortSignal } = {},
  ): Promise<AskProviderCheck> {
    const response = await request<unknown>(
      `/api/ask/providers/${encodeURIComponent(providerId)}/check`,
      {
        method: "POST",
        body: JSON.stringify({}),
        signal: options.signal,
      },
    );
    const check = parseEntityResponse(
      response,
      "check",
      "Ask 模型服务检查响应",
      isAskProviderCheck,
    );
    if (check.providerId !== providerId) {
      throw new ApiError(
        "服务端返回的 Ask Provider 检查对象与请求不一致，请刷新页面后重试。",
        502,
        "INVALID_API_RESPONSE",
      );
    }
    return check;
  },

  async listAskProviderConfigurations(
    options: { signal?: AbortSignal } = {},
  ): Promise<AskProviderConfiguration[]> {
    const response = await request<unknown>("/api/ask/provider-configurations", {
      signal: options.signal,
    });
    return parseCollectionResponse(
      response,
      "providers",
      "Provider 配置列表响应",
      isAskProviderConfiguration,
    );
  },

  async saveAskProviderConfiguration(
    providerId: AskProviderId,
    input: SaveAskProviderConfigurationInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<AskProviderConfiguration> {
    const response = await request<unknown>(
      `/api/ask/provider-configurations/${encodeURIComponent(providerId)}`,
      {
        method: "PUT",
        body: JSON.stringify(input),
        signal: options.signal,
      },
    );
    const provider = parseEntityResponse(
      response,
      "provider",
      "Provider 配置响应",
      isAskProviderConfiguration,
    );
    if (provider.providerId !== providerId) {
      throw new ApiError("Provider 配置响应与请求不一致。", 502, "INVALID_API_RESPONSE");
    }
    return provider;
  },

  async checkAskProviderConfiguration(
    providerId: AskProviderId,
    input: { expectedVersion: number },
    options: { signal?: AbortSignal } = {},
  ): Promise<AskProviderConfigurationCheck> {
    const response = await request<unknown>(
      `/api/ask/provider-configurations/${encodeURIComponent(providerId)}/check`,
      {
        method: "POST",
        body: JSON.stringify(input),
        signal: options.signal,
      },
    );
    const check = parseEntityResponse(
      response,
      "check",
      "Provider 配置检查响应",
      isAskProviderConfigurationCheck,
    );
    if (check.providerId !== providerId) {
      throw new ApiError("Provider 配置检查响应与请求不一致。", 502, "INVALID_API_RESPONSE");
    }
    return check;
  },

  async setAskProviderEnabled(
    providerId: AskProviderId,
    input: { expectedVersion: number; enabled: boolean },
    options: { signal?: AbortSignal } = {},
  ): Promise<AskProviderConfiguration> {
    const response = await request<unknown>(
      `/api/ask/provider-configurations/${encodeURIComponent(providerId)}/enabled`,
      {
        method: "PATCH",
        body: JSON.stringify(input),
        signal: options.signal,
      },
    );
    const provider = parseEntityResponse(
      response,
      "provider",
      "Provider 状态响应",
      isAskProviderConfiguration,
    );
    if (provider.providerId !== providerId) {
      throw new ApiError("Provider 状态响应与请求不一致。", 502, "INVALID_API_RESPONSE");
    }
    return provider;
  },

  async askProject(
    projectId: string,
    input: AskProjectInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<AskAnswer> {
    const response = await request<unknown>(
      `/api/projects/${encodeURIComponent(projectId)}/ask`,
      {
        method: "POST",
        body: JSON.stringify(input),
        signal: options.signal,
      },
    );
    const answer = parseEntityResponse(response, "answer", "Ask 回答响应", isAskAnswer);
    if (answer.provider.id !== input.providerId) {
      throw new ApiError(
        "服务端使用了与请求不一致的 Ask Provider，本次回答没有加入对话。",
        502,
        "INVALID_API_RESPONSE",
      );
    }
    return answer;
  },

  async listAskThreads(
    projectId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<AskThreadSummary[]> {
    const response = await request<unknown>(
      `/api/projects/${encodeURIComponent(projectId)}/ask-threads`,
      { signal: options.signal },
    );
    return parseCollectionResponse(response, "threads", "Ask 对话列表响应", isAskThreadSummary);
  },

  async createAskThread(
    projectId: string,
    input: CreateAskThreadInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<AskThread> {
    const response = await request<unknown>(
      `/api/projects/${encodeURIComponent(projectId)}/ask-threads`,
      {
        method: "POST",
        body: JSON.stringify(input),
        signal: options.signal,
      },
    );
    return parseEntityResponse(response, "thread", "Ask 对话响应", isAskThread);
  },

  async getAskThread(
    threadId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<AskThread> {
    const response = await request<unknown>(
      `/api/ask-threads/${encodeURIComponent(threadId)}`,
      { signal: options.signal },
    );
    return parseEntityResponse(response, "thread", "Ask 对话响应", isAskThread);
  },

  async askThread(
    threadId: string,
    input: AskThreadQuestionInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<AskThread> {
    const response = await request<unknown>(
      `/api/ask-threads/${encodeURIComponent(threadId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify(input),
        signal: options.signal,
      },
    );
    return parseEntityResponse(response, "thread", "Ask 对话响应", isAskThread);
  },

  getCodexCapabilities(runId: string): Promise<CodexCapabilities> {
    return request<CodexCapabilities>(
      `/api/runs/${encodeURIComponent(runId)}/codex/capabilities`,
    );
  },

  async getFigmaIntegration(
    runId: string,
    options: { force?: boolean } = {},
  ): Promise<FigmaIntegrationStatus> {
    const forceQuery = options.force ? "?force=true" : "";
    const response = await request<
      { integration: FigmaIntegrationStatus } | FigmaIntegrationStatus
    >(`/api/runs/${encodeURIComponent(runId)}/integrations/figma${forceQuery}`);
    return "integration" in response ? response.integration : response;
  },

  async getFigmaPlans(
    runId: string,
    options: { force?: boolean } = {},
  ): Promise<FigmaPlanCapabilities> {
    const forceQuery = options.force ? "?force=true" : "";
    return request<FigmaPlanCapabilities>(
      `/api/runs/${encodeURIComponent(runId)}/integrations/figma/plans${forceQuery}`,
    );
  },

  async listProjects(): Promise<Project[]> {
    const response = await request<unknown>("/api/projects");
    return parseCollectionResponse(response, "projects", "项目列表响应", isProject);
  },

  async createProject(
    input: CreateProjectInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<Project> {
    const response = await request<unknown>("/api/projects", {
      method: "POST",
      body: JSON.stringify(input),
      signal: options.signal,
    });
    return parseEntityResponse(response, "project", "项目响应", isProject);
  },

  async listRepositoryCredentials(
    host?: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<RepositoryCredentialProfile[]> {
    const query = host ? `?host=${encodeURIComponent(host)}` : "";
    const response = await request<unknown>(`/api/repository-credentials${query}`, {
      signal: options.signal,
    });
    return parseCollectionResponse(
      response,
      "credentials",
      "仓库凭据列表响应",
      isRepositoryCredential,
    );
  },

  async listWorkItemAdapters(
    options: { signal?: AbortSignal } = {},
  ): Promise<WorkItemAdapterSummary[]> {
    const response = await request<unknown>("/api/work-item-adapters", {
      signal: options.signal,
    });
    return parseCollectionResponse(
      response,
      "adapters",
      "工作项来源列表响应",
      isWorkItemAdapterSummary,
    );
  },

  async resolveWorkItem(
    input: ResolveWorkItemInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<WorkItemDraft> {
    const response = await request<unknown>("/api/work-items/resolve", {
      method: "POST",
      body: JSON.stringify(input),
      signal: options.signal,
    });
    const workItem = parseEntityResponse(
      response,
      "workItem",
      "工作项响应",
      isWorkItemDraft,
    );
    if (workItem.source.adapterId !== input.adapterId) {
      throw new ApiError(
        "服务端返回了不匹配的工作项来源，本次内容没有采用。",
        502,
        "INVALID_API_RESPONSE",
      );
    }
    return workItem;
  },

  async syncProjectRepository(
    projectId: string,
    expectedRevision?: string,
  ): Promise<Project> {
    const response = await request<unknown>(
      `/api/projects/${encodeURIComponent(projectId)}/repository/sync`,
      {
        method: "POST",
        body: JSON.stringify(expectedRevision ? { expectedRevision } : {}),
      },
    );
    return parseEntityResponse(response, "project", "仓库同步响应", isProject);
  },

  async getProjectKnowledge(
    projectId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ProjectKnowledge | null> {
    const response = await request<unknown>(
      `/api/projects/${encodeURIComponent(projectId)}/knowledge`,
      { signal: options.signal },
    );
    const knowledge = isRecord(response) && "knowledge" in response
      ? response.knowledge
      : response;
    if (knowledge === null) return null;
    if (!isProjectKnowledge(knowledge)) {
      throw new ApiError("服务端返回的项目知识状态无效，请刷新后重试。", 502, "INVALID_API_RESPONSE");
    }
    return knowledge;
  },

  async getE2eWorkspace(projectId: string): Promise<E2eWorkspace | null> {
    const response = await request<
      { workspace: E2eWorkspace | null } | E2eWorkspace | null
    >(`/api/projects/${encodeURIComponent(projectId)}/e2e-workspace`);
    return response && typeof response === "object" && "workspace" in response
      ? response.workspace
      : response;
  },

  async configureE2eWorkspace(
    projectId: string,
    input: ConfigureE2eWorkspaceInput,
  ): Promise<E2eWorkspace> {
    const response = await request<{ workspace: E2eWorkspace } | E2eWorkspace>(
      `/api/projects/${encodeURIComponent(projectId)}/e2e-workspace`,
      { method: "PUT", body: JSON.stringify(input) },
    );
    return "workspace" in response ? response.workspace : response;
  },

  async prepareE2eWorkspace(projectId: string): Promise<E2eWorkspaceReadiness> {
    const response = await request<
      { readiness: E2eWorkspaceReadiness } | E2eWorkspaceReadiness
    >(
      `/api/projects/${encodeURIComponent(projectId)}/e2e-workspace/prepare`,
      { method: "POST", body: JSON.stringify({}) },
    );
    return "readiness" in response ? response.readiness : response;
  },

  async getProject(projectId: string): Promise<ProjectDetail> {
    const response = await request<unknown>(
      `/api/projects/${encodeURIComponent(projectId)}`,
    );
    return parseDirectResponse(response, "项目详情响应", isProjectDetail);
  },

  async listRuns(projectId: string): Promise<WorkflowRun[]> {
    const response = await request<unknown>(
      `/api/projects/${encodeURIComponent(projectId)}/runs`,
    );
    return parseCollectionResponse(response, "runs", "工作流列表响应", isWorkflowRun);
  },

  async createRun(projectId: string, input: CreateRunInput): Promise<WorkflowRun> {
    const response = await request<unknown>(
      `/api/projects/${encodeURIComponent(projectId)}/runs`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
    return parseEntityResponse(response, "run", "工作流响应", isWorkflowRun);
  },

  async getRun(runId: string): Promise<RunDetail> {
    const response = await request<unknown>(`/api/runs/${encodeURIComponent(runId)}`);
    return parseDirectResponse(response, "工作流详情响应", isRunDetail);
  },

  async getRunResult(runId: string): Promise<RunResultReceipt> {
    const response = await request<unknown>(
      `/api/runs/${encodeURIComponent(runId)}/result`,
    );
    return parseEntityResponse(response, "result", "Run 结果收据响应", isRunResultReceipt);
  },

  async getRunChangeset(
    runId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<RunChangeset | null> {
    const response = await request<unknown>(
      `/api/runs/${encodeURIComponent(runId)}/changeset`,
      { signal: options.signal },
    );
    const changeset = isRecord(response) && "changeset" in response
      ? response.changeset
      : response;
    if (changeset === null) return null;
    if (!isRunChangeset(changeset)) {
      throw new ApiError("服务端返回的代码变更集无效，请刷新后重试。", 502, "INVALID_API_RESPONSE");
    }
    return changeset;
  },

  downloadRunPatch(
    runId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<Blob> {
    return requestBlob(`/api/runs/${encodeURIComponent(runId)}/changeset/patch`, options);
  },

  async getVerificationE2eFlow(runId: string): Promise<VerificationE2eFlow> {
    const response = await request<{ flow: VerificationE2eFlow } | VerificationE2eFlow>(
      `/api/runs/${encodeURIComponent(runId)}/verification/e2e-flow`,
    );
    return "flow" in response ? response.flow : response;
  },

  async preflightVerificationE2e(runId: string): Promise<VerificationE2eFlow> {
    const response = await request<{ flow: VerificationE2eFlow } | VerificationE2eFlow>(
      `/api/runs/${encodeURIComponent(runId)}/verification/e2e-flow`,
      { method: "POST", body: JSON.stringify({ action: "preflight" }) },
    );
    return "flow" in response ? response.flow : response;
  },

  async authorVerificationE2e(
    runId: string,
    input: VerificationE2eSelectionInput,
  ): Promise<Execution> {
    const response = await request<{ execution: Execution } | Execution>(
      `/api/runs/${encodeURIComponent(runId)}/verification/e2e-flow/author`,
      { method: "POST", body: JSON.stringify(input) },
    );
    return "execution" in response ? response.execution : response;
  },

  async reviewVerificationE2eScript(
    runId: string,
    input: VerificationE2eScriptReviewInput,
  ): Promise<VerificationE2eFlow> {
    const response = await request<{ flow: VerificationE2eFlow } | VerificationE2eFlow>(
      `/api/runs/${encodeURIComponent(runId)}/verification/e2e-flow/script-review`,
      { method: "POST", body: JSON.stringify(input) },
    );
    return "flow" in response ? response.flow : response;
  },

  async executeVerificationE2e(
    runId: string,
    input: VerificationE2eSelectionInput,
  ): Promise<Execution> {
    const response = await request<{ execution: Execution } | Execution>(
      `/api/runs/${encodeURIComponent(runId)}/verification/e2e-flow`,
      {
        method: "POST",
        body: JSON.stringify({ action: "execute", ...input }),
      },
    );
    return "execution" in response ? response.execution : response;
  },

  async getHumanDecisions(runId: string): Promise<HumanDecisionSummary> {
    const response = await request<unknown>(
      `/api/runs/${encodeURIComponent(runId)}/human-decisions`,
    );
    return parseDirectResponse(
      response,
      "决定与待办响应",
      isHumanDecisionSummary,
    );
  },

  captureHumanDecisions(
    runId: string,
    phaseId: HumanDecisionPhaseId,
    responses: Array<{ id: string; response: string }>,
    expectedArtifactIds: string[],
  ): Promise<{ review: Review; run?: WorkflowRun }> {
    return request<{ review: Review; run?: WorkflowRun }>(
      `/api/runs/${encodeURIComponent(runId)}/phases/${encodeURIComponent(phaseId)}/human-decisions`,
      {
        method: "POST",
        body: JSON.stringify({ responses, expectedArtifactIds }),
      },
    );
  },

  async listTickets(runId: string): Promise<TicketSummary[]> {
    const response = await request<unknown>(
      `/api/runs/${encodeURIComponent(runId)}/tickets`,
    );
    return parseCollectionResponse(response, "tickets", "工单列表响应", isTicketSummary);
  },

  async getTicket(runId: string, ticketId: string): Promise<TicketDetail> {
    const response = await request<unknown>(
      `/api/runs/${encodeURIComponent(runId)}/tickets/${encodeURIComponent(ticketId)}`,
    );
    return parseEntityResponse(response, "ticket", "工单详情响应", isTicketDetail);
  },

  async updateTicketStatus(
    runId: string,
    ticketId: string,
    status: TicketStatus,
  ): Promise<TicketSummary> {
    const response = await request<unknown>(
      `/api/runs/${encodeURIComponent(runId)}/tickets/${encodeURIComponent(ticketId)}/status`,
      { method: "PATCH", body: JSON.stringify({ status }) },
    );
    return parseEntityResponse(response, "ticket", "工单状态响应", isTicketSummary);
  },

  async executePhase(
    runId: string,
    phaseId: string,
    selectedArtifactIds: string[],
    selectedOutputKeys: string[],
    options: {
      model?: string;
      reasoningEffort?: CodexReasoningEffort;
      figmaTarget?: FigmaTarget;
      verificationAction?: VerificationE2eAction;
    } = {},
  ) {
    const response = await request<{ execution: Execution } | Execution>(
      `/api/runs/${encodeURIComponent(runId)}/phases/${encodeURIComponent(phaseId)}/execute`,
      {
        method: "POST",
        body: JSON.stringify({ selectedArtifactIds, selectedOutputKeys, ...options }),
      },
    );
    return "execution" in response ? response.execution : response;
  },

  assessArchitectureImpact(
    runId: string,
    input: AssessArchitectureDispositionInput,
  ): Promise<unknown> {
    return request<unknown>(
      `/api/runs/${encodeURIComponent(runId)}/phases/architecture/impact`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
  },

  waiveArchitecture(
    runId: string,
    inputArtifactIds: string[],
    rationale: string,
  ): Promise<unknown> {
    return this.assessArchitectureImpact(runId, {
      mode: "skip",
      rationale,
      selectedArtifactIds: inputArtifactIds,
      expectedBaselineArtifactIds: [],
      affectedOutputKeys: [],
    });
  },

  assessProductImpact(
    runId: string,
    input: AssessProductImpactInput,
  ): Promise<unknown> {
    return request<unknown>(
      `/api/runs/${encodeURIComponent(runId)}/phases/discovery/impact`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
  },

  assessDesignImpact(
    runId: string,
    input: AssessDesignImpactInput,
  ): Promise<unknown> {
    return request<unknown>(
      `/api/runs/${encodeURIComponent(runId)}/phases/design/impact`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
  },

  async reviewPhase(
    runId: string,
    phaseId: string,
    decision: ReviewDecision,
    comment: string,
    expectedArtifactIds: string[],
  ): Promise<{ review: Review; run?: WorkflowRun }> {
    const response = await request<{ review: Review; run?: WorkflowRun } | Review>(
      `/api/runs/${encodeURIComponent(runId)}/phases/${encodeURIComponent(phaseId)}/review`,
      {
        method: "POST",
        body: JSON.stringify({ decision, comment, expectedArtifactIds }),
      },
    );
    return "review" in response ? response : { review: response };
  },

  async getArtifact(artifactId: string): Promise<Artifact> {
    const response = await request<{ artifact: Artifact } | Artifact>(
      `/api/artifacts/${encodeURIComponent(artifactId)}`,
    );
    return "artifact" in response ? response.artifact : response;
  },

  async createArtifactRevision(
    artifactId: string,
    input: CreateArtifactRevisionInput,
  ): Promise<Artifact> {
    const response = await request<{ artifact: Artifact } | Artifact>(
      `/api/artifacts/${encodeURIComponent(artifactId)}/revisions`,
      { method: "POST", body: JSON.stringify(input) },
    );
    return "artifact" in response ? response.artifact : response;
  },

  async getExecutionEvents(executionId: string): Promise<RunEvent[]> {
    const response = await request<unknown>(
      `/api/executions/${encodeURIComponent(executionId)}/events`,
    );
    return parseCollectionResponse(response, "events", "执行事件响应", isRunEvent);
  },
};
