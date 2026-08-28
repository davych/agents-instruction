import { createHash } from "node:crypto";

import {
  askProjectSchema,
  createAgentSessionSchema,
  readOnlyRepositoryContextsSchema,
  sendAgentMessageSchema,
  type AgentMessageDto,
  type AgentSessionDto,
  type AskHistoryMessage,
  type AskProviderId,
  type CreateAgentSessionInput,
  type ReadOnlyRepositoryContextDto,
  type SendAgentMessageInput,
  type WorkItemDraftDto,
} from "@ai-sdlc/contracts";

import type { AgentSessionRecord, PgWorkflowStore } from "../../db/store.js";
import { AppError } from "../../domain/errors.js";
import type { AskService } from "../ask/ask-service.js";
import type { CloudProjectService } from "../cloud-project-service.js";
import type { AskProviderRegistry } from "../llm/provider-registry.js";
import { AskProviderError } from "../llm/types.js";
import type { WorkflowService } from "../workflow-service.js";
import {
  AgentSdlcCoordinator,
  explicitRoleContinuation,
  latestSessionRunId,
  type AgentSdlcAdvanceResult,
  type SdlcRoleId,
} from "./agent-sdlc-coordinator.js";
import { ConversationPlanner, SDLC_ROLE_IDS } from "./conversation-planner.js";
import type {
  AgentMcpToolChoice,
  AgentMcpToolResult,
  AgentMcpToolRouter,
} from "./mcp-tool-router.js";
import type { ReadOnlyRepositoryContextResolverLike } from "./read-only-repository-context.js";
import type { SandboxBlueprintRegistry } from "./sandbox-blueprint-registry.js";

const maximumHistoryMessages = 12;

export const AGENT_WORK_BOUNDARY_MESSAGE = [
  "当前 MVP 不开放 DDL、Secret、外部写入、push、创建 PR、合并、部署或发布；这些动作不会被伪装成可批准后执行的能力。",
  "当前真正的人工门禁是每个阶段的 Artifact 审阅或既有 Workflow 决定；通过后才会按固定顺序推进下一角色。",
].join("\n");

export interface AgentSessionDetail {
  session: AgentSessionDto;
  messages: AgentSessionRecord["messages"];
  events: AgentSessionRecord["events"];
  toolCalls: AgentSessionRecord["toolCalls"];
  humanGates: AgentSessionRecord["humanGates"];
}

/**
 * Coordinates one persisted conversation turn. The browser supplies only
 * plain text, an idempotency key, sequence, and optional next-turn Provider.
 * Repository authority, MCP exposure, Sandbox identity, Change Contract, and
 * SDLC Run construction all remain server-owned.
 */
export class AgentSessionService {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly sdlc: AgentSdlcCoordinator;

  constructor(
    private readonly store: PgWorkflowStore,
    private readonly ask: AskService,
    private readonly providers: AskProviderRegistry,
    private readonly planner: ConversationPlanner,
    private readonly mcpTools: AgentMcpToolRouter,
    private readonly workflow: WorkflowService,
    private readonly cloudProjects: CloudProjectService,
    private readonly blueprints: SandboxBlueprintRegistry,
    private readonly readOnlyRepositoryContexts?: ReadOnlyRepositoryContextResolverLike,
  ) {
    this.sdlc = new AgentSdlcCoordinator(workflow);
  }

  list(projectId?: string): Promise<AgentSessionDto[]> {
    return this.store.listAgentSessions(projectId ? { projectId } : {});
  }

  async get(sessionId: string): Promise<AgentSessionDetail> {
    return detail(await this.store.getAgentSession(sessionId));
  }

  archive(sessionId: string): Promise<AgentSessionDto> {
    return this.store.archiveAgentSession(sessionId);
  }

  async create(unparsedInput: CreateAgentSessionInput): Promise<AgentSessionDto> {
    const input = createAgentSessionSchema.parse(unparsedInput);
    if (!input.primaryProjectId) {
      const created = await this.store.createAgentSession({
        id: input.clientRequestId,
        title: input.title,
        providerId: input.providerId,
      });
      return created.session;
    }
    const project = await this.store.getProject(input.primaryProjectId);
    if (
      project.sourceKind !== "remote-git"
      || project.repositoryState !== "ready"
      || !project.currentRevision
    ) {
      throw new AppError(
        "仓库源码快照准备好后才能创建 Agent Session",
        409,
        "AGENT_SESSION_REPOSITORY_NOT_READY",
      );
    }
    const workspace = await this.store.getKnowledgeWorkspaceByRevision(
      project.id,
      project.currentRevision,
    );
    if (!workspace || workspace.state !== "ready") {
      throw new AppError(
        "仓库固定版本已不可用，请重新同步",
        409,
        "AGENT_SESSION_SNAPSHOT_UNAVAILABLE",
      );
    }
    const settings = await this.store.getProjectAgentSettings(project.id);
    const providerId = input.providerId ?? settings.defaultProviderId;
    const created = await this.store.createAgentSession({
      id: input.clientRequestId,
      title: input.title ?? `${project.name} Agent Session`,
      providerId,
      primaryRepository: {
        projectId: project.id,
        workspaceId: workspace.id,
        sourceRevision: project.currentRevision,
      },
    });
    if (!created.replayed) {
      await this.store.appendAgentEvent({
        sessionId: created.session.id,
        kind: "session.created",
        status: "completed",
        summary: `@${settings.repoAlias} 已按 ${project.currentRevision.slice(0, 12)} 固定到当前会话。`,
        projectId: project.id,
      });
    }
    return detail(await this.store.getAgentSession(created.session.id)).session;
  }

  sendMessage(
    sessionId: string,
    unparsedInput: SendAgentMessageInput,
    signal?: AbortSignal,
  ): Promise<AgentSessionDetail> {
    const input = sendAgentMessageSchema.parse(unparsedInput);
    return this.withSessionLock(sessionId, async () => {
      await this.bindMentionedReadOnlyRepositories(sessionId, input.content);
      return this.performTurn(sessionId, input, signal);
    });
  }

  private async bindMentionedReadOnlyRepositories(
    sessionId: string,
    content: string,
  ): Promise<void> {
    const aliases = repositoryMentions(content);
    if (aliases.length === 0) return;
    const session = await this.store.getAgentSession(sessionId);
    const bound = new Set(session.repositories.map(({ repoAlias }) => repoAlias));
    const unbound = aliases.filter((alias) => !bound.has(alias));
    if (unbound.length === 0) return;
    await this.store.bindReadyAgentSessionReadRepositoriesByAlias(sessionId, unbound);
  }

  private async performTurn(
    sessionId: string,
    input: SendAgentMessageInput,
    signal?: AbortSignal,
  ): Promise<AgentSessionDetail> {
    const begun = await this.store.beginAgentTurn({ sessionId, ...input });
    if (begun.replayed) {
      return this.recoverPersistedRunBookkeeping(sessionId, begun.message.id);
    }
    const userMessage = begun.message;
    return this.providers.runWithProvider(
      userMessage.providerId,
      () => this.performPinnedTurn(sessionId, input, userMessage, signal),
    );
  }

  private async performPinnedTurn(
    sessionId: string,
    input: SendAgentMessageInput,
    userMessage: AgentMessageDto,
    signal?: AbortSignal,
  ): Promise<AgentSessionDetail> {
    try {
      const session = await this.store.getAgentSession(sessionId);
      const primary = session.repositories.find(({ accessMode }) => accessMode === "write");
      if (!primary) {
        throw new AppError(
          "当前会话没有可写主仓库，请从已绑定仓库新建会话",
          409,
          "AGENT_PRIMARY_REPOSITORY_REQUIRED",
        );
      }
      assertRepositoryMentions(input.content, session);
      const mentionedAliases = repositoryMentions(input.content);
      const mentionedReadOnlyRepository = session.repositories.some((repository) => (
        repository.accessMode === "read" && mentionedAliases.includes(repository.repoAlias)
      ));
      if (mentionedReadOnlyRepository && !this.readOnlyRepositoryContexts) {
        throw new AppError(
          "只读 @repo 的固定知识服务尚未配置，本轮未把它当作可用上下文",
          503,
          "AGENT_READ_ONLY_REPOSITORY_CONTEXT_UNAVAILABLE",
        );
      }
      const readOnlyRepositories = this.readOnlyRepositoryContexts
        ? await this.readOnlyRepositoryContexts.resolve({
            repositories: session.repositories,
            mentionedAliases,
            signal,
          })
        : [];
      const settings = await this.store.getProjectAgentSettings(primary.projectId);
      const providerId = userMessage.providerId;
      const provider = assertConfiguredProvider(this.providers, providerId);
      await this.store.appendAgentEvent({
        sessionId,
        kind: "message.accepted",
        status: "completed",
        summary: `已接收 @${primary.repoAlias} 的消息，幂等序号 ${userMessage.sequence}。`,
        messageId: userMessage.id,
        projectId: primary.projectId,
      });

      const platformHelp = agentPlatformHelp(input.content, primary.repoAlias);
      if (platformHelp) {
        await this.store.completeAgentTurn({
          sessionId,
          userMessageId: userMessage.id,
          content: platformHelp,
          providerId,
          model: "platform/static-help",
        });
        await this.store.appendAgentEvent({
          sessionId,
          kind: "turn.completed",
          status: "completed",
          summary: "已返回平台使用说明；本轮不需要调用模型、工具、Sandbox 或 SDLC。",
          messageId: userMessage.id,
          projectId: primary.projectId,
        });
        return this.get(sessionId);
      }

      await this.store.appendAgentEvent({
        sessionId,
        kind: "provider.started",
        status: "started",
        summary: `本轮使用 ${provider.label}；实际模型会随回答保存。`,
        messageId: userMessage.id,
        projectId: primary.projectId,
      });

      let workItem: AgentMcpToolResult | null = null;
      if (provider.capabilities.toolCalling && settings.enabledMcpServerIds.length > 0) {
        const choice = await this.mcpTools.chooseForTurn({
          providerId,
          content: input.content,
          enabledAdapterIds: settings.enabledMcpServerIds,
          signal,
        });
        if (choice) {
          workItem = await this.executeReadOnlyTool(
            sessionId,
            userMessage.id,
            primary.projectId,
            choice,
            signal,
          );
        }
      }

      const history = boundedHistory(session.messages.filter(({ id }) => id !== userMessage.id));
      const plan = await this.planner.plan({
        providerId,
        content: input.content,
        repoAlias: primary.repoAlias,
        recentMessages: history,
        workItem: workItem?.workItem,
        readOnlyRepositories,
        signal,
      });
      const continuation = explicitRoleContinuation(input.content);
      const latestRunId = latestSessionRunId(session.sessionRuns);
      const priorRunId = continuation.explicit ? latestRunId : null;
      if (priorRunId && readOnlyRepositories.length > 0) {
        const priorRun = await this.store.getRun(priorRunId);
        assertFixedRunReadOnlyRepositories(
          priorRun.run.changeContract?.readOnlyRepositories ?? [],
          readOnlyRepositories,
        );
      }

      if (plan.intent === "chat" && !priorRunId) {
        const answer = await this.answerQuestion({
          projectId: primary.projectId,
          revision: primary.sourceRevision,
          providerId,
          question: input.content,
          history,
          externalContext: buildAgentExternalContext(
            workItem?.workItem,
            readOnlyRepositories,
          ),
          signal,
        });
        await this.store.completeAgentTurn({
          sessionId,
          userMessageId: userMessage.id,
          content: answer.answer,
          providerId,
          model: answer.provider.model,
        });
      } else if (plan.intent === "work" && plan.clarification) {
        const response = [
          plan.clarification.question,
          "",
          ...plan.clarification.options.map((option, index) => `${index + 1}. ${option}`),
          "",
          "我只需要这一个决定；确认后会继续同一条会话，不会让你填写长表单。",
        ].join("\n");
        await this.store.completeAgentTurn({
          sessionId,
          userMessageId: userMessage.id,
          content: response,
          providerId,
          model: plan.model,
        });
      } else {
        if (!provider.capabilities.toolCalling) {
          await this.store.completeAgentTurn({
            sessionId,
            userMessageId: userMessage.id,
            content: `${provider.label} 当前可以聊天和生成 DeepWiki，但不能安全地启动带工具的工作回合。请在输入框旁切换到支持工具调用的 Provider；你的会话和这条需求都已保留。`,
            providerId,
            model: plan.model,
          });
          await this.store.appendAgentEvent({
            sessionId,
            kind: "turn.completed",
            status: "completed",
            summary: "本轮未启动 Sandbox 或 SDLC；会话可直接切换 Provider 后继续。",
            messageId: userMessage.id,
            projectId: primary.projectId,
          });
          return this.get(sessionId);
        }
        if (!priorRunId && latestRunId) {
          await this.store.completeAgentTurn({
            sessionId,
            userMessageId: userMessage.id,
            content: [
              `这个 Session 已经有 Run \`${latestRunId}\`，我不会把一项新工作悄悄混进同一个可写 Sandbox。`,
              "",
              "如果这是原任务的后续，请说“继续当前 Run，并 involve ……”；如果是另一项工作，请点左侧“新建 Agent Session”。",
            ].join("\n"),
            providerId,
            model: plan.model,
          });
          await this.store.appendAgentEvent({
            sessionId,
            kind: "turn.completed",
            status: "completed",
            summary: "检测到新的工作意图；为避免把两个 Run 混进同一 Sandbox，本轮未执行。",
            messageId: userMessage.id,
            projectId: primary.projectId,
          });
          return this.get(sessionId);
        }
        const blueprint = this.blueprints.resolve(
          settings.sandboxBlueprintId,
          settings.sandboxBlueprintVersion,
        );
        if (!blueprint.configured) {
          throw new AppError(
            "当前仓库的 Sandbox 蓝图尚未由管理员配置",
            503,
            "AGENT_SANDBOX_BLUEPRINT_NOT_CONFIGURED",
          );
        }
        await this.store.appendAgentEvent({
          sessionId,
          kind: "sandbox.starting",
          status: "started",
          summary: `正在按蓝图 ${blueprint.label} ${blueprint.version} 启动 @${primary.repoAlias} Sandbox。`,
          messageId: userMessage.id,
          projectId: primary.projectId,
        });
        const preparedSandbox = await this.cloudProjects.prepareAgentSandbox({
          sessionId,
          projectId: primary.projectId,
          sourceRevision: primary.sourceRevision,
        }, signal);
        await this.store.appendAgentEvent({
          sessionId,
          kind: "sandbox.ready",
          status: "completed",
          summary: `@${primary.repoAlias} Sandbox 已就绪；主仓库可写，其他 @repo 保持只读。`,
          messageId: userMessage.id,
          projectId: primary.projectId,
        });
        const focusRoles = plan.involveRoles;
        let response: string;
        if (priorRunId) {
          const progress = await this.sdlc.advance({
            runId: priorRunId,
            requestedRoles: continuation.roles,
            startCurrentRole: true,
          });
          await this.recordSdlcAdvance({
            sessionId,
            messageId: userMessage.id,
            projectId: primary.projectId,
            progress,
          });
          response = renderRunContinued({
            alias: primary.repoAlias,
            focusRoles: continuation.roles.length > 0 ? continuation.roles : focusRoles,
            progress,
          });
        } else {
          if (plan.intent !== "work") {
            throw new AppError(
              "这条消息要求继续 SDLC，但当前会话没有可继续的 Run",
              409,
              "AGENT_SDLC_RUN_REQUIRED",
            );
          }
          const contract = this.planner.changeContract({
            plan,
            sessionId,
            messageId: userMessage.id,
            workItem: workItem?.workItem,
            readOnlyRepositories,
          });
          const run = await this.workflow.createRun(primary.projectId, {
            title: plan.task.title,
            objective: contract.summary,
            changeContract: contract,
            baseRevision: primary.sourceRevision,
          }, preparedSandbox, {
            sessionId,
            triggerMessageId: userMessage.id,
          });
          await this.store.appendAgentEvent({
            sessionId,
            kind: "sdlc.run-created",
            status: "completed",
            summary: "已从对话整理 Change Contract，并创建固定六角色的后台 Run。",
            messageId: userMessage.id,
            projectId: primary.projectId,
            workflowRunId: run.id,
          });
          // A new Run always starts from PM / BA, even when the user mainly
          // cares about a later role. Focus roles stay visible in the reply,
          // but never become permission to skip their upstream owners.
          const progress = await this.sdlc.advance({
            runId: run.id,
            requestedRoles: focusRoles,
            startCurrentRole: true,
          });
          await this.recordSdlcAdvance({
            sessionId,
            messageId: userMessage.id,
            projectId: primary.projectId,
            progress,
          });
          response = renderWorkAccepted({
            alias: primary.repoAlias,
            runId: run.id,
            focusRoles,
            title: plan.task.title,
            reason: plan.reason,
            progress,
          });
        }
        await this.store.completeAgentTurn({
          sessionId,
          userMessageId: userMessage.id,
          content: response,
          providerId,
          model: plan.model,
        });
      }

      await this.store.appendAgentEvent({
        sessionId,
        kind: "turn.completed",
        status: "completed",
        summary: "本轮已完成；Provider、模型、工具、revision 和 SDLC 关联已保存。",
        messageId: userMessage.id,
        projectId: primary.projectId,
      });
      return this.get(sessionId);
    } catch (error) {
      await this.store.appendAgentEvent({
        sessionId,
        kind: "turn.failed",
        status: "failed",
        summary: agentTurnFailureSummary(error),
        messageId: userMessage.id,
      }).catch(() => undefined);
      await this.store.failAgentTurn({ sessionId, userMessageId: userMessage.id }).catch(() => undefined);
      // A failed turn stays visible for audit, but it must not brick the
      // conversation. The next request continues from the latest sequence.
      await this.store.resetInterruptedAgentSession(sessionId).catch(() => undefined);
      throw error;
    }
  }

  /**
   * A same-clientMessageId retry never replays Provider, MCP, planning, or
   * phase execution. It may only reconcile bookkeeping already proven by the
   * durable Session→Run mapping written with the Run transaction.
   */
  private async recoverPersistedRunBookkeeping(
    sessionId: string,
    messageId: string,
  ): Promise<AgentSessionDetail> {
    let record = await this.store.getAgentSession(sessionId);
    const association = record.sessionRuns.find(
      (candidate) => candidate.triggerMessageId === messageId,
    );
    if (!association) return detail(record);

    if (record.sandbox?.state === "ready") {
      await this.store.transitionAgentSandbox({
        id: record.sandbox.id,
        expectedState: "ready",
        state: "busy",
      });
    }
    const hasRunCreatedEvent = record.events.some((event) => (
      event.kind === "sdlc.run-created"
      && event.messageId === messageId
      && event.workflowRunId === association.workflowRunId
    ));
    if (!hasRunCreatedEvent) {
      const primary = record.repositories.find(({ accessMode }) => accessMode === "write");
      await this.store.appendAgentEvent({
        sessionId,
        kind: "sdlc.run-created",
        status: "completed",
        summary: "已恢复这条消息已经持久化的 SDLC Run；没有重放 Provider、MCP 或阶段执行。",
        messageId,
        projectId: primary?.projectId ?? null,
        workflowRunId: association.workflowRunId,
      });
    }
    record = await this.store.getAgentSession(sessionId);
    return detail(record);
  }

  private async answerQuestion(input: {
    projectId: string;
    revision: string;
    providerId: AskProviderId;
    question: string;
    history: AskHistoryMessage[];
    externalContext?: unknown;
    signal?: AbortSignal;
  }) {
    const workspace = await this.store.getKnowledgeWorkspaceByRevision(
      input.projectId,
      input.revision,
    );
    if (!workspace || workspace.state !== "ready") {
      throw new AppError("当前会话固定的源码快照已不可用", 410, "AGENT_SESSION_SNAPSHOT_GONE");
    }
    return this.ask.answerFromSnapshot(
      input.projectId,
      workspace.rootPath,
      askProjectSchema.parse({
        providerId: input.providerId,
        question: input.question,
        history: input.history,
      }),
      input.signal,
      input.revision,
      input.externalContext,
    );
  }

  private async executeReadOnlyTool(
    sessionId: string,
    messageId: string,
    projectId: string,
    choice: AgentMcpToolChoice,
    signal?: AbortSignal,
  ): Promise<AgentMcpToolResult> {
    const created = await this.store.createAgentToolCall({
      sessionId,
      messageId,
      callKey: `work-item:${choice.adapterId}:${sha256(choice.reference)}`,
      mcpServerId: choice.adapterId,
      toolName: "resolve_work_item",
      permissionClass: "read",
      argumentsSha256: sha256(JSON.stringify({ reference: choice.reference })),
    });
    if (created.toolCall.status === "completed") {
      throw new AppError(
        "这次只读 MCP 调用已经完成，但结果正文不会从审计表反序列化；请重试整条幂等消息。",
        409,
        "AGENT_MCP_RESULT_REPLAY_REQUIRED",
      );
    }
    const running = await this.store.updateAgentToolCall({
      id: created.toolCall.id,
      expectedStatus: "queued",
      status: "running",
    });
    await this.store.appendAgentEvent({
      sessionId,
      kind: "tool.started",
      status: "started",
      summary: `Agent 自主选择只读 MCP：${choice.adapterLabel}。`,
      messageId,
      toolCallId: running.id,
      projectId,
    });
    try {
      const result = await this.mcpTools.executeChoice(choice, signal);
      const completed = await this.store.updateAgentToolCall({
        id: running.id,
        expectedStatus: "running",
        status: "completed",
        outputSha256: sha256(JSON.stringify(result.workItem)),
        summary: `读取了 ${result.workItem.source.externalId}，并固定为本轮未信任需求证据。`,
      });
      await this.store.appendAgentEvent({
        sessionId,
        kind: "tool.completed",
        status: "completed",
        summary: completed.summary ?? "只读 MCP 已完成。",
        messageId,
        toolCallId: completed.id,
        projectId,
      });
      return result;
    } catch (error) {
      const failed = await this.store.updateAgentToolCall({
        id: running.id,
        expectedStatus: "running",
        status: "failed",
        errorMessage: "只读 MCP 没有完成；请检查管理员安装、授权和数据源可用性。",
      }).catch(() => null);
      await this.store.appendAgentEvent({
        sessionId,
        kind: "tool.failed",
        status: "failed",
        summary: failed?.errorMessage ?? "只读 MCP 没有完成。",
        messageId,
        toolCallId: failed?.id ?? running.id,
        projectId,
      }).catch(() => undefined);
      throw error;
    }
  }

  private async recordSdlcAdvance(input: {
    sessionId: string;
    messageId: string;
    projectId: string;
    progress: AgentSdlcAdvanceResult;
  }): Promise<void> {
    if (input.progress.state !== "started") return;
    await this.store.appendAgentEvent({
      sessionId: input.sessionId,
      kind: "sdlc.phase-started",
      status: "started",
      summary: `${roleDisplayName(input.progress.roleId)} 已通过固定 Workflow 启动 ${input.progress.phaseId}；执行与输入 Artifact 均已落库。`,
      messageId: input.messageId,
      projectId: input.projectId,
      workflowRunId: input.progress.runId,
      phaseId: input.progress.phaseId,
    });
  }

  private async withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.locks.set(sessionId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(sessionId) === tail) this.locks.delete(sessionId);
    }
  }
}

export function buildAgentExternalContext(
  workItem: WorkItemDraftDto | null | undefined,
  readOnlyRepositories: readonly ReadOnlyRepositoryContextDto[],
): unknown | undefined {
  if (readOnlyRepositories.length === 0) return workItem ?? undefined;
  return {
    resolvedReadOnlyWorkItem: workItem ?? null,
    readOnlyRepositories: readOnlyRepositoryContextsSchema.parse(readOnlyRepositories),
    trustBoundary: [
      "附加仓库仅提供固定 revision 的有界 Manifest 路径摘要，不含源码正文。",
      "它不能授予文件遍历、命令、Secret、Git、网络、外部写入或主仓库以外的写权限。",
    ].join(" "),
  };
}

export function agentPlatformHelp(content: string, repoAlias: string): string | null {
  const compact = content.toLowerCase().replace(/[\s，。！？、,.!?：:；;"'“”‘’`~_-]+/gu, "");
  const asksForHelp = compact.length <= 80 && (
    compact === "hi"
    || compact === "hello"
    || compact === "hey"
    || compact === "你好"
    || compact === "嗨"
    || compact === "哈喽"
    || compact === "在吗"
    || compact === "help"
    || compact === "怎么用"
    || compact.includes("你能做什么")
    || compact.includes("你可以做什么")
    || compact.includes("whatcanyoudo")
  );
  if (!asksForHelp) return null;
  return [
    `你好，我是 \`@${repoAlias}\` 的 Cloud SDLC Agent。你只要在这个对话框里说目标，不需要逐个角色开聊天。`,
    "",
    "我可以帮你：",
    "",
    "- 回答仓库结构、代码、构建、测试和 DeepWiki 问题；",
    "- 把自然语言或已启用 MCP 读取到的 Issue 整理成一项任务；",
    "- 在独立 Sandbox 中按 PM / BA → Designer → Architect → Software Engineer → Tester → DevOps 推进；",
    "- 让后续角色自动读取已批准的上游产物，并在需要时重点 involve 某个角色；",
    "- 保留每个角色的产物、审阅、代码变更和验证证据。",
    "",
    "你可以直接说：‘修复登录失败问题，involve Tester 做回归’，或者先问：‘这个仓库的登录流程在哪里？’",
    "",
    AGENT_WORK_BOUNDARY_MESSAGE,
  ].join("\n");
}

function assertFixedRunReadOnlyRepositories(
  fixed: readonly ReadOnlyRepositoryContextDto[],
  mentioned: readonly ReadOnlyRepositoryContextDto[],
): void {
  const fixedByAlias = new Map(fixed.map((context) => [context.repoAlias, context]));
  const changed = mentioned.find((context) => {
    const expected = fixedByAlias.get(context.repoAlias);
    return !expected
      || expected.sourceRevision !== context.sourceRevision
      || expected.manifestHash !== context.manifestHash
      || expected.summary !== context.summary;
  });
  if (!changed) return;
  throw new AppError(
    `当前 Run 没有固定 @${changed.repoAlias} 的这份只读知识；请新建 Agent Session 开始一项新工作`,
    409,
    "AGENT_READ_ONLY_REPOSITORY_RUN_CONTEXT_IMMUTABLE",
  );
}

function detail(record: AgentSessionRecord): AgentSessionDetail {
  const { messages, events, toolCalls, humanGates, sessionRuns: _sessionRuns, ...session } = record;
  return { session, messages, events, toolCalls, humanGates };
}

function assertConfiguredProvider(registry: AskProviderRegistry, providerId: AskProviderId) {
  const status = registry.status(providerId);
  if (!status.configured || !status.model) {
    throw new AppError(
      status.message || `${status.label} 尚未配置`,
      503,
      "AGENT_PROVIDER_NOT_CONFIGURED",
    );
  }
  return status;
}

function assertRepositoryMentions(content: string, session: AgentSessionDto): void {
  const aliases = repositoryMentions(content);
  const bound = new Set(session.repositories.map(({ repoAlias }) => repoAlias));
  const unknown = [...new Set(aliases.filter((alias) => !bound.has(alias)))];
  if (unknown.length > 0) {
    throw new AppError(
      `这些 @repo 没有绑定到当前会话：${unknown.map((alias) => `@${alias}`).join("、")}`,
      400,
      "AGENT_REPOSITORY_MENTION_UNKNOWN",
    );
  }
}

function repositoryMentions(content: string): string[] {
  return [...new Set(
    [...content.matchAll(/(?:^|\s)@([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\b/gu)]
      .map((match) => match[1]!),
  )];
}

function boundedHistory(messages: AgentSessionRecord["messages"]): AskHistoryMessage[] {
  const history: AskHistoryMessage[] = [];
  let characters = 0;
  for (const message of messages.slice(-maximumHistoryMessages).reverse()) {
    if (!message.content || message.status !== "completed") continue;
    const content = message.content.slice(0, 12_000);
    if (characters + content.length > 48_000) break;
    characters += content.length;
    history.push({ role: message.role, content });
  }
  return history.reverse();
}

function renderWorkAccepted(input: {
  alias: string;
  runId: string;
  focusRoles: readonly string[];
  title: string;
  reason: string;
  progress: AgentSdlcAdvanceResult;
}): string {
  const roleNames: Record<string, string> = {
    "pm-ba": "PM / BA（目标、范围、Change Contract、PRD、Stories）",
    designer: "Designer（体验判断与 Design Spec）",
    architect: "Architect（方案、ADR、架构与 NFR）",
    "software-engineer": "Software Engineer（实施计划、代码、测试与自审）",
    tester: "Tester（独立验证、Test Report 与剩余风险）",
    devops: "DevOps（Release Runbook、回滚与发布前条件）",
  };
  return [
    `已接下 **${input.title}**，目标仓库是 \`@${input.alias}\`。`,
    "",
    input.reason,
    "",
    renderProgress(input.progress),
    "",
    "后台 Run 已建立。角色产物会按固定顺序传递：",
    "",
    ...SDLC_ROLE_IDS.map((role, index) => (
      `${index + 1}. ${roleNames[role]}${input.focusRoles.includes(role) ? " · involve 关注点" : ""}`
    )),
    "",
    `Run：\`${input.runId}\`。完整 Artifact、Review、Diff、测试和 Patch 可从右侧“高级审计”打开。`,
    "",
    AGENT_WORK_BOUNDARY_MESSAGE,
  ].join("\n");
}

function renderRunContinued(input: {
  alias: string;
  focusRoles: readonly SdlcRoleId[];
  progress: AgentSdlcAdvanceResult;
}): string {
  const requested = input.focusRoles.length > 0
    ? `你点名的 involve 关注角色是：${input.focusRoles.map(roleDisplayName).join("、")}。它们会在自己的固定阶段重点处理，不会跳过或挡住当前角色。`
    : "你要求继续当前 SDLC Run。";
  return [
    `已沿用 \`@${input.alias}\` 的 Run \`${input.progress.runId}\`，没有重复创建任务。`,
    "",
    requested,
    renderProgress(input.progress),
    "",
    "角色仍按 PM / BA → Designer → Architect → Software Engineer → Tester → DevOps 串联；后一个角色只读取已批准的上游 Artifact。",
    "完整产物与审阅入口在右侧“高级审计”。",
  ].join("\n");
}

function renderProgress(progress: AgentSdlcAdvanceResult): string {
  if (progress.state === "started") {
    return `当前真实进度：${roleDisplayName(progress.roleId)} 已启动 ${progress.phaseId}（Execution \`${progress.execution.id}\`）。`;
  }
  if (progress.state === "completed") {
    return `当前真实进度：${progress.reason}${renderArtifactKeys(progress.artifactKeys)}`;
  }
  return `当前真实进度：${progress.reason}${renderArtifactKeys(progress.artifactKeys)}`;
}

function renderArtifactKeys(keys: readonly string[]): string {
  return keys.length > 0 ? ` 当前产物：${keys.map((key) => `\`${key}\``).join("、")}。` : "";
}

function roleDisplayName(roleId: SdlcRoleId): string {
  return {
    "pm-ba": "PM / BA",
    designer: "Designer",
    architect: "Architect",
    "software-engineer": "Software Engineer",
    tester: "Tester",
    devops: "DevOps",
  }[roleId];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function agentTurnFailureSummary(error: unknown): string {
  if (error instanceof AskProviderError) {
    return `Provider 阶段失败：${error.message}；本轮未继续启动 Sandbox 或 SDLC。`;
  }
  if (error instanceof AppError && (
    error.statusCode < 500
    || PUBLIC_AGENT_5XX_ERROR_CODES.has(error.code)
  )) return error.message;
  return "本轮因未识别的服务端错误而中止；没有继续启动 Sandbox 或 SDLC。";
}

const PUBLIC_AGENT_5XX_ERROR_CODES = new Set([
  "AGENT_PLAN_INVALID",
  "AGENT_PROVIDER_NOT_CONFIGURED",
  "AGENT_READ_ONLY_REPOSITORY_CONTEXT_UNAVAILABLE",
  "AGENT_SANDBOX_BLUEPRINT_NOT_CONFIGURED",
  "ASK_FAILED",
  "ASK_PROVIDER_NOT_CONFIGURED",
  "ASK_PROVIDER_AUTHENTICATION_FAILED",
  "ASK_PROVIDER_REQUEST_INVALID",
  "ASK_PROVIDER_CANCELLED",
  "ASK_PROVIDER_TIMEOUT",
  "ASK_PROVIDER_UNREACHABLE",
  "ASK_PROVIDER_RATE_LIMITED",
  "ASK_PROVIDER_MODEL_UNAVAILABLE",
  "ASK_PROVIDER_REQUEST_REJECTED",
  "ASK_PROVIDER_RESPONSE_TOO_LARGE",
  "ASK_PROVIDER_PROTOCOL_ERROR",
  "ASK_MODEL_RESPONSE_INVALID",
  "ASK_REPOSITORY_UNAVAILABLE",
]);
