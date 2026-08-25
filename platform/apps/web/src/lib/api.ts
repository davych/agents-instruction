import type {
  Artifact,
  AssessArchitectureDispositionInput,
  AssessDesignImpactInput,
  AssessProductImpactInput,
  CodexCapabilities,
  CodexReasoningEffort,
  ConfigureE2eWorkspaceInput,
  CreateArtifactRevisionInput,
  CreateProjectInput,
  CreateRunInput,
  Execution,
  E2eWorkspace,
  E2eWorkspaceReadiness,
  FigmaIntegrationStatus,
  FigmaPlanCapabilities,
  FigmaTarget,
  HealthStatus,
  HumanDecisionPhaseId,
  HumanDecisionSummary,
  Project,
  ProjectDetail,
  Review,
  ReviewDecision,
  RunDetail,
  RunEvent,
  TicketDetail,
  TicketStatus,
  TicketSummary,
  WorkflowRun,
  VerificationE2eFlow,
  VerificationE2eAction,
  VerificationE2eScriptReviewInput,
  VerificationE2eSelectionInput,
} from "@/lib/types";
import { parseApiErrorBody } from "@/lib/api-error";
import {
  ApiError,
  hasStringFields,
  isRecord,
  parseCollectionResponse,
  parseDirectResponse,
  parseEntityResponse,
} from "@/lib/api-response";

export { ApiError } from "@/lib/api-response";

const API_URL = (import.meta.env.VITE_API_URL || "http://localhost:4100").replace(/\/$/, "");

const isProject = (value: unknown): value is Project =>
  hasStringFields(value, ["id", "name", "rootPath"]);

const isWorkflowRun = (value: unknown): value is WorkflowRun =>
  hasStringFields(value, ["id", "projectId", "title"]);

const isTicketSummary = (value: unknown): value is TicketSummary =>
  hasStringFields(value, ["id", "workflowRunId", "identifier", "title", "status"]) &&
  ["backlog", "todo", "in_progress", "done"].includes(value.status as string);

const isTicketDetail = (value: unknown): value is TicketDetail =>
  isTicketSummary(value) &&
  typeof (value as TicketSummary & { content?: unknown }).content === "string";

const isRunEvent = (value: unknown): value is RunEvent =>
  hasStringFields(value, ["id"]);

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
  Array.isArray(value.phases) &&
  value.phases.every(isPhaseRun);

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch (error) {
    if (init?.signal?.aborted) throw error;
    throw new ApiError(`无法连接本地服务（${API_URL}）`, 0);
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

export const api = {
  baseUrl: API_URL,

  getHealth(): Promise<HealthStatus> {
    return request<HealthStatus>("/api/health");
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

  getHumanDecisions(runId: string): Promise<HumanDecisionSummary> {
    return request<HumanDecisionSummary>(
      `/api/runs/${encodeURIComponent(runId)}/human-decisions`,
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
