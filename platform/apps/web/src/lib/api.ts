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

const API_URL = (import.meta.env.VITE_API_URL || "http://localhost:4100").replace(/\/$/, "");

export class ApiError extends Error {
  status: number;
  code?: string;
  details?: unknown;

  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

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
  } catch {
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
    const response = await request<{ projects: Project[] } | Project[]>("/api/projects");
    return Array.isArray(response) ? response : response.projects ?? [];
  },

  async createProject(input: CreateProjectInput): Promise<Project> {
    const response = await request<{ project: Project } | Project>("/api/projects", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return "project" in response ? response.project : response;
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

  getProject(projectId: string): Promise<ProjectDetail> {
    return request<ProjectDetail>(`/api/projects/${encodeURIComponent(projectId)}`);
  },

  async listRuns(projectId: string): Promise<WorkflowRun[]> {
    const response = await request<{ runs: WorkflowRun[] } | WorkflowRun[]>(
      `/api/projects/${encodeURIComponent(projectId)}/runs`,
    );
    return Array.isArray(response) ? response : response.runs ?? [];
  },

  async createRun(projectId: string, input: CreateRunInput): Promise<WorkflowRun> {
    const response = await request<{ run: WorkflowRun } | WorkflowRun>(
      `/api/projects/${encodeURIComponent(projectId)}/runs`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
    return "run" in response ? response.run : response;
  },

  getRun(runId: string): Promise<RunDetail> {
    return request<RunDetail>(`/api/runs/${encodeURIComponent(runId)}`);
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
    const response = await request<{ tickets: TicketSummary[] } | TicketSummary[]>(
      `/api/runs/${encodeURIComponent(runId)}/tickets`,
    );
    return Array.isArray(response) ? response : response.tickets ?? [];
  },

  async getTicket(runId: string, ticketId: string): Promise<TicketDetail> {
    const response = await request<{ ticket: TicketDetail } | TicketDetail>(
      `/api/runs/${encodeURIComponent(runId)}/tickets/${encodeURIComponent(ticketId)}`,
    );
    return "ticket" in response ? response.ticket : response;
  },

  async updateTicketStatus(
    runId: string,
    ticketId: string,
    status: TicketStatus,
  ): Promise<TicketSummary> {
    const response = await request<{ ticket: TicketSummary } | TicketSummary>(
      `/api/runs/${encodeURIComponent(runId)}/tickets/${encodeURIComponent(ticketId)}/status`,
      { method: "PATCH", body: JSON.stringify({ status }) },
    );
    return "ticket" in response ? response.ticket : response;
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
    const response = await request<{ events: RunEvent[] } | RunEvent[]>(
      `/api/executions/${encodeURIComponent(executionId)}/events`,
    );
    return Array.isArray(response) ? response : response.events ?? [];
  },
};
