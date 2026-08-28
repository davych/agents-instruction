import type {
  AskAnswerDto,
  AskHistoryMessage,
  AskProjectInput,
  AskProviderCheckDto,
  AskProviderId,
  AskProviderStatusDto,
  GitRevision,
  ProjectDto,
} from "@ai-sdlc/contracts";

import type { PgWorkflowStore } from "../../db/store.js";
import { AppError } from "../../domain/errors.js";
import { ProjectPathPolicy } from "../project-paths.js";
import type {
  ProjectKnowledgeResolverLike,
  TrustedProjectKnowledge,
} from "../project-knowledge.js";
import {
  AskProviderError,
  type AskLlmCompleteResponse,
} from "../llm/types.js";
import type { AskProviderRegistry } from "../llm/provider-registry.js";
import {
  InvalidAskModelResponseError,
  askAnswerJsonSchema,
  parseAndValidateAskAnswer,
} from "./ask-answer.js";
import { ASK_SYSTEM_PROMPT, buildBoundedAskPromptMessages } from "./ask-prompt.js";
import {
  RepositoryRetrievalError,
  RepositoryRetriever,
  type RepositoryContextPack,
  type RepositoryRetrievalLimits,
  type RepositoryRevision,
} from "./repository-retriever.js";

type AskProjectStore = Pick<PgWorkflowStore, "getProject">;

export class AskService {
  constructor(
    private readonly store: AskProjectStore,
    private readonly paths: ProjectPathPolicy,
    private readonly providers: AskProviderRegistry,
    private readonly retriever = new RepositoryRetriever(),
    private readonly knowledge?: ProjectKnowledgeResolverLike,
  ) {}

  listProviders(): AskProviderStatusDto[] {
    return this.providers.statuses();
  }

  async checkProvider(
    providerId: AskProviderId,
    signal?: AbortSignal,
  ): Promise<AskProviderCheckDto> {
    try {
      return await this.providers.check(providerId, signal);
    } catch (error) {
      throw publicAskError(error);
    }
  }

  async answer(
    projectId: string,
    input: AskProjectInput,
    signal?: AbortSignal,
  ): Promise<AskAnswerDto> {
    assertActive(signal);
    const project = await this.store.getProject(projectId);
    if (project.sourceKind === "remote-git") {
      throw new AppError(
        "Cloud 远程项目只支持服务端 Ask Thread；请创建对话后提问",
        409,
        "ASK_THREAD_REQUIRED",
      );
    }
    const projectRoot = await this.paths.resolveProjectPath(project.rootPath);
    assertSameProjectRoot(project, projectRoot);
    return this.answerFromResolvedRoot(input, projectRoot, signal);
  }

  /**
   * Answers against a server-selected immutable snapshot. The path never comes
   * from the browser; callers must first resolve it from a Managed Workspace
   * record belonging to the same project/revision.
   */
  async answerFromSnapshot(
    projectId: string,
    projectRoot: string,
    input: AskProjectInput,
    signal?: AbortSignal,
    sourceRevision?: GitRevision,
    externalContext?: unknown,
  ): Promise<AskAnswerDto> {
    assertActive(signal);
    const project = await this.store.getProject(projectId);
    const resolvedRoot = await this.paths.resolveProjectPath(projectRoot);
    const knowledge = project.sourceKind === "remote-git"
      ? await this.resolveKnowledge(
        project.id,
        requireSourceRevision(sourceRevision),
        resolvedRoot,
        signal,
      )
      : undefined;
    return this.answerFromResolvedRoot(input, resolvedRoot, signal, knowledge, externalContext);
  }

  async captureProjectRevision(
    projectId: string,
    signal?: AbortSignal,
  ): Promise<RepositoryRevision> {
    assertActive(signal);
    const project = await this.store.getProject(projectId);
    const projectRoot = await this.paths.resolveProjectPath(project.rootPath);
    assertSameProjectRoot(project, projectRoot);
    try {
      return await this.retriever.captureRevision({ projectRoot, signal });
    } catch (error) {
      throw publicAskError(error);
    }
  }

  private answerFromResolvedRoot(
    input: AskProjectInput,
    projectRoot: string,
    signal?: AbortSignal,
    knowledge?: TrustedProjectKnowledge,
    externalContext?: unknown,
  ): Promise<AskAnswerDto> {
    return this.providers.runWithProvider(
      input.providerId,
      () => this.answerFromPinnedResolvedRoot(
        input,
        projectRoot,
        signal,
        knowledge,
        externalContext,
      ),
    );
  }

  private async answerFromPinnedResolvedRoot(
    input: AskProjectInput,
    projectRoot: string,
    signal?: AbortSignal,
    knowledge?: TrustedProjectKnowledge,
    externalContext?: unknown,
  ): Promise<AskAnswerDto> {
    const startedAt = Date.now();

    try {
      const status = this.providers.status(input.providerId);
      if (!status.configured || !status.model) {
        throw new AppError(
          status.message || `${status.label} 还没有配置完成`,
          503,
          "ASK_PROVIDER_NOT_CONFIGURED",
          { providerId: input.providerId, retryable: false },
        );
      }
      const profile = askPromptProfile(input.providerId);
      const context = await this.retriever.retrieve({
        projectRoot,
        question: input.question,
        expectedRevision: input.expectedRevision,
        knowledge,
        signal,
        limits: profile.retrievalLimits,
      });
      assertActive(signal);
      const retrievalTruncated = context.truncated || evidenceReachedProviderLimit(context, profile);
      const prompt = buildBoundedAskPromptMessages({
        question: input.question,
        history: boundedProviderHistory(input.history, profile.historyCharacters),
        revision: context.revision,
        dirty: context.dirty,
        truncated: retrievalTruncated,
        sources: context.sources,
        knowledge,
        externalContext,
      }, profile.promptCharacters);
      const modelResponse = await this.providers.complete(
        input.providerId,
        {
          systemPrompt: ASK_SYSTEM_PROMPT,
          messages: prompt.messages,
          jsonSchema: askAnswerJsonSchema as unknown as Record<string, unknown>,
          maxOutputTokens: profile.maxOutputTokens,
        },
        signal,
      );
      assertActive(signal);
      return materializeAnswer({
        response: modelResponse,
        status,
        revision: context.revision,
        dirty: context.dirty,
        truncated: prompt.repositoryEvidenceTruncated,
        sources: prompt.sources,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      throw publicAskError(error);
    }
  }

  private resolveKnowledge(
    projectId: string,
    revision: GitRevision,
    workspaceRoot: string,
    signal?: AbortSignal,
  ): Promise<TrustedProjectKnowledge> {
    if (!this.knowledge) {
      throw new AppError(
        "Cloud Project knowledge 服务尚未配置",
        503,
        "KNOWLEDGE_SERVICE_UNAVAILABLE",
      );
    }
    return this.knowledge.resolve({ projectId, revision, workspaceRoot, signal });
  }
}

interface AskPromptProfile {
  retrievalLimits?: Partial<RepositoryRetrievalLimits>;
  historyCharacters: number;
  promptCharacters: number;
  maxOutputTokens: number;
}

const OPENAI_PROMPT_PROFILE: AskPromptProfile = Object.freeze({
  historyCharacters: 48_000,
  promptCharacters: 100_000,
  maxOutputTokens: 4_096,
});

const LOCAL_PROMPT_PROFILES: Readonly<Record<Exclude<AskProviderId, "openai">, AskPromptProfile>> =
  Object.freeze({
    lmstudio: Object.freeze({
      retrievalLimits: Object.freeze({
        maxSources: 6,
        maxContextBytes: 12 * 1024,
        maxExcerptBytes: 2 * 1024,
        maxExcerptLines: 80,
      }),
      historyCharacters: 8_000,
      promptCharacters: 10_000,
      maxOutputTokens: 1_536,
    }),
    ollama: Object.freeze({
      retrievalLimits: Object.freeze({
        maxSources: 4,
        maxContextBytes: 8 * 1024,
        maxExcerptBytes: 2 * 1024,
        maxExcerptLines: 60,
      }),
      historyCharacters: 4_000,
      promptCharacters: 6_000,
      maxOutputTokens: 1_024,
    }),
    custom: Object.freeze({
      retrievalLimits: Object.freeze({
        maxSources: 8,
        maxContextBytes: 24 * 1024,
        maxExcerptBytes: 3 * 1024,
        maxExcerptLines: 100,
      }),
      historyCharacters: 12_000,
      promptCharacters: 16_000,
      maxOutputTokens: 2_048,
    }),
  });

export function askPromptProfile(providerId: AskProviderId): AskPromptProfile {
  return providerId === "openai" ? OPENAI_PROMPT_PROFILE : LOCAL_PROMPT_PROFILES[providerId];
}

function boundedProviderHistory(
  history: readonly AskHistoryMessage[],
  maximumCharacters: number,
): AskHistoryMessage[] {
  const bounded: AskHistoryMessage[] = [];
  let remaining = maximumCharacters;
  for (const message of [...history].reverse()) {
    if (remaining <= 0) break;
    const content = message.content.length <= remaining
      ? message.content
      : message.content.slice(-remaining).trimStart();
    if (content) bounded.push({ role: message.role, content });
    remaining -= content.length;
  }
  return bounded.reverse();
}

function evidenceReachedProviderLimit(
  context: RepositoryContextPack,
  profile: AskPromptProfile,
): boolean {
  const limits = profile.retrievalLimits;
  if (!limits) return false;
  return (
    limits.maxSources !== undefined && context.sources.length >= limits.maxSources
  ) || (
    limits.maxContextBytes !== undefined && context.stats.sourceBytes >= limits.maxContextBytes
  );
}

function materializeAnswer(input: {
  response: AskLlmCompleteResponse;
  status: AskProviderStatusDto;
  revision: string;
  dirty: boolean;
  truncated: boolean;
  sources: Parameters<typeof parseAndValidateAskAnswer>[1];
  durationMs: number;
}): AskAnswerDto {
  const validated = parseAndValidateAskAnswer(input.response.text, input.sources, {
    contextTruncated: input.truncated,
  });
  return {
    ...validated,
    provider: {
      id: input.status.id,
      label: input.status.label,
      model: input.response.model,
    },
    revision: input.revision,
    dirty: input.dirty,
    usage: input.response.usage,
    durationMs: input.durationMs,
    answeredAt: new Date().toISOString(),
  };
}

function assertSameProjectRoot(project: ProjectDto, resolvedRoot: string): void {
  if (project.rootPath === resolvedRoot) return;
  throw new AppError(
    "项目目录的真实位置已经变化，请重新注册项目后再提问",
    409,
    "ASK_PROJECT_ROOT_CHANGED",
  );
}

function requireSourceRevision(revision: GitRevision | null | undefined): GitRevision {
  if (revision) return revision;
  throw new AppError(
    "Ask Thread 缺少固定的源码 revision",
    409,
    "ASK_GIT_SNAPSHOT_REQUIRED",
  );
}

function assertActive(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new AppError("项目问答已取消", 499, "ASK_CANCELLED", { retryable: true });
}

function publicAskError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof AskProviderError) {
    return new AppError(error.message, error.statusCode, error.code, {
      providerId: error.providerId,
      availability: error.availability,
      retryable: error.retryable,
      upstreamStatus: error.upstreamStatus,
    });
  }
  if (error instanceof InvalidAskModelResponseError) {
    return new AppError(error.message, 502, error.code, { retryable: true });
  }
  if (error instanceof RepositoryRetrievalError) {
    return new AppError(error.message, error.statusCode, error.code, {
      retryable: error.retryable,
    });
  }
  return new AppError("项目问答暂时失败，请稍后重试", 500, "ASK_FAILED", {
    retryable: true,
  });
}
