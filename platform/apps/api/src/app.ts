import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CODEX_REASONING_EFFORTS,
  agentEventSchema,
  agentHumanGateSchema,
  agentMessageSchema,
  agentSessionSchema,
  agentToolCallSchema,
  askProviderConfigurationCheckSchema,
  askProviderConfigurationSchema,
  bindRemoteRepositorySchema,
  type CodexReasoningEffort,
  createAgentSessionSchema,
  deepWikiGenerationSchema,
  generateDeepWikiSchema,
  gitRevisionSchema,
  askProjectSchema,
  askProviderIdSchema,
  checkAskProviderConfigurationSchema,
  createAskThreadSchema,
  assessArchitectureDispositionSchema,
  assessDesignImpactSchema,
  assessProductImpactSchema,
  authorVerificationE2eSchema,
  captureHumanDecisionsSchema,
  configureE2eWorkspaceSchema,
  createArtifactRevisionSchema,
  createProjectSchema,
  remoteGitCreateProjectSchema,
  createRunSchema,
  executePhaseSchema,
  mcpActivationSchema,
  mcpInstallationSummarySchema,
  mcpServerIdSchema,
  phaseIdSchema,
  projectAgentSettingsSchema,
  publicProjectSchema,
  resolveWorkItemSchema,
  reviewVerificationE2eScriptsSchema,
  reviewPhaseSchema,
  sandboxBlueprintSummarySchema,
  sendAgentMessageSchema,
  sendAskThreadMessageSchema,
  setAskProviderEnabledSchema,
  updateAskProviderConfigurationSchema,
  updateProjectAgentSettingsSchema,
  updateTicketStatusSchema,
  verificationE2eFlowActionSchema,
  type AgentEventDto,
  type AgentHumanGateDto,
  type AgentMessageDto,
  type AgentSessionDto,
  type AgentToolCallDto,
  type BindRemoteRepositoryInput,
  type CreateAgentSessionInput,
  type DeepWikiGenerationDto,
  type GenerateDeepWikiInput,
  type McpActivationDto,
  type McpInstallationSummaryDto,
  type ProjectAgentSettingsDto,
  type PublicProjectDto,
  type SandboxBlueprintSummaryDto,
  type SendAgentMessageInput,
  type UpdateProjectAgentSettingsInput,
} from "@ai-sdlc/contracts";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import { z, ZodError } from "zod";

import { PgWorkflowStore } from "./db/store.js";
import { AppError } from "./domain/errors.js";
import { AskService } from "./services/ask/ask-service.js";
import { AskThreadService } from "./services/ask/ask-thread-service.js";
import { AgentSessionService } from "./services/agent/agent-session-service.js";
import { ConversationPlanner } from "./services/agent/conversation-planner.js";
import { DeepWikiGenerationService } from "./services/agent/deepwiki-generation-service.js";
import { AgentMcpToolRouter } from "./services/agent/mcp-tool-router.js";
import {
  McpCatalogService,
  ProjectAgentSettingsService,
} from "./services/agent/project-agent-capability-service.js";
import { ReadOnlyRepositoryContextResolver } from "./services/agent/read-only-repository-context.js";
import { RepositoryBindingService } from "./services/agent/repository-binding-service.js";
import {
  createSandboxBlueprintRegistryFromEnv,
  type SandboxBlueprintRegistry,
} from "./services/agent/sandbox-blueprint-registry.js";
import { CloudProjectService } from "./services/cloud-project-service.js";
import {
  assertBearerAuthorization,
  isOriginAllowed,
  normalizeAccessToken,
  normalizeAllowedOrigins,
} from "./services/access-control.js";
import { CodexTerminalRunner } from "./services/codex-runner.js";
import { CodexExecutionCapabilities } from "./services/codex-execution-capabilities.js";
import {
  E2eAutomationRunner,
  E2eTestAuthorRunner,
} from "./services/e2e-automation-runner.js";
import { E2eWorkspaceService } from "./services/e2e-workspace-service.js";
import { FigmaMcpIntegration } from "./services/figma-mcp-integration.js";
import { DeepWikiLiteIndexer } from "./services/deepwiki-lite.js";
import { GitBroker, type GitBrokerOptions } from "./services/git-broker.js";
import { GitCredentialRegistry } from "./services/git-credential-registry.js";
import { presentAppError } from "./services/http-error-presenter.js";
import {
  AskProviderRegistry,
  createAskProviderRegistryFromEnv,
} from "./services/llm/provider-registry.js";
import { ProviderConfigurationService } from "./services/llm/provider-configuration-service.js";
import { ProjectKnowledgeResolver } from "./services/project-knowledge.js";
import { ProjectPathPolicy } from "./services/project-paths.js";
import { RepositoryPolicy } from "./services/repository-policy.js";
import { VerificationE2eCoordinator } from "./services/verification-e2e-coordinator.js";
import {
  createWorkItemMcpRegistryFromEnv,
  type WorkItemMcpRegistry,
} from "./services/work-item/work-item-mcp-registry.js";
import { WorkflowService } from "./services/workflow-service.js";

export interface AgentSessionDetailDto {
  session: AgentSessionDto;
  messages: AgentMessageDto[];
  events: AgentEventDto[];
  toolCalls: AgentToolCallDto[];
  humanGates: AgentHumanGateDto[];
}

export interface RepositoryBindingServiceLike {
  bind(
    input: BindRemoteRepositoryInput,
    signal?: AbortSignal,
  ): Promise<{ project: PublicProjectDto; session: AgentSessionDto }>;
}

export interface AgentSessionServiceLike {
  list(projectId?: string): Promise<AgentSessionDto[]>;
  get(sessionId: string): Promise<AgentSessionDetailDto>;
  create(input: CreateAgentSessionInput): Promise<AgentSessionDto>;
  sendMessage(
    sessionId: string,
    input: SendAgentMessageInput,
    signal?: AbortSignal,
  ): Promise<AgentSessionDetailDto>;
}

export interface ProjectAgentSettingsServiceLike {
  get(projectId: string): Promise<ProjectAgentSettingsDto>;
  update(
    projectId: string,
    input: UpdateProjectAgentSettingsInput,
  ): Promise<ProjectAgentSettingsDto>;
}

export interface SandboxBlueprintCatalogLike {
  list(): Promise<SandboxBlueprintSummaryDto[]> | SandboxBlueprintSummaryDto[];
}

export interface McpCatalogLike {
  list(): Promise<McpInstallationSummaryDto[]> | McpInstallationSummaryDto[];
  activate(
    projectId: string,
    serverId: string,
    enabled: boolean,
  ): Promise<McpActivationDto>;
}

export interface DeepWikiGenerationServiceLike {
  getLatest(projectId: string): Promise<DeepWikiGenerationDto | null>;
  generate(
    projectId: string,
    input: GenerateDeepWikiInput,
    signal?: AbortSignal,
  ): Promise<DeepWikiGenerationDto>;
}

export interface AppOptions {
  pool: pg.Pool;
  logger?: boolean;
  allowedProjectRoots?: string[];
  codexBinary?: string;
  fakeCodex?: boolean;
  codexTimeoutMs?: number;
  codexAllowedModels?: string[];
  codexAllowedReasoningEfforts?: CodexReasoningEffort[];
  codexDefaultModel?: string;
  codexDefaultReasoningEffort?: CodexReasoningEffort;
  codexHome?: string;
  dockerWorkerUser?: string;
  dockerWorkerImage?: string;
  dockerDeploymentId?: string;
  trustedExecutionRepositories?: string[];
  maxConcurrentPhases?: number;
  recoverChatAgentRuntimeOnStart?: boolean;
  cliPath?: string;
  verificationE2eCoordinator?: VerificationE2eCoordinator;
  askProviders?: AskProviderRegistry;
  providerConfigurations?: ProviderConfigurationService;
  workItemAdapters?: WorkItemMcpRegistry;
  repositoryBindings?: RepositoryBindingServiceLike;
  agentSessions?: AgentSessionServiceLike;
  projectAgentSettings?: ProjectAgentSettingsServiceLike;
  sandboxBlueprints?: SandboxBlueprintCatalogLike;
  mcpCatalog?: McpCatalogLike;
  deepWikiGenerations?: DeepWikiGenerationServiceLike;
  sandboxBlueprintRegistry?: SandboxBlueprintRegistry;
  accessToken?: string;
  allowedOrigins?: string[];
  cloud?: {
    managedRoot: string;
    repositoryPolicy: RepositoryPolicy;
    credentials: GitCredentialRegistry;
    gitBrokerOptions?: Omit<GitBrokerOptions, "policy" | "credentials">;
    deepWiki?: DeepWikiLiteIndexer;
  };
}

const idParamsSchema = z.object({ id: z.string().uuid() });
const agentSessionParamsSchema = z.object({ id: z.string().uuid() }).strict();
const mcpActivationParamsSchema = z.object({
  id: z.string().uuid(),
  serverId: mcpServerIdSchema,
}).strict();
const mcpActivationBodySchema = z.object({ enabled: z.boolean() }).strict();
const emptyQuerySchema = z.object({}).strict();
const agentSessionListQuerySchema = z.object({
  projectId: z.string().uuid().optional(),
}).strict();
const phaseParamsSchema = z.object({ id: z.string().uuid(), phaseId: phaseIdSchema });
const humanDecisionParamsSchema = z.object({
  id: z.string().uuid(),
  phaseId: z.enum(["discovery", "design", "architecture"]),
});
const ticketParamsSchema = z.object({ id: z.string().uuid(), ticketId: z.string().uuid() });
const figmaIntegrationQuerySchema = z.object({
  force: z.enum(["true", "false"]).optional()
});
const askProviderParamsSchema = z.object({ providerId: askProviderIdSchema }).strict();
const repositoryCredentialQuerySchema = z.object({
  host: z.string().trim().min(1).max(300).optional(),
}).strict();
const repositorySyncSchema = z.object({
  expectedRevision: gitRevisionSchema.optional(),
}).strict();
const pruneWorkspacesSchema = z.object({
  dryRun: z.boolean().default(true),
  olderThanHours: z.number().finite().min(0).max(8_760).default(24),
  limit: z.number().int().min(1).max(500).default(100),
}).strict();
const artifactRevisionBodyLimit = 12_100_000;

const repositoryBindingResponseSchema = z.object({
  project: publicProjectSchema,
  session: agentSessionSchema,
}).strict();
const agentSessionDetailSchema = z.object({
  session: agentSessionSchema,
  messages: z.array(agentMessageSchema),
  events: z.array(agentEventSchema),
  toolCalls: z.array(agentToolCallSchema),
  humanGates: z.array(agentHumanGateSchema),
}).strict();

function requireChatFirstPort<T>(port: T | undefined, name: string): T {
  if (port) return port;
  throw new AppError(
    `${name} 尚未配置`,
    501,
    "CHAT_FIRST_PORT_NOT_CONFIGURED",
  );
}

function parsePublicPortResult<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  value: unknown,
): z.infer<TSchema> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new AppError(
    "服务结果未通过公开契约校验",
    500,
    "INVALID_PUBLIC_SERVICE_RESPONSE",
  );
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  const accessToken = normalizeAccessToken(options.accessToken);
  const allowedOrigins = normalizeAllowedOrigins(options.allowedOrigins);
  const allowedProjectRoots = options.cloud
    ? [options.cloud.managedRoot]
    : options.allowedProjectRoots ?? [defaultRepositoryRoot()];
  const paths = new ProjectPathPolicy(allowedProjectRoots);
  const store = new PgWorkflowStore(options.pool);
  const deepWiki = options.cloud
    ? options.cloud.deepWiki ?? new DeepWikiLiteIndexer()
    : undefined;
  const projectKnowledge = deepWiki
    ? new ProjectKnowledgeResolver(store, deepWiki)
    : undefined;
  const cloudProjects = options.cloud
    ? await CloudProjectService.create({
      store,
      managedRoot: options.cloud.managedRoot,
      repositoryPolicy: options.cloud.repositoryPolicy,
      credentials: options.cloud.credentials,
      gitBroker: new GitBroker({
        policy: options.cloud.repositoryPolicy,
        credentials: options.cloud.credentials,
        ...options.cloud.gitBrokerOptions,
      }),
      deepWiki,
      cliPath: options.cliPath,
    })
    : undefined;
  await app.register(cors, {
    origin: (origin, callback) => {
      if (isOriginAllowed(origin, allowedOrigins)) callback(null, true);
      else callback(new Error("Origin not allowed"), false);
    }
  });
  app.addHook("onRequest", async (request) => {
    if (request.method === "OPTIONS" || request.url === "/api/health") return;
    assertBearerAuthorization(request.headers.authorization, accessToken);
  });
  const runner = new CodexTerminalRunner({
    binary: options.codexBinary,
    dockerImage: options.dockerWorkerImage,
    dockerDeploymentId: options.dockerDeploymentId,
    dockerUser: options.dockerWorkerUser,
    trustedRepositoryUrls: options.trustedExecutionRepositories,
    fake: options.fakeCodex,
    timeoutMs: options.codexTimeoutMs
  });
  const figmaIntegration = new FigmaMcpIntegration({ binary: options.codexBinary });
  const codexCapabilities = new CodexExecutionCapabilities({
    binary: options.codexBinary,
    allowedModels: options.codexAllowedModels,
    allowedReasoningEfforts: options.codexAllowedReasoningEfforts,
    defaultModel: options.codexDefaultModel,
    defaultReasoningEffort: options.codexDefaultReasoningEffort,
    codexHome: options.codexHome,
    catalog: options.codexAllowedModels?.map((id) => {
      const reasoningEfforts = options.codexAllowedReasoningEfforts
        ?? CODEX_REASONING_EFFORTS;
      return {
        id,
        name: id,
        defaultReasoningEffort: options.codexDefaultReasoningEffort
          ?? reasoningEfforts[0]!,
        reasoningEfforts: [...reasoningEfforts],
      };
    }),
  });
  const verificationE2e = options.verificationE2eCoordinator
    ?? new VerificationE2eCoordinator({
      workspaceService: new E2eWorkspaceService({ allowedRoots: allowedProjectRoots }),
      authorRunner: new E2eTestAuthorRunner({
        codexBinary: options.codexBinary,
        timeoutMs: options.codexTimeoutMs,
      }),
      automationRunner: new E2eAutomationRunner(),
    });
  const service = new WorkflowService(
    store,
    paths,
    runner,
    options.cliPath,
    figmaIntegration,
    codexCapabilities,
    verificationE2e,
    cloudProjects,
    projectKnowledge,
    options.maxConcurrentPhases,
  );
  const providerConfigurations = options.providerConfigurations;
  const providers = providerConfigurations?.providers
    ?? options.askProviders
    ?? createAskProviderRegistryFromEnv({});
  const ask = new AskService(
    store,
    paths,
    providers,
    undefined,
    projectKnowledge,
  );
  const askThreads = new AskThreadService(store, ask);
  const workItemAdapters = options.workItemAdapters ?? createWorkItemMcpRegistryFromEnv({});
  const sandboxBlueprintRegistry = options.sandboxBlueprintRegistry
    ?? createSandboxBlueprintRegistryFromEnv(
      {},
      options.dockerWorkerImage ?? (options.fakeCodex ? "ai-sdlc/fake-worker:local" : undefined),
    );

  let defaultAgentSessions: AgentSessionService | undefined;
  let defaultRepositoryBindings: RepositoryBindingService | undefined;
  let defaultProjectAgentSettings: ProjectAgentSettingsService | undefined;
  let defaultMcpCatalog: McpCatalogService | undefined;
  let defaultDeepWikiGenerations: DeepWikiGenerationService | undefined;
  if (cloudProjects && projectKnowledge) {
    defaultMcpCatalog = new McpCatalogService(store, workItemAdapters);
    defaultProjectAgentSettings = new ProjectAgentSettingsService(
      store,
      providers,
      sandboxBlueprintRegistry,
      defaultMcpCatalog,
    );
    defaultAgentSessions = new AgentSessionService(
      store,
      ask,
      providers,
      new ConversationPlanner(providers),
      new AgentMcpToolRouter(providers, workItemAdapters),
      service,
      cloudProjects,
      sandboxBlueprintRegistry,
      new ReadOnlyRepositoryContextResolver(store, projectKnowledge),
    );
    defaultRepositoryBindings = new RepositoryBindingService(
      store,
      cloudProjects,
      defaultAgentSessions,
    );
    defaultDeepWikiGenerations = new DeepWikiGenerationService(
      store,
      providers,
      projectKnowledge,
    );
  }
  const agentSessions = options.agentSessions ?? defaultAgentSessions;
  const repositoryBindings = options.repositoryBindings ?? defaultRepositoryBindings;
  const projectAgentSettings = options.projectAgentSettings ?? defaultProjectAgentSettings;
  const mcpCatalog = options.mcpCatalog ?? defaultMcpCatalog;
  const sandboxBlueprints = options.sandboxBlueprints ?? (cloudProjects
    ? { list: () => sandboxBlueprintRegistry.summaries() }
    : undefined);
  const deepWikiGenerations = options.deepWikiGenerations ?? defaultDeepWikiGenerations;

  if (options.cloud) {
    app.addHook("preHandler", async (request) => {
      const pathname = request.url.split("?", 1)[0] ?? request.url;
      const projectMatch = /^\/api\/projects\/([0-9a-f-]{36})(?:\/|$)/iu.exec(pathname);
      if (projectMatch?.[1]) {
        await service.assertCloudProjectAccess(projectMatch[1]);
        return;
      }
      const runMatch = /^\/api\/runs\/([0-9a-f-]{36})(?:\/|$)/iu.exec(pathname);
      if (runMatch?.[1]) {
        await service.assertCloudRunAccess(runMatch[1]);
        return;
      }
      const artifactMatch = /^\/api\/artifacts\/([0-9a-f-]{36})(?:\/|$)/iu.exec(pathname);
      if (artifactMatch?.[1]) {
        await service.assertCloudArtifactAccess(artifactMatch[1]);
        return;
      }
      const executionMatch = /^\/api\/executions\/([0-9a-f-]{36})(?:\/|$)/iu.exec(pathname);
      if (executionMatch?.[1]) {
        await service.assertCloudExecutionAccess(executionMatch[1]);
        return;
      }
      const askThreadMatch = /^\/api\/ask-threads\/([0-9a-f-]{36})(?:\/|$)/iu.exec(pathname);
      if (askThreadMatch?.[1]) {
        await service.assertCloudAskThreadAccess(askThreadMatch[1]);
      }
    });
  }

  app.setErrorHandler((error, _request, reply) => {
    if ((error as { code?: string }).code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return reply.status(413).send({
        error: { code: "REQUEST_BODY_TOO_LARGE", message: "请求体超过允许大小" }
      });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: "请求参数无效", details: error.flatten() }
      });
    }
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send(presentAppError(error));
    }
    app.log.error(error);
    return reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: "服务器内部错误" } });
  });

  app.get("/api/health", async () => ({
    status: "ok",
    authentication: { required: Boolean(accessToken) },
    runner: {
      mode: runner.mode(),
    },
    phaseExecutions: service.phaseExecutionCapacity(),
  }));
  app.get("/api/auth/check", async () => ({ authenticated: true }));
  app.get("/api/work-item-adapters", async () => ({
    adapters: workItemAdapters.summaries(),
  }));
  if (options.cloud) {
    app.post("/api/operator/workspaces/prune", async (request) => ({
      result: await service.pruneCloudWorkspaces(
        pruneWorkspacesSchema.parse(request.body ?? {}),
      ),
    }));
  }
  app.post("/api/work-items/resolve", async (request, reply) => {
    const controller = new AbortController();
    const abortDisconnectedRequest = () => {
      if (!controller.signal.aborted && !reply.raw.writableEnded) {
        controller.abort(new Error("Work Item request disconnected"));
      }
    };
    request.raw.once("aborted", abortDisconnectedRequest);
    reply.raw.once("close", abortDisconnectedRequest);
    try {
      const workItem = await workItemAdapters.resolve(
        resolveWorkItemSchema.parse(request.body),
        controller.signal,
      );
      return { workItem };
    } finally {
      request.raw.off("aborted", abortDisconnectedRequest);
      reply.raw.off("close", abortDisconnectedRequest);
    }
  });
  app.get("/api/ask/providers", async () => ({ providers: ask.listProviders() }));
  app.post("/api/ask/providers/:providerId/check", async (request) => {
    const { providerId } = askProviderParamsSchema.parse(request.params);
    z.object({}).strict().parse(request.body ?? {});
    return { check: await ask.checkProvider(providerId, request.signal) };
  });
  app.get("/api/ask/provider-configurations", async () => {
    const configurations = requireChatFirstPort(
      providerConfigurations,
      "Provider 配置服务",
    ).list();
    return parsePublicPortResult(
      z.object({ providers: z.array(askProviderConfigurationSchema).length(4) }).strict(),
      { providers: configurations },
    );
  });
  app.put("/api/ask/provider-configurations/:providerId", async (request) => {
    const { providerId } = askProviderParamsSchema.parse(request.params);
    const provider = await requireChatFirstPort(
      providerConfigurations,
      "Provider 配置服务",
    ).update(providerId, updateAskProviderConfigurationSchema.parse(request.body));
    return parsePublicPortResult(
      z.object({ provider: askProviderConfigurationSchema }).strict(),
      { provider },
    );
  });
  app.post("/api/ask/provider-configurations/:providerId/check", async (request) => {
    const { providerId } = askProviderParamsSchema.parse(request.params);
    const check = await requireChatFirstPort(
      providerConfigurations,
      "Provider 配置服务",
    ).check(
      providerId,
      checkAskProviderConfigurationSchema.parse(request.body),
      request.signal,
    );
    return parsePublicPortResult(
      z.object({ check: askProviderConfigurationCheckSchema }).strict(),
      { check },
    );
  });
  app.patch("/api/ask/provider-configurations/:providerId/enabled", async (request) => {
    const { providerId } = askProviderParamsSchema.parse(request.params);
    const provider = await requireChatFirstPort(
      providerConfigurations,
      "Provider 配置服务",
    ).setEnabled(providerId, setAskProviderEnabledSchema.parse(request.body));
    return parsePublicPortResult(
      z.object({ provider: askProviderConfigurationSchema }).strict(),
      { provider },
    );
  });
  // Desktop authorization belongs to the legacy-local operator surface. A
  // Cloud deployment must not advertise a host/Desktop integration globally.
  if (!options.cloud) {
    app.get("/api/integrations/figma", async () => figmaIntegration.status());
  }

  app.get("/api/repository-credentials", async (request) => {
    const { host } = repositoryCredentialQuerySchema.parse(request.query);
    return { credentials: service.listRepositoryCredentials(host) };
  });

  app.post("/api/repository-bindings", async (request, reply) => {
    const input = bindRemoteRepositorySchema.parse(request.body);
    const result = await requireChatFirstPort(
      repositoryBindings,
      "远端仓库绑定服务",
    ).bind(input, request.signal);
    return reply.status(201).send(
      parsePublicPortResult(repositoryBindingResponseSchema, result),
    );
  });

  app.get("/api/agent-sessions", async (request) => {
    const { projectId } = agentSessionListQuerySchema.parse(request.query ?? {});
    const sessions = await requireChatFirstPort(
      agentSessions,
      "Agent Session 服务",
    ).list(projectId);
    return parsePublicPortResult(
      z.object({ sessions: z.array(agentSessionSchema) }).strict(),
      { sessions },
    );
  });

  app.post("/api/agent-sessions", async (request, reply) => {
    const input = createAgentSessionSchema.parse(request.body ?? {});
    const session = await requireChatFirstPort(
      agentSessions,
      "Agent Session 服务",
    ).create(input);
    return reply.status(201).send(
      parsePublicPortResult(
        z.object({ session: agentSessionSchema }).strict(),
        { session },
      ),
    );
  });

  app.get("/api/agent-sessions/:id", async (request) => {
    const { id } = agentSessionParamsSchema.parse(request.params);
    emptyQuerySchema.parse(request.query ?? {});
    const detail = await requireChatFirstPort(
      agentSessions,
      "Agent Session 服务",
    ).get(id);
    return parsePublicPortResult(agentSessionDetailSchema, detail);
  });

  app.post("/api/agent-sessions/:id/messages", async (request, reply) => {
    const { id } = agentSessionParamsSchema.parse(request.params);
    const input = sendAgentMessageSchema.parse(request.body);
    const detail = await requireChatFirstPort(
      agentSessions,
      "Agent Session 服务",
    ).sendMessage(id, input, request.signal);
    return reply.status(202).send(
      parsePublicPortResult(agentSessionDetailSchema, detail),
    );
  });

  app.get("/api/sandbox-blueprints", async (request) => {
    emptyQuerySchema.parse(request.query ?? {});
    const blueprints = await requireChatFirstPort(
      sandboxBlueprints,
      "Sandbox Blueprint 目录",
    ).list();
    return parsePublicPortResult(
      z.object({ blueprints: z.array(sandboxBlueprintSummarySchema) }).strict(),
      { blueprints },
    );
  });

  app.get("/api/mcp/installations", async (request) => {
    emptyQuerySchema.parse(request.query ?? {});
    const installations = await requireChatFirstPort(
      mcpCatalog,
      "MCP 目录",
    ).list();
    return parsePublicPortResult(
      z.object({ installations: z.array(mcpInstallationSummarySchema) }).strict(),
      { installations },
    );
  });

  app.get("/api/projects/:id/agent-settings", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    emptyQuerySchema.parse(request.query ?? {});
    const settings = await requireChatFirstPort(
      projectAgentSettings,
      "Project Agent Settings 服务",
    ).get(id);
    return parsePublicPortResult(
      z.object({ settings: projectAgentSettingsSchema }).strict(),
      { settings },
    );
  });

  app.patch("/api/projects/:id/agent-settings", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const input = updateProjectAgentSettingsSchema.parse(request.body);
    const settings = await requireChatFirstPort(
      projectAgentSettings,
      "Project Agent Settings 服务",
    ).update(id, input);
    return parsePublicPortResult(
      z.object({ settings: projectAgentSettingsSchema }).strict(),
      { settings },
    );
  });

  app.patch("/api/projects/:id/mcp-activations/:serverId", async (request) => {
    const { id, serverId } = mcpActivationParamsSchema.parse(request.params);
    const { enabled } = mcpActivationBodySchema.parse(request.body);
    const activation = await requireChatFirstPort(
      mcpCatalog,
      "MCP 目录",
    ).activate(id, serverId, enabled);
    return parsePublicPortResult(
      z.object({ activation: mcpActivationSchema }).strict(),
      { activation },
    );
  });

  app.get("/api/projects/:id/deepwiki/generations/latest", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    emptyQuerySchema.parse(request.query ?? {});
    const generation = await requireChatFirstPort(
      deepWikiGenerations,
      "DeepWiki 生成服务",
    ).getLatest(id);
    return parsePublicPortResult(
      z.object({ generation: deepWikiGenerationSchema.nullable() }).strict(),
      { generation },
    );
  });

  app.post("/api/projects/:id/deepwiki/generations", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const input = generateDeepWikiSchema.parse(request.body);
    const generation = await requireChatFirstPort(
      deepWikiGenerations,
      "DeepWiki 生成服务",
    ).generate(id, input, request.signal);
    return reply.status(202).send(
      parsePublicPortResult(
        z.object({ generation: deepWikiGenerationSchema }).strict(),
        { generation },
      ),
    );
  });

  app.get("/api/projects", async () => ({ projects: await service.listProjects() }));
  app.post("/api/projects", async (request, reply) => {
    const controller = new AbortController();
    const abortDisconnectedRequest = () => {
      if (!controller.signal.aborted && !reply.raw.writableEnded) {
        controller.abort(new Error("project creation request disconnected"));
      }
    };
    request.raw.once("aborted", abortDisconnectedRequest);
    reply.raw.once("close", abortDisconnectedRequest);
    try {
      const result = await service.createProject(
        options.cloud
          ? remoteGitCreateProjectSchema.parse(request.body)
          : createProjectSchema.parse(request.body),
        controller.signal,
      );
      return reply.status(201).send(result);
    } finally {
      request.raw.off("aborted", abortDisconnectedRequest);
      reply.raw.off("close", abortDisconnectedRequest);
    }
  });
  app.get("/api/projects/:id", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return service.getProject(id);
  });
  app.post("/api/projects/:id/repository/sync", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const { expectedRevision } = repositorySyncSchema.parse(request.body ?? {});
    const controller = new AbortController();
    const abortDisconnectedRequest = () => {
      if (!controller.signal.aborted && !reply.raw.writableEnded) {
        controller.abort(new Error("repository sync request disconnected"));
      }
    };
    request.raw.once("aborted", abortDisconnectedRequest);
    reply.raw.once("close", abortDisconnectedRequest);
    try {
      const project = await service.syncProjectRepository(
        id,
        expectedRevision,
        controller.signal,
      );
      return reply.status(202).send({ project });
    } finally {
      request.raw.off("aborted", abortDisconnectedRequest);
      reply.raw.off("close", abortDisconnectedRequest);
    }
  });
  app.get("/api/projects/:id/knowledge", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return { knowledge: await service.getProjectKnowledge(id) };
  });
  app.post("/api/projects/:id/ask", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const controller = new AbortController();
    const abortDisconnectedRequest = () => {
      if (!controller.signal.aborted && !reply.raw.writableEnded) {
        controller.abort(new Error("Ask request disconnected"));
      }
    };
    request.raw.once("aborted", abortDisconnectedRequest);
    reply.raw.once("close", abortDisconnectedRequest);
    try {
      const answer = await ask.answer(
        id,
        askProjectSchema.parse(request.body),
        controller.signal,
      );
      return { answer };
    } finally {
      request.raw.off("aborted", abortDisconnectedRequest);
      reply.raw.off("close", abortDisconnectedRequest);
    }
  });
  app.get("/api/projects/:id/ask-threads", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return { threads: await askThreads.list(id) };
  });
  app.post("/api/projects/:id/ask-threads", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const controller = new AbortController();
    const abortDisconnectedRequest = () => {
      if (!controller.signal.aborted && !reply.raw.writableEnded) {
        controller.abort(new Error("Ask Thread creation request disconnected"));
      }
    };
    request.raw.once("aborted", abortDisconnectedRequest);
    reply.raw.once("close", abortDisconnectedRequest);
    try {
      const thread = await askThreads.create(
        id,
        createAskThreadSchema.parse(request.body ?? {}),
        controller.signal,
      );
      return reply.status(201).send({ thread });
    } finally {
      request.raw.off("aborted", abortDisconnectedRequest);
      reply.raw.off("close", abortDisconnectedRequest);
    }
  });
  app.get("/api/ask-threads/:id", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return { thread: await askThreads.get(id) };
  });
  app.post("/api/ask-threads/:id/messages", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const controller = new AbortController();
    const abortDisconnectedRequest = () => {
      if (!controller.signal.aborted && !reply.raw.writableEnded) {
        controller.abort(new Error("Ask Thread message request disconnected"));
      }
    };
    request.raw.once("aborted", abortDisconnectedRequest);
    reply.raw.once("close", abortDisconnectedRequest);
    try {
      const thread = await askThreads.send(
        id,
        sendAskThreadMessageSchema.parse(request.body),
        controller.signal,
      );
      return { thread };
    } finally {
      request.raw.off("aborted", abortDisconnectedRequest);
      reply.raw.off("close", abortDisconnectedRequest);
    }
  });
  app.get("/api/projects/:id/e2e-workspace", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return { workspace: await service.getE2eWorkspace(id) };
  });
  app.put("/api/projects/:id/e2e-workspace", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const workspace = await service.configureE2eWorkspace(
      id,
      configureE2eWorkspaceSchema.parse(request.body),
    );
    return { workspace };
  });
  app.post("/api/projects/:id/e2e-workspace/prepare", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    z.object({}).strict().parse(request.body ?? {});
    return service.prepareE2eWorkspace(id);
  });

  app.get("/api/projects/:id/runs", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return { runs: await service.listRuns(id) };
  });
  app.post("/api/projects/:id/runs", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const run = await service.createRun(id, createRunSchema.parse(request.body));
    return reply.status(201).send({ run });
  });

  app.get("/api/runs/:id", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return service.getRun(id);
  });
  app.get("/api/runs/:id/changeset", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const { patch: _internalPatch, ...changeset } = await service.generateRunChangeset(id);
    return { changeset };
  });
  app.get("/api/runs/:id/changeset/patch", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const changeset = await service.generateRunChangeset(id);
    if (!changeset.dirty) return reply.status(204).send();
    if (!changeset.downloadAvailable || changeset.patch.length === 0) {
      throw new AppError(
        "本次 Patch 超过下载上限；请缩小 Run 范围后重试",
        422,
        "CHANGESET_DOWNLOAD_UNAVAILABLE",
      );
    }
    return reply
      .header("Content-Type", "text/x-diff; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="ai-sdlc-${id}.patch"`)
      .header("ETag", `"sha256-${changeset.patchSha256}"`)
      .header("Cache-Control", "private, no-store")
      .send(changeset.patch);
  });
  app.get("/api/runs/:id/verification/e2e-flow", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return { flow: await service.getVerificationE2eFlow(id) };
  });
  app.post("/api/runs/:id/verification/e2e-flow", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const input = verificationE2eFlowActionSchema.parse(request.body ?? {});
    if (input.action === "preflight") {
      return { flow: await service.preflightVerificationE2e(id) };
    }
    const execution = await service.executeVerificationE2e(id, input);
    return reply.status(202).send({ execution });
  });
  app.post("/api/runs/:id/verification/e2e-flow/author", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const execution = await service.authorVerificationE2e(
      id,
      authorVerificationE2eSchema.parse(request.body ?? {}),
    );
    return reply.status(202).send({ execution });
  });
  app.post("/api/runs/:id/verification/e2e-flow/script-review", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return {
      flow: await service.reviewVerificationE2eScripts(
        id,
        reviewVerificationE2eScriptsSchema.parse(request.body ?? {}),
      ),
    };
  });
  app.get("/api/runs/:id/human-decisions", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return service.getHumanDecisions(id);
  });
  app.get("/api/runs/:id/integrations/figma", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const { force } = figmaIntegrationQuerySchema.parse(request.query);
    return service.getFigmaIntegration(id, { force: force === "true" });
  });
  app.get("/api/runs/:id/integrations/figma/plans", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const { force } = figmaIntegrationQuerySchema.parse(request.query);
    return service.getFigmaPlans(id, { force: force === "true" });
  });
  app.get("/api/runs/:id/codex/capabilities", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return service.getCodexCapabilities(id);
  });
  app.get("/api/runs/:id/tickets", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return { tickets: await service.listTickets(id) };
  });
  app.get("/api/runs/:id/tickets/:ticketId", async (request) => {
    const { id, ticketId } = ticketParamsSchema.parse(request.params);
    return { ticket: await service.getTicket(id, ticketId) };
  });
  app.patch("/api/runs/:id/tickets/:ticketId/status", async (request) => {
    const { id, ticketId } = ticketParamsSchema.parse(request.params);
    const { status } = updateTicketStatusSchema.parse(request.body);
    return { ticket: await service.updateTicketStatus(id, ticketId, status) };
  });
  app.post("/api/runs/:id/phases/:phaseId/execute", async (request, reply) => {
    const { id, phaseId } = phaseParamsSchema.parse(request.params);
    const execution = await service.executePhase(id, phaseId, executePhaseSchema.parse(request.body ?? {}));
    return reply.status(202).send({ execution });
  });
  app.post("/api/runs/:id/phases/architecture/impact", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const input = assessArchitectureDispositionSchema.parse(request.body ?? {});
    return input.mode === "skip"
      ? service.waiveArchitecture(id, input)
      : service.assessArchitectureImpact(id, input);
  });
  app.post("/api/runs/:id/phases/discovery/impact", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return service.assessProductImpact(
      id,
      assessProductImpactSchema.parse(request.body ?? {}),
    );
  });
  app.post("/api/runs/:id/phases/design/impact", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return service.assessDesignImpact(
      id,
      assessDesignImpactSchema.parse(request.body ?? {}),
    );
  });
  app.post("/api/runs/:id/phases/:phaseId/review", async (request) => {
    const { id, phaseId } = phaseParamsSchema.parse(request.params);
    return service.reviewPhase(id, phaseId, reviewPhaseSchema.parse(request.body));
  });
  app.post("/api/runs/:id/phases/:phaseId/human-decisions", async (request) => {
    const { id, phaseId } = humanDecisionParamsSchema.parse(request.params);
    return service.captureHumanDecisions(
      id,
      phaseId,
      captureHumanDecisionsSchema.parse(request.body),
    );
  });

  app.get("/api/artifacts/:id", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return { artifact: await service.getArtifact(id) };
  });
  app.post("/api/artifacts/:id/revisions", { bodyLimit: artifactRevisionBodyLimit }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const artifact = await service.createArtifactRevision(
      id,
      createArtifactRevisionSchema.parse(request.body),
    );
    return reply.status(201).send({ artifact });
  });
  app.get("/api/executions/:id/events", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return { events: await service.getExecutionEvents(id) };
  });

  app.addHook("onClose", async () => {
    await service.waitForIdle();
  });
  if (options.cloud && options.recoverChatAgentRuntimeOnStart) {
    await store.recoverChatAgentRuntimeAfterRestart();
  }
  await cloudProjects?.resumeInterruptedOperations();
  return app;
}

function defaultRepositoryRoot(): string {
  return fileURLToPath(new URL("../../../../", import.meta.url));
}
