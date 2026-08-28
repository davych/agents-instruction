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

/**
 * Explicit review-comment prefix that routes a Tester-discovered reusable E2E
 * gap back to a later Software Engineer execution as read-only feedback.
 */
export const TESTER_E2E_CRYSTALLIZATION_REVIEW_PREFIX = "E2E crystallization request:";

export const ticketStatusSchema = z.enum(["backlog", "todo", "in_progress", "done"]);
export type TicketStatus = z.infer<typeof ticketStatusSchema>;

export const updateTicketStatusSchema = z.object({
  status: ticketStatusSchema
});
export type UpdateTicketStatusInput = z.infer<typeof updateTicketStatusSchema>;

export const agentClientSchema = z.enum(["codex", "claude", "copilot"]);
export type AgentClient = z.infer<typeof agentClientSchema>;

const projectNameSchema = z.string().trim().min(1).max(160)
  .regex(/^[^\r\n]+$/u, "项目名称不能换行");
const projectSummarySchema = z.string().trim().max(2_000)
  .default("由 AI SDLC 平台管理的项目");

export const gitRevisionSchema = z.string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u, "Git revision 必须是完整的 SHA-1 或 SHA-256 object id");
export type GitRevision = z.infer<typeof gitRevisionSchema>;

export const repositoryRefSchema = z.string()
  .trim()
  .min(1)
  .max(255)
  .superRefine((value, context) => {
    const invalid = value !== "HEAD" && (
      /^[.-]/u.test(value)
      || value.endsWith("/")
      || value.endsWith(".")
      || value.includes("..")
      || value.includes("@{")
      || value === "@"
      || value.includes("//")
      || /[\u0000-\u0020\u007f~^:?*\\\[]/u.test(value)
      || value.split("/").some((component) => (
        component === ""
        || component.startsWith(".")
        || component.endsWith(".")
        || component.endsWith(".lock")
      ))
    );
    if (invalid) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Git ref 格式不安全",
      });
    }
  });
export type RepositoryRef = z.infer<typeof repositoryRefSchema>;

export const repositoryUrlSchema = z.string()
  .trim()
  .min(1)
  .max(2_048)
  .superRefine((value, context) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "仓库地址不是有效 URL" });
      return;
    }
    if (parsed.protocol !== "https:") {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "仓库地址只允许 HTTPS" });
    }
    if (parsed.username || parsed.password) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "仓库地址不能包含用户名或凭据" });
    }
    if (parsed.search || parsed.hash) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "仓库地址不能包含 query 或 fragment" });
    }
    if (!parsed.hostname || /[\u0000-\u001f\u007f]/u.test(value)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "仓库地址 host 无效" });
    }
  });
export type RepositoryUrl = z.infer<typeof repositoryUrlSchema>;

export const credentialProfileIdSchema = z.string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u, "Credential Profile ID 格式无效");
export type CredentialProfileId = z.infer<typeof credentialProfileIdSchema>;

export const legacyCreateProjectSchema = z.object({
  sourceKind: z.literal("legacy-local").optional(),
  name: projectNameSchema,
  summary: projectSummarySchema,
  rootPath: z.string().trim().min(1),
  initialize: z.boolean().default(false),
  agentClient: agentClientSchema.default("codex")
}).strict();
export type LegacyCreateProjectInput = z.infer<typeof legacyCreateProjectSchema>;

export const remoteGitCreateProjectSchema = z.object({
  sourceKind: z.literal("remote-git"),
  name: projectNameSchema,
  summary: projectSummarySchema,
  repositoryUrl: repositoryUrlSchema,
  requestedRef: repositoryRefSchema.default("HEAD"),
  credentialProfileId: credentialProfileIdSchema.nullable().default(null),
}).strict();
export type RemoteGitCreateProjectInput = z.infer<typeof remoteGitCreateProjectSchema>;

/**
 * Chat-first repository binding deliberately omits project name, summary and
 * every runtime detail. The service derives identity from the validated URL
 * and resolves credentials through a server-owned profile.
 */
export const bindRemoteRepositorySchema = z.object({
  repositoryUrl: repositoryUrlSchema,
  requestedRef: repositoryRefSchema.default("HEAD"),
  credentialProfileId: credentialProfileIdSchema.nullable().default(null),
}).strict();
export type BindRemoteRepositoryInput = z.infer<typeof bindRemoteRepositorySchema>;

export const createProjectSchema = z.union([
  remoteGitCreateProjectSchema,
  legacyCreateProjectSchema,
]);
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const workTypeSchema = z.enum(["feature", "change", "bug", "technical"]);
export type WorkType = z.infer<typeof workTypeSchema>;

export const workItemAdapterIdSchema = z.string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u, "Work Item Adapter ID 格式无效");
export type WorkItemAdapterId = z.infer<typeof workItemAdapterIdSchema>;

export const workItemReferenceSchema = z.string()
  .trim()
  .min(1)
  .max(500)
  .regex(/^[^\u0000-\u001f\u007f]+$/u, "Work Item reference 不能包含控制字符");
export type WorkItemReference = z.infer<typeof workItemReferenceSchema>;

const workItemUrlSchema = z.string().trim().url().max(2_048).refine((value) => {
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol)
      && parsed.username === ""
      && parsed.password === "";
  } catch {
    return false;
  }
}, "Work Item URL 必须是无内嵌凭据的 HTTP(S) URL");

export const workItemAdapterSummarySchema = z.object({
  id: workItemAdapterIdSchema,
  label: z.string().trim().min(1).max(120)
    .regex(/^[^\u0000-\u001f\u007f]+$/u),
  kind: z.literal("mcp-stdio"),
  configured: z.boolean(),
  message: z.string().trim().min(1).max(500)
    .regex(/^[^\u0000]*$/u)
    .nullable(),
}).strict();
export type WorkItemAdapterSummaryDto = z.infer<typeof workItemAdapterSummarySchema>;

export const resolveWorkItemSchema = z.object({
  adapterId: workItemAdapterIdSchema,
  reference: workItemReferenceSchema,
}).strict();
export type ResolveWorkItemInput = z.infer<typeof resolveWorkItemSchema>;

export const workItemProvenanceSchema = z.object({
  kind: z.literal("mcp"),
  adapterId: workItemAdapterIdSchema,
  adapterLabel: z.string().trim().min(1).max(120)
    .regex(/^[^\u0000-\u001f\u007f]+$/u),
  reference: workItemReferenceSchema,
  externalId: z.string().trim().min(1).max(500)
    .regex(/^[^\u0000-\u001f\u007f]+$/u),
  url: workItemUrlSchema.nullable(),
  fetchedAt: z.string().datetime(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export type WorkItemProvenance = z.infer<typeof workItemProvenanceSchema>;

const workItemDraftListItemSchema = z.string()
  .trim()
  .min(1)
  .max(2_000)
  .regex(/^[^\u0000]*$/u);

export const workItemDraftSchema = z.object({
  source: workItemProvenanceSchema,
  title: z.string().trim().min(1).max(200)
    .regex(/^[^\u0000-\u001f\u007f]+$/u),
  description: z.string().trim().max(10_000)
    .regex(/^[^\u0000]*$/u),
  suggestedWorkType: workTypeSchema,
  acceptanceCriteria: z.array(workItemDraftListItemSchema).max(100)
    .refine((items) => new Set(items).size === items.length, "acceptanceCriteria 不能重复"),
  labels: z.array(z.string().trim().min(1).max(200)
    .regex(/^[^\u0000-\u001f\u007f]+$/u)).max(100)
    .refine((items) => new Set(items).size === items.length, "labels 不能重复"),
}).strict();
export type WorkItemDraftDto = z.infer<typeof workItemDraftSchema>;

export const askProviderIdSchema = z.enum([
  "openai",
  "lmstudio",
  "ollama",
  "custom",
]);
export type AskProviderId = z.infer<typeof askProviderIdSchema>;

export const askProviderProtocolSchema = z.enum([
  "openai-responses",
  "openai-chat",
  "ollama-chat",
]);
export type AskProviderProtocol = z.infer<typeof askProviderProtocolSchema>;

export const safeRepositoryRelativePathSchema = z.string()
  .trim()
  .min(1)
  .max(4_096)
  .regex(/^[^\u0000-\u001f\u007f\\]+$/u)
  .refine(
    (sourcePath) => !sourcePath.startsWith("/")
      && !/^[A-Za-z]:/u.test(sourcePath)
      && sourcePath.split("/").every(
        (component) => component !== "" && component !== "." && component !== "..",
      ),
    "路径必须是安全的仓库相对路径",
  );

export const repoAliasSchema = z.string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u, "Repo alias 只能使用小写字母、数字和单个连字符");
export type RepoAlias = z.infer<typeof repoAliasSchema>;

export const sandboxBlueprintIdSchema = z.string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u, "Sandbox Blueprint ID 格式无效");
export type SandboxBlueprintId = z.infer<typeof sandboxBlueprintIdSchema>;

export const sandboxBlueprintVersionSchema = z.string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:+-]*$/u, "Sandbox Blueprint version 格式无效");
export type SandboxBlueprintVersion = z.infer<typeof sandboxBlueprintVersionSchema>;

export const mcpServerIdSchema = z.string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u, "MCP Server ID 格式无效");
export type McpServerId = z.infer<typeof mcpServerIdSchema>;

export const agentProviderCapabilitiesSchema = z.object({
  chat: z.boolean(),
  deepWiki: z.boolean(),
  toolCalling: z.boolean(),
}).strict().superRefine((capabilities, context) => {
  if (capabilities.toolCalling && !capabilities.chat) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["toolCalling"],
      message: "支持工具调用的 Provider 必须同时支持对话",
    });
  }
});
export type AgentProviderCapabilitiesDto = z.infer<typeof agentProviderCapabilitiesSchema>;

export const sandboxBlueprintSummarySchema = z.object({
  id: sandboxBlueprintIdSchema,
  label: z.string().trim().min(1).max(120)
    .regex(/^[^\u0000-\u001f\u007f]+$/u),
  version: sandboxBlueprintVersionSchema,
  description: z.string().trim().min(1).max(1_000)
    .regex(/^[^\u0000]*$/u),
  capabilities: z.object({
    persistentWorkspace: z.boolean(),
    testExecution: z.boolean(),
    servicePorts: z.boolean(),
    restrictedNetwork: z.boolean(),
  }).strict(),
  configured: z.boolean(),
  installHint: z.string().trim().min(1).max(500)
    .regex(/^[^\u0000]*$/u)
    .nullable(),
}).strict();
export type SandboxBlueprintSummaryDto = z.infer<typeof sandboxBlueprintSummarySchema>;

export const mcpToolPermissionClassSchema = z.enum([
  "read",
  "sandbox_write",
  "external_write",
  "destructive",
  "release",
]);
export type McpToolPermissionClass = z.infer<typeof mcpToolPermissionClassSchema>;

export const mcpInstallationSummarySchema = z.object({
  id: mcpServerIdSchema,
  label: z.string().trim().min(1).max(120)
    .regex(/^[^\u0000-\u001f\u007f]+$/u),
  description: z.string().trim().min(1).max(1_000)
    .regex(/^[^\u0000]*$/u),
  kind: z.enum(["mcp-stdio", "mcp-http"]),
  installed: z.boolean(),
  authorization: z.enum(["ready", "missing", "not-required"]),
  permissionClasses: z.array(mcpToolPermissionClassSchema).max(5)
    .refine((items) => new Set(items).size === items.length, "MCP permissionClasses 不能重复"),
  installHint: z.string().trim().min(1).max(500)
    .regex(/^[^\u0000]*$/u)
    .nullable(),
}).strict();
export type McpInstallationSummaryDto = z.infer<typeof mcpInstallationSummarySchema>;

export const mcpActivationSchema = z.object({
  projectId: z.string().uuid(),
  mcpServerId: mcpServerIdSchema,
  enabled: z.boolean(),
  permissionClasses: z.array(mcpToolPermissionClassSchema).max(5)
    .refine((items) => new Set(items).size === items.length, "MCP permissionClasses 不能重复"),
  updatedAt: z.string().datetime(),
}).strict();
export type McpActivationDto = z.infer<typeof mcpActivationSchema>;

export const projectAgentSettingsSchema = z.object({
  projectId: z.string().uuid(),
  repoAlias: repoAliasSchema,
  defaultProviderId: askProviderIdSchema,
  sandboxBlueprintId: sandboxBlueprintIdSchema,
  sandboxBlueprintVersion: sandboxBlueprintVersionSchema,
  enabledMcpServerIds: z.array(mcpServerIdSchema).max(64)
    .refine((items) => new Set(items).size === items.length, "enabledMcpServerIds 不能重复"),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
export type ProjectAgentSettingsDto = z.infer<typeof projectAgentSettingsSchema>;

export const updateProjectAgentSettingsSchema = z.object({
  expectedVersion: z.number().int().positive(),
  repoAlias: repoAliasSchema.optional(),
  defaultProviderId: askProviderIdSchema.optional(),
  sandboxBlueprintId: sandboxBlueprintIdSchema.optional(),
  sandboxBlueprintVersion: sandboxBlueprintVersionSchema.optional(),
  enabledMcpServerIds: z.array(mcpServerIdSchema).max(64)
    .refine((items) => new Set(items).size === items.length, "enabledMcpServerIds 不能重复")
    .optional(),
}).strict().refine(
  (input) => Object.keys(input).some((key) => key !== "expectedVersion"),
  { message: "至少修改一项 Project Agent Setting" },
);
export type UpdateProjectAgentSettingsInput = z.infer<typeof updateProjectAgentSettingsSchema>;

export const createAgentSessionSchema = z.object({
  title: z.string().trim().min(1).max(200)
    .regex(/^[^\u0000-\u001f\u007f]+$/u)
    .optional(),
  providerId: askProviderIdSchema.optional(),
  primaryProjectId: z.string().uuid().optional(),
}).strict();
export type CreateAgentSessionInput = z.infer<typeof createAgentSessionSchema>;

export const agentSessionStatusSchema = z.enum(["active", "archived"]);
export type AgentSessionStatus = z.infer<typeof agentSessionStatusSchema>;

export const agentTurnStateSchema = z.enum([
  "idle",
  "running",
  "waiting_human",
  "interrupted",
]);
export type AgentTurnState = z.infer<typeof agentTurnStateSchema>;

export const agentSessionRepositorySchema = z.object({
  sessionId: z.string().uuid(),
  projectId: z.string().uuid(),
  repoAlias: repoAliasSchema,
  accessMode: z.enum(["write", "read"]),
  sourceRevision: gitRevisionSchema,
  createdAt: z.string().datetime(),
}).strict();
export type AgentSessionRepositoryDto = z.infer<typeof agentSessionRepositorySchema>;

export const agentSandboxStateSchema = z.enum([
  "starting",
  "ready",
  "busy",
  "stopped",
  "failed",
]);
export type AgentSandboxState = z.infer<typeof agentSandboxStateSchema>;

export const agentSandboxSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  projectId: z.string().uuid(),
  sourceRevision: gitRevisionSchema,
  blueprintId: sandboxBlueprintIdSchema,
  blueprintVersion: sandboxBlueprintVersionSchema,
  state: agentSandboxStateSchema,
  expiresAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
export type AgentSandboxDto = z.infer<typeof agentSandboxSchema>;

export const agentSessionSchema = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(200)
    .regex(/^[^\u0000-\u001f\u007f]+$/u),
  status: agentSessionStatusSchema,
  turnState: agentTurnStateSchema,
  currentProviderId: askProviderIdSchema,
  lastMessageSequence: z.number().int().nonnegative(),
  lastEventSequence: z.number().int().nonnegative(),
  repositories: z.array(agentSessionRepositorySchema).max(16),
  sandbox: agentSandboxSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict().superRefine((session, context) => {
  if (session.repositories.filter(({ accessMode }) => accessMode === "write").length > 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["repositories"],
      message: "一个 Agent Session 最多只能有一个可写主仓库",
    });
  }
  if (new Set(session.repositories.map(({ projectId }) => projectId)).size !== session.repositories.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["repositories"],
      message: "Agent Session 不能重复绑定同一项目",
    });
  }
  if (new Set(session.repositories.map(({ repoAlias }) => repoAlias)).size !== session.repositories.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["repositories"],
      message: "Agent Session 的 Repo alias 不能重复",
    });
  }
});
export type AgentSessionDto = z.infer<typeof agentSessionSchema>;

export const sendAgentMessageSchema = z.object({
  clientMessageId: z.string().uuid(),
  expectedSequence: z.number().int().nonnegative().max(1_000_000_000),
  content: z.string().trim().min(1).max(12_000),
  providerId: askProviderIdSchema.optional(),
}).strict();
export type SendAgentMessageInput = z.infer<typeof sendAgentMessageSchema>;

const agentModelIdSchema = z.string().trim().min(1).max(256)
  .regex(/^[^\u0000-\u001f\u007f]+$/u, "Agent model ID 格式无效");

export const agentMessageSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  sequence: z.number().int().positive(),
  role: z.enum(["user", "assistant"]),
  status: z.enum(["running", "completed", "failed", "cancelled"]),
  content: z.string().trim().min(1).max(20_000),
  providerId: askProviderIdSchema,
  model: agentModelIdSchema.nullable(),
  clientMessageId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict().superRefine((message, context) => {
  if (message.role === "user" && (!message.clientMessageId || message.model !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Agent 用户消息必须包含 clientMessageId 且不能声明实际模型",
    });
  }
  if (message.role === "assistant" && (
    message.clientMessageId !== null
    || message.model === null
    || message.status !== "completed"
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Agent 助手消息必须记录实际模型、完成状态且不能携带 clientMessageId",
    });
  }
});
export type AgentMessageDto = z.infer<typeof agentMessageSchema>;

export const agentEventKindSchema = z.enum([
  "session.created",
  "message.accepted",
  "provider.started",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "sandbox.starting",
  "sandbox.ready",
  "sandbox.failed",
  "sdlc.run-created",
  "sdlc.phase-started",
  "sdlc.phase-completed",
  "human-gate.required",
  "human-gate.resolved",
  "turn.completed",
  "turn.failed",
  "deepwiki.started",
  "deepwiki.completed",
  "deepwiki.failed",
]);
export type AgentEventKind = z.infer<typeof agentEventKindSchema>;

export const agentEventSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  sequence: z.number().int().positive(),
  kind: agentEventKindSchema,
  status: z.enum(["started", "completed", "failed", "waiting"]),
  summary: z.string().trim().min(1).max(2_000)
    .regex(/^[^\u0000]*$/u),
  messageId: z.string().uuid().nullable(),
  toolCallId: z.string().uuid().nullable(),
  projectId: z.string().uuid().nullable(),
  workflowRunId: z.string().uuid().nullable(),
  phaseId: phaseIdSchema.nullable(),
  createdAt: z.string().datetime(),
}).strict();
export type AgentEventDto = z.infer<typeof agentEventSchema>;

export const agentToolCallSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  messageId: z.string().uuid(),
  mcpServerId: mcpServerIdSchema,
  toolName: z.string().trim().min(1).max(200)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u),
  permissionClass: mcpToolPermissionClassSchema,
  approval: z.enum(["not-required", "required", "approved", "denied"]),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  argumentsSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  outputSha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  summary: z.string().trim().min(1).max(2_000)
    .regex(/^[^\u0000]*$/u)
    .nullable(),
  errorMessage: z.string().trim().min(1).max(1_000)
    .regex(/^[^\u0000]*$/u)
    .nullable(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
}).strict().superRefine((toolCall, context) => {
  const externalSideEffect = ["external_write", "destructive", "release"]
    .includes(toolCall.permissionClass);
  if (externalSideEffect && toolCall.approval === "not-required") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["approval"],
      message: "外部写入、破坏性和发布工具必须经过 Human Gate",
    });
  }
  if (
    externalSideEffect
    && ["running", "completed"].includes(toolCall.status)
    && toolCall.approval !== "approved"
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["approval"],
      message: "高风险 Tool Call 未批准前不能运行或完成",
    });
  }
  if (toolCall.status === "completed" && (!toolCall.outputSha256 || !toolCall.finishedAt)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "已完成 Tool Call 必须包含输出哈希和完成时间",
    });
  }
  if (toolCall.status === "failed" && (!toolCall.errorMessage || !toolCall.finishedAt)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "失败 Tool Call 必须包含安全错误和完成时间",
    });
  }
});
export type AgentToolCallDto = z.infer<typeof agentToolCallSchema>;

export const agentHumanGateCategorySchema = z.enum([
  "scope",
  "architecture",
  "security",
  "ddl",
  "secret",
  "destructive",
  "external_write",
  "deployment",
  "release",
]);
export type AgentHumanGateCategory = z.infer<typeof agentHumanGateCategorySchema>;

export const agentHumanGateSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  messageId: z.string().uuid(),
  category: agentHumanGateCategorySchema,
  status: z.enum(["pending", "approved", "rejected", "cancelled"]),
  question: z.string().trim().min(1).max(2_000)
    .regex(/^[^\u0000]*$/u),
  choices: z.array(z.object({
    id: z.string().trim().min(1).max(80)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
    label: z.string().trim().min(1).max(120)
      .regex(/^[^\u0000-\u001f\u007f]+$/u),
    description: z.string().trim().min(1).max(500)
      .regex(/^[^\u0000]*$/u),
    recommended: z.boolean(),
  }).strict()).min(1).max(3)
    .refine((items) => new Set(items.map(({ id }) => id)).size === items.length, "Human Gate choice ID 不能重复")
    .refine((items) => items.filter(({ recommended }) => recommended).length <= 1, "最多一个推荐选项"),
  selectedChoiceId: z.string().trim().min(1).max(80)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)
    .nullable(),
  responseComment: z.string().trim().min(1).max(2_000)
    .regex(/^[^\u0000]*$/u)
    .nullable(),
  createdAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable(),
}).strict().superRefine((gate, context) => {
  if (gate.status === "pending" && (
    gate.selectedChoiceId !== null
    || gate.responseComment !== null
    || gate.resolvedAt !== null
  )) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "待决定 Gate 不能包含决议" });
  }
  if (gate.status !== "pending" && gate.resolvedAt === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "已处理 Gate 必须包含 resolvedAt" });
  }
  if (gate.status === "approved" && gate.selectedChoiceId === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["selectedChoiceId"],
      message: "批准 Human Gate 必须明确选择一个选项",
    });
  }
  if (
    gate.selectedChoiceId
    && !gate.choices.some(({ id }) => id === gate.selectedChoiceId)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["selectedChoiceId"],
      message: "selectedChoiceId 必须来自当前 Gate choices",
    });
  }
});
export type AgentHumanGateDto = z.infer<typeof agentHumanGateSchema>;

export const generateDeepWikiSchema = z.object({
  expectedRevision: gitRevisionSchema,
  providerId: askProviderIdSchema.optional(),
  clientRequestId: z.string().uuid().optional(),
}).strict();
export type GenerateDeepWikiInput = z.infer<typeof generateDeepWikiSchema>;

export const deepWikiCitationSchema = z.object({
  path: safeRepositoryRelativePathSchema,
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  summary: z.string().trim().min(1).max(1_000)
    .regex(/^[^\u0000]*$/u),
}).strict().refine(
  ({ startLine, endLine }) => endLine >= startLine,
  { path: ["endLine"], message: "DeepWiki 引用结束行不能早于起始行" },
);
export type DeepWikiCitationDto = z.infer<typeof deepWikiCitationSchema>;

export const deepWikiPageSchema = z.object({
  slug: z.string().trim().min(1).max(120)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  title: z.string().trim().min(1).max(200)
    .regex(/^[^\u0000-\u001f\u007f]+$/u),
  summary: z.string().trim().min(1).max(2_000)
    .regex(/^[^\u0000]*$/u),
  content: z.string().trim().min(1).max(100_000)
    .regex(/^[^\u0000]*$/u),
  citations: z.array(deepWikiCitationSchema).max(100),
}).strict();
export type DeepWikiPageDto = z.infer<typeof deepWikiPageSchema>;

export const deepWikiGenerationStatusSchema = z.enum([
  "queued",
  "scanning",
  "generating",
  "validating",
  "ready",
  "failed",
  "stale",
]);
export type DeepWikiGenerationStatus = z.infer<typeof deepWikiGenerationStatusSchema>;

export const deepWikiGenerationSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  revision: gitRevisionSchema,
  providerId: askProviderIdSchema,
  model: agentModelIdSchema.nullable(),
  promptVersion: z.string().trim().min(1).max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:+-]*$/u),
  status: deepWikiGenerationStatusSchema,
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  content: z.string().trim().min(1).max(500_000)
    .regex(/^[^\u0000]*$/u)
    .nullable(),
  citations: z.array(deepWikiCitationSchema).max(500),
  usage: z.object({
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
  }).strict(),
  errorMessage: z.string().trim().min(1).max(1_000)
    .regex(/^[^\u0000]*$/u)
    .nullable(),
  generatedAt: z.string().datetime().nullable(),
  staleAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict().superRefine((generation, context) => {
  const published = generation.status === "ready" || generation.status === "stale";
  if (published && (
    generation.model === null
    || generation.content === null
    || generation.generatedAt === null
    || generation.errorMessage !== null
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "已发布 DeepWiki 必须包含模型、清单哈希、页面和生成时间",
    });
  }
  if (generation.status === "stale" && generation.staleAt === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "过期 DeepWiki 必须包含 staleAt" });
  }
  if (generation.status === "ready" && generation.staleAt !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "ready DeepWiki 不能包含 staleAt" });
  }
  if (generation.status === "failed" && (
    generation.errorMessage === null
    || generation.generatedAt === null
  )) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "失败 DeepWiki 必须包含安全错误和结束时间" });
  }
  if (!published && (generation.content !== null || generation.citations.length > 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "未发布 DeepWiki 不能暴露内容或引用" });
  }
});
export type DeepWikiGenerationDto = z.infer<typeof deepWikiGenerationSchema>;

/** Public retrieval revision (for example `git:<sha>:clean`), not a raw Git object id. */
export const askRevisionSchema = z.string().trim().min(1).max(200)
  .regex(/^[^\u0000-\u001f\u007f]+$/u, "Ask revision 格式无效");
export type AskRevision = z.infer<typeof askRevisionSchema>;

export const askHistoryMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(12_000),
}).strict();
export type AskHistoryMessage = z.infer<typeof askHistoryMessageSchema>;

export const askProjectSchema = z.object({
  providerId: askProviderIdSchema,
  question: z.string().trim().min(1).max(8_000),
  history: z.array(askHistoryMessageSchema).max(12).default([]),
  expectedRevision: askRevisionSchema.optional(),
}).strict().superRefine(({ history }, context) => {
  const total = history.reduce((sum, message) => sum + message.content.length, 0);
  if (total > 48_000) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["history"],
      message: "Ask 历史总长度不能超过 48000 字符",
    });
  }
});
export type AskProjectInput = z.infer<typeof askProjectSchema>;

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
 * A fixed, bounded manifest summary for an explicitly mentioned read-only
 * repository. It intentionally contains no Project/workspace identifier, URL,
 * absolute path, file body, or credential-shaped field.
 */
export const readOnlyRepositoryContextSchema = z.object({
  repoAlias: repoAliasSchema,
  sourceRevision: gitRevisionSchema,
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/u),
  summary: z.string().trim().min(1).max(6_000)
    .regex(/^[^\u0000]*$/u, "只读仓库摘要不能包含空字符"),
}).strict();
export type ReadOnlyRepositoryContextDto = z.infer<typeof readOnlyRepositoryContextSchema>;

export const readOnlyRepositoryContextsSchema = z.array(readOnlyRepositoryContextSchema)
  .max(4, "一轮最多引用 4 个只读仓库")
  .refine(
    (contexts) => new Set(contexts.map(({ repoAlias }) => repoAlias)).size === contexts.length,
    "只读仓库 alias 不能重复",
  )
  .refine(
    (contexts) => contexts.reduce((total, { summary }) => total + summary.length, 0) <= 24_000,
    "只读仓库摘要总长度不能超过 24000 字符",
  );

/**
 * The immutable, run-scoped contract for one unit of work. Product/design/
 * architecture roles may be routed around, but this evidence is never skipped.
 */
export const changeContractSchema = z.object({
  workType: workTypeSchema,
  sourceRunIds: sourceRunIdsSchema.optional(),
  workItem: workItemProvenanceSchema.optional(),
  readOnlyRepositories: readOnlyRepositoryContextsSchema.optional(),
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
  baseRevision: gitRevisionSchema.optional(),
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
  baseRevision: gitRevisionSchema.optional(),
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

export const e2ePackageManagerSchema = z.literal("npm");
export type E2ePackageManager = z.infer<typeof e2ePackageManagerSchema>;

export const e2eBrowserSchema = z.enum(["chromium"]);
export type E2eBrowser = z.infer<typeof e2eBrowserSchema>;

const packageScriptNameSchema = z.string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:_-]*$/u, "脚本名只能包含字母、数字、冒号、下划线或连字符");

const loopbackHttpUrlSchema = z.string().trim().url().max(2_048).refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:"
      && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname)
      && parsed.username === ""
      && parsed.password === ""
      && parsed.hash === "";
  } catch {
    return false;
  }
}, "E2E baseUrl 必须是本机 localhost/loopback HTTP 地址");

export const configureE2eWorkspaceSchema = z.object({
  rootPath: z.string().trim().min(1).max(4_096)
    .regex(/^(?:\/|[A-Za-z]:[\\/])/u, "E2E rootPath 必须是绝对路径"),
  initialize: z.boolean().default(false),
  baseUrl: loopbackHttpUrlSchema,
  packageManager: e2ePackageManagerSchema.default("npm"),
  sourceStartScript: packageScriptNameSchema,
  testScript: packageScriptNameSchema.default("test:e2e"),
  browser: e2eBrowserSchema.default("chromium"),
  playwrightVersion: z.string()
    .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u, "Playwright 必须使用精确版本")
    .default("1.62.1"),
}).strict();
export type ConfigureE2eWorkspaceInput = z.infer<typeof configureE2eWorkspaceSchema>;

export const verificationE2eActionSchema = z.enum(["standard", "author_e2e", "run_e2e"]);
export type VerificationE2eAction = z.infer<typeof verificationE2eActionSchema>;

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
  figmaTarget: figmaTargetSchema.optional(),
  verificationAction: verificationE2eActionSchema.optional()
});
export type ExecutePhaseInput = z.infer<typeof executePhaseSchema>;

const e2eExecutionFields = {
  selectedArtifactIds: z.array(z.string().uuid()).min(1).max(100)
    .refine((ids) => new Set(ids).size === ids.length, "selectedArtifactIds 不能重复"),
  model: codexModelSchema.optional(),
  reasoningEffort: codexReasoningEffortSchema.optional(),
};

export const authorVerificationE2eSchema = z.object(e2eExecutionFields).strict();
export type AuthorVerificationE2eInput = z.infer<typeof authorVerificationE2eSchema>;

export const executeVerificationE2eSchema = z.object({
  action: z.literal("execute"),
  ...e2eExecutionFields,
}).strict();

export const preflightVerificationE2eSchema = z.object({
  action: z.literal("preflight"),
}).strict();

export const verificationE2eFlowActionSchema = z.discriminatedUnion("action", [
  preflightVerificationE2eSchema,
  executeVerificationE2eSchema,
]);
export type VerificationE2eFlowActionInput = z.infer<typeof verificationE2eFlowActionSchema>;

export const reviewVerificationE2eScriptsSchema = z.object({
  decision: reviewDecisionSchema,
  expectedPatchHash: z.string().regex(/^[a-f0-9]{64}$/u, "E2E 脚本 manifest hash 无效"),
  comment: z.string().trim().min(1).max(5_000),
}).strict();
export type ReviewVerificationE2eScriptsInput = z.infer<typeof reviewVerificationE2eScriptsSchema>;

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

export const humanDecisionPhaseIdSchema = z.enum(["discovery", "design", "architecture"]);
export type HumanDecisionPhaseId = z.infer<typeof humanDecisionPhaseIdSchema>;

export const captureHumanDecisionsSchema = z.object({
  responses: z.array(z.object({
    id: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
    response: z.string().trim().min(3).max(5_000),
  }).strict()).min(1).max(50)
    .refine((responses) => new Set(responses.map(({ id }) => id)).size === responses.length, "decision ids 不能重复"),
  expectedArtifactIds: z.array(z.string().uuid()).min(1).max(100)
    .refine((ids) => new Set(ids).size === ids.length, "expectedArtifactIds 不能重复"),
}).strict().refine(
  ({ responses }) => responses.reduce(
    (total, { id, response }) => total + id.length + response.length,
    0,
  ) <= 7_000,
  "decision responses 总长度不能超过 7000 字符",
);
export type CaptureHumanDecisionsInput = z.infer<typeof captureHumanDecisionsSchema>;

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
  /** Internal/runtime compatibility discriminator. Public routes use PublicProjectDto. */
  sourceKind?: "legacy-local" | "remote-git";
  repositoryUrl?: string | null;
  repositoryHost?: string | null;
  requestedRef?: string | null;
  currentRevision?: GitRevision | null;
  definitionMode?: "repository" | "managed";
  definitionVersion?: string | null;
  runCount: number;
  createdAt: string;
  updatedAt: string;
}

export const credentialProfileSummarySchema = z.object({
  id: credentialProfileIdSchema,
  label: z.string().trim().min(1).max(120)
    .regex(/^[^\u0000-\u001f\u007f]+$/u),
  host: z.string().trim().min(1).max(300)
    .regex(/^[^\u0000-\u0020\u007f\/@?#]+$/u, "Credential host 格式无效"),
  available: z.boolean(),
}).strict();
export type CredentialProfileSummaryDto = z.infer<typeof credentialProfileSummarySchema>;

export const repositoryOperationSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["import", "sync"]),
  state: z.enum(["queued", "running", "failed"]),
  stage: z.enum([
    "validating",
    "fetching",
    "resolving",
    "materializing",
    "indexing",
    "publishing",
  ]),
  progress: z.number().int().min(0).max(100),
  message: z.string().trim().min(1).max(1_000)
    .regex(/^[^\u0000]*$/u),
}).strict();
export type RepositoryOperationDto = z.infer<typeof repositoryOperationSchema>;

export const repositorySnapshotSchema = z.object({
  revision: gitRevisionSchema,
  resolvedRef: z.string().trim().min(1).max(255)
    .regex(/^[^\u0000-\u001f\u007f]+$/u),
  indexedAt: z.string().datetime(),
}).strict();
export type RepositorySnapshotDto = z.infer<typeof repositorySnapshotSchema>;

export const knowledgeLanguageSchema = z.object({
  language: z.string().trim().min(1).max(80)
    .regex(/^[^\u0000-\u001f\u007f]+$/u),
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
}).strict();
export type KnowledgeLanguageDto = z.infer<typeof knowledgeLanguageSchema>;

export const knowledgePathSignalSchema = z.object({
  path: safeRepositoryRelativePathSchema,
  kind: z.enum(["entry", "document", "test", "build", "key-path"]),
  summary: z.string().trim().min(1).max(500)
    .regex(/^[^\u0000]*$/u),
}).strict();
export type KnowledgePathSignalDto = z.infer<typeof knowledgePathSignalSchema>;

export const knowledgeSummarySchema = z.object({
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  languages: z.array(knowledgeLanguageSchema).max(64),
  entryPoints: z.array(knowledgePathSignalSchema).max(100),
  documents: z.array(knowledgePathSignalSchema).max(100),
  tests: z.array(knowledgePathSignalSchema).max(100),
  builds: z.array(knowledgePathSignalSchema).max(100),
  keyPaths: z.array(knowledgePathSignalSchema).max(100),
  truncated: z.boolean(),
}).strict();
export type KnowledgeSummaryDto = z.infer<typeof knowledgeSummarySchema>;

export const knowledgeSnapshotSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["indexing", "ready", "failed"]),
  revision: gitRevisionSchema,
  indexedAt: z.string().datetime().nullable(),
  summary: knowledgeSummarySchema.nullable(),
  errorMessage: z.string().trim().min(1).max(1_000)
    .regex(/^[^\u0000]*$/u)
    .nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict().superRefine((snapshot, context) => {
  if (snapshot.status === "ready" && (!snapshot.indexedAt || !snapshot.summary)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "ready Knowledge Snapshot 必须包含 indexedAt 和 summary",
    });
  }
  if (snapshot.status !== "ready" && snapshot.indexedAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["indexedAt"],
      message: "未就绪 Knowledge Snapshot 不能声明 indexedAt",
    });
  }
});
export type KnowledgeSnapshotDto = z.infer<typeof knowledgeSnapshotSchema>;

export const publicProjectSourceKindSchema = z.enum(["legacy-local", "remote-git"]);
export type PublicProjectSourceKind = z.infer<typeof publicProjectSourceKindSchema>;

export const publicProjectRepositorySchema = z.object({
  url: repositoryUrlSchema,
  host: z.string().trim().min(1).max(300)
    .regex(/^[^\u0000-\u0020\u007f\/@?#]+$/u),
  requestedRef: repositoryRefSchema.nullable(),
  credentialProfile: credentialProfileSummarySchema.nullable(),
  activeSnapshot: repositorySnapshotSchema.nullable(),
  operation: repositoryOperationSchema.nullable(),
}).strict();
export type PublicProjectRepositoryDto = z.infer<typeof publicProjectRepositorySchema>;

export const publicProjectSchema = z.object({
  id: z.string().uuid(),
  name: projectNameSchema,
  summary: z.string().trim().max(2_000),
  sourceKind: publicProjectSourceKindSchema,
  repository: publicProjectRepositorySchema.nullable(),
  knowledge: knowledgeSnapshotSchema.nullable(),
  availableActions: z.object({
    ask: z.boolean(),
    createRun: z.boolean(),
    sync: z.boolean(),
  }).strict(),
  runCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict().superRefine((project, context) => {
  if (project.sourceKind === "remote-git" && !project.repository) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["repository"],
      message: "远程项目必须包含仓库摘要",
    });
  }
  if (project.sourceKind === "legacy-local" && project.repository) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["repository"],
      message: "兼容本地项目不能伪造远程仓库摘要",
    });
  }
});
export type PublicProjectDto = z.infer<typeof publicProjectSchema>;

export const askProviderAvailabilitySchema = z.enum([
  "ready",
  "not_configured",
  "unreachable",
  "authentication_failed",
  "model_unavailable",
  "protocol_error",
]);
export type AskProviderAvailability = z.infer<typeof askProviderAvailabilitySchema>;

export const askProviderCapabilitiesSchema = z.object({
  streaming: z.boolean(),
  structuredOutput: z.boolean(),
  toolCalling: z.boolean(),
}).strict();
export type AskProviderCapabilitiesDto = z.infer<typeof askProviderCapabilitiesSchema>;

export const askProviderStatusSchema = z.object({
  id: askProviderIdSchema,
  label: z.string().trim().min(1).max(120),
  configured: z.boolean(),
  model: z.string().trim().min(1).max(256).nullable(),
  protocol: askProviderProtocolSchema,
  dataBoundary: z.enum(["remote", "local", "operator-configured"]),
  endpointLabel: z.string().trim().min(1).max(512),
  capabilities: askProviderCapabilitiesSchema,
  message: z.string().trim().min(1).max(1_000),
}).strict();
export type AskProviderStatusDto = z.infer<typeof askProviderStatusSchema>;

export const askProviderCheckSchema = z.object({
  providerId: askProviderIdSchema,
  state: askProviderAvailabilitySchema,
  model: z.string().trim().min(1).max(256).nullable(),
  message: z.string().trim().min(1).max(1_000),
  checkedAt: z.string().datetime(),
}).strict();
export type AskProviderCheckDto = z.infer<typeof askProviderCheckSchema>;

export const askCitationSchema = z.object({
  sourceId: z.string().max(80).regex(/^S[1-9][0-9]*$/u),
  path: z.string().trim().min(1).max(4_096)
    .regex(/^[^\u0000-\u001f\u007f\\]+$/u),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  revision: askRevisionSchema,
  excerpt: z.string().max(32_768),
  summary: z.string().trim().min(1).max(1_000),
}).strict().refine(
  ({ startLine, endLine }) => endLine >= startLine,
  { path: ["endLine"], message: "Ask 引用结束行不能早于起始行" },
).refine(
  ({ path: sourcePath }) => !sourcePath.startsWith("/")
    && !/^[A-Za-z]:/u.test(sourcePath)
    && sourcePath.split("/").every((component) => component !== "" && component !== "." && component !== ".."),
  { path: ["path"], message: "Ask 引用路径必须是安全的项目相对路径" },
);
export type AskCitationDto = z.infer<typeof askCitationSchema>;

export const askWorkItemDraftSchema = z.object({
  title: z.string().trim().min(1).max(200)
    .regex(/^[^\u0000-\u001f\u007f]+$/u),
  objective: z.string().trim().min(1).max(5_000)
    .regex(/^[^\u0000]*$/u),
  acceptanceCriteria: z.array(
    z.string().trim().min(1).max(1_000).regex(/^[^\u0000]*$/u),
  ).max(20),
}).strict();
export type AskWorkItemDraftDto = z.infer<typeof askWorkItemDraftSchema>;

const nullableAskTokenCountSchema = z.number().int().nonnegative().nullable();

export const askAnswerSchema = z.object({
  answer: z.string().trim().min(1).max(20_000),
  citations: z.array(askCitationSchema).max(20),
  invalidCitationIds: z.array(z.string().max(80).regex(/^S[1-9][0-9]*$/u)).max(50),
  uncertainties: z.array(z.string().trim().min(1).max(1_000)).max(24),
  suggestedQuestions: z.array(z.string().trim().min(1).max(500)).max(8),
  workItemDraft: askWorkItemDraftSchema.nullable(),
  provider: z.object({
    id: askProviderIdSchema,
    label: z.string().trim().min(1).max(120),
    model: z.string().trim().min(1).max(256),
  }).strict(),
  revision: askRevisionSchema,
  dirty: z.boolean(),
  usage: z.object({
    inputTokens: nullableAskTokenCountSchema,
    outputTokens: nullableAskTokenCountSchema,
  }).strict(),
  durationMs: z.number().int().nonnegative(),
  answeredAt: z.string().datetime(),
}).strict().superRefine(({ citations, revision }, context) => {
  for (const [index, citation] of citations.entries()) {
    if (citation.revision !== revision) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["citations", index, "revision"],
        message: "Ask 引用 revision 必须与回答一致",
      });
    }
  }
});
export type AskAnswerDto = z.infer<typeof askAnswerSchema>;

export const createAskThreadSchema = z.object({
  providerId: askProviderIdSchema,
  revision: askRevisionSchema.optional(),
  title: z.string().trim().min(1).max(200)
    .regex(/^[^\u0000-\u001f\u007f]+$/u)
    .optional(),
}).strict();
export type CreateAskThreadInput = z.infer<typeof createAskThreadSchema>;

export const sendAskThreadMessageSchema = z.object({
  question: z.string().trim().min(1).max(8_000),
  expectedRevision: askRevisionSchema,
}).strict();
export type SendAskThreadMessageInput = z.infer<typeof sendAskThreadMessageSchema>;

export const askThreadMessageSchema = z.object({
  id: z.string().uuid(),
  sequence: z.number().int().positive(),
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(20_000),
  answer: askAnswerSchema.nullable(),
  createdAt: z.string().datetime(),
}).strict().superRefine((message, context) => {
  if (message.role === "user" && message.answer !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["answer"],
      message: "用户消息不能携带模型回答",
    });
  }
  if (message.role === "assistant" && message.answer === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["answer"],
      message: "助手消息必须携带已验证回答",
    });
  }
});
export type AskThreadMessageDto = z.infer<typeof askThreadMessageSchema>;

export const askThreadSummarySchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  providerId: askProviderIdSchema,
  revision: askRevisionSchema,
  sourceRevision: gitRevisionSchema,
  title: z.string().trim().min(1).max(200)
    .regex(/^[^\u0000-\u001f\u007f]+$/u),
  status: z.enum(["active", "archived"]),
  messageCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
export type AskThreadSummaryDto = z.infer<typeof askThreadSummarySchema>;

export const askThreadSchema = askThreadSummarySchema.extend({
  messages: z.array(askThreadMessageSchema).max(200),
}).strict();
export type AskThreadDto = z.infer<typeof askThreadSchema>;

export const changesetFileStatusSchema = z.enum([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "type_changed",
  "unmerged",
]);
export type ChangesetFileStatus = z.infer<typeof changesetFileStatusSchema>;

export const changesetFileSchema = z.object({
  path: safeRepositoryRelativePathSchema,
  status: changesetFileStatusSchema,
  oldPath: safeRepositoryRelativePathSchema.nullable(),
  binary: z.boolean(),
}).strict().superRefine((file, context) => {
  const requiresOldPath = file.status === "renamed" || file.status === "copied";
  if (requiresOldPath !== (file.oldPath !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["oldPath"],
      message: requiresOldPath
        ? "rename/copy 必须包含 oldPath"
        : "只有 rename/copy 可以包含 oldPath",
    });
  }
});
export type ChangesetFileDto = z.infer<typeof changesetFileSchema>;

export const changesetSchema = z.object({
  runId: z.string().uuid(),
  baseRevision: gitRevisionSchema,
  headRevision: gitRevisionSchema.nullable(),
  dirty: z.boolean(),
  files: z.array(changesetFileSchema).max(20_000),
  patchBytes: z.number().int().nonnegative(),
  patchSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  generatedAt: z.string().datetime(),
  downloadAvailable: z.boolean(),
}).strict().superRefine((changeset, context) => {
  if (!changeset.dirty && (
    changeset.files.length > 0
    || changeset.patchBytes !== 0
    || changeset.downloadAvailable
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "干净 Changeset 不能声明变更文件、patch 或下载",
    });
  }
  if (changeset.dirty && changeset.files.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["files"],
      message: "脏 Changeset 必须包含变更文件",
    });
  }
  if (changeset.downloadAvailable !== (changeset.patchBytes > 0)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["downloadAvailable"],
      message: "Changeset 下载状态必须与 patch bytes 一致",
    });
  }
  if (
    changeset.patchBytes === 0
    && changeset.patchSha256 !== "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["patchSha256"],
      message: "空 patch 必须使用空内容 SHA-256",
    });
  }
});
export type ChangesetDto = z.infer<typeof changesetSchema>;

export type E2eReadinessState =
  | "ready"
  | "missing"
  | "invalid"
  | "unreachable"
  | "failed"
  | "not_checked";

export interface E2eWorkspaceDto {
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

export interface E2eReadinessItemDto {
  state: E2eReadinessState;
  message: string;
  detail?: string;
}

export interface E2eWorkspaceReadinessDto {
  ready: boolean;
  workspace: E2eReadinessItemDto;
  playwright: E2eReadinessItemDto;
  browser: E2eReadinessItemDto;
  sourceStartScript: E2eReadinessItemDto;
  target: E2eReadinessItemDto;
  checkedAt: string;
}

export interface E2eAuthoredFileDto {
  path: string;
  sha256: string;
  bytes: number;
  content?: string;
}

export interface E2eAuthoringDto {
  runId: string;
  executionId: string;
  status: "awaiting_review" | "approved" | "changes_requested";
  patchHash: string;
  productRevisionToken: string;
  e2eRevisionToken: string;
  criterionIds: string[];
  files: E2eAuthoredFileDto[];
  reviewComment: string | null;
  reviewedAt: string | null;
  createdAt: string;
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

export interface VerificationE2eFlowDto {
  runId: string;
  state: VerificationE2eFlowState;
  workspace: E2eWorkspaceDto | null;
  readiness: E2eWorkspaceReadinessDto | null;
  blockers: string[];
  criterionIds: string[];
  contractSource: "change_contract" | "legacy_approved_artifacts" | "unavailable";
  authoring: E2eAuthoringDto | null;
  execution: ExecutionDto | null;
  recommendedAction: string;
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

export type HumanDecisionKind = "decision" | "work" | "dependency" | "acceptance";
export type HumanDecisionGateState =
  | "clear"
  | "awaiting_decision"
  | "awaiting_role_work"
  | "inconsistent_approval";

export interface HumanDecisionItemDto {
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

export interface PhaseHumanDecisionGateDto {
  phaseId: HumanDecisionPhaseId;
  roleId: "pm-ba" | "designer" | "architect";
  state: HumanDecisionGateState;
  items: HumanDecisionItemDto[];
  blockingCount: number;
  decisionCount: number;
  workCount: number;
  dependencyCount: number;
  inconsistentApproval: boolean;
}

export interface HumanDecisionSummaryDto {
  totalBlocking: number;
  totalDecisions: number;
  totalRoleWork: number;
  inconsistentPhaseIds: HumanDecisionPhaseId[];
  phases: PhaseHumanDecisionGateDto[];
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
  /** Exact remote Git object id pinned when this Run was created. */
  baseRevision?: GitRevision | null;
  /** Immutable platform Control Pack version selected for this Run. */
  definitionVersion?: string | null;
  /** Public lifecycle only; server filesystem paths are never part of this DTO. */
  workspaceState?: "provisioning" | "ready" | "busy" | "failed" | "destroyed" | null;
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
