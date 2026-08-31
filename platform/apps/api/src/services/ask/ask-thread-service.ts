import {
  askProjectSchema,
  type AskHistoryMessage,
  type AskThreadDto,
  type AskThreadSummaryDto,
  type CreateAskThreadInput,
  type SendAskThreadMessageInput,
} from "@ai-sdlc/contracts";

import type { PgWorkflowStore } from "../../db/store.js";
import { AppError } from "../../domain/errors.js";
import { AskService } from "./ask-service.js";

const maximumHistoryMessages = 12;

export class AskThreadService {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly store: PgWorkflowStore,
    private readonly ask: AskService,
  ) {}

  list(projectId: string): Promise<AskThreadSummaryDto[]> {
    return this.store.listAskThreads(projectId);
  }

  get(threadId: string): Promise<AskThreadDto> {
    return this.store.getAskThread(threadId);
  }

  async create(
    projectId: string,
    input: CreateAskThreadInput,
    signal?: AbortSignal,
  ): Promise<AskThreadDto> {
    const provider = this.ask.listProviders().find(({ id }) => id === input.providerId);
    if (!provider?.configured || !provider.model) {
      throw new AppError(
        provider?.message ?? "所选 Ask Provider 尚未配置",
        503,
        "ASK_PROVIDER_NOT_CONFIGURED",
      );
    }
    const revision = await this.ask.captureProjectRevision(projectId, signal);
    if (!revision.head) {
      throw new AppError(
        "Cloud Ask Thread 需要已固定的远程 Git revision",
        409,
        "ASK_GIT_SNAPSHOT_REQUIRED",
      );
    }
    if (
      input.revision
      && input.revision !== revision.revision
      && input.revision !== revision.head
    ) {
      throw new AppError(
        "创建对话时项目 revision 已变化，请刷新项目后重试",
        409,
        "ASK_REVISION_MISMATCH",
      );
    }
    const title = input.title
      ?? `项目问答 · ${(revision.head ?? revision.revision).slice(0, 12)}`;
    return this.store.createAskThread({
      projectId,
      providerId: input.providerId,
      revision: revision.revision,
      sourceRevision: revision.head,
      title,
    });
  }

  send(
    threadId: string,
    input: SendAskThreadMessageInput,
    signal?: AbortSignal,
  ): Promise<AskThreadDto> {
    return this.withThreadLock(threadId, async () => {
      const thread = await this.store.getAskThread(threadId);
      if (thread.status !== "active") {
        throw new AppError("Ask Thread 已归档", 409, "ASK_THREAD_ARCHIVED");
      }
      if (input.expectedRevision !== thread.revision) {
        throw new AppError(
          "页面中的 Ask revision 已过期，请刷新对话后重试",
          409,
          "ASK_THREAD_REVISION_MISMATCH",
        );
      }
      await this.store.assertAskThreadTurnCapacity(threadId, thread.revision);
      const project = await this.store.getProject(thread.projectId);
      const snapshotRoot = project.sourceKind === "remote-git"
        ? await this.resolveThreadSnapshotRoot(thread.projectId, thread.sourceRevision)
        : null;
      const history = boundedHistory(thread.messages);
      const answer = await this.ask.answerFromSnapshot(
        thread.projectId,
        snapshotRoot ?? project.rootPath,
        askProjectSchema.parse({
          providerId: thread.providerId,
          question: input.question,
          history,
          expectedRevision: thread.revision,
        }),
        signal,
        project.sourceKind === "remote-git" ? requireThreadSourceRevision(thread.sourceRevision) : undefined,
      );
      return this.store.appendAskThreadTurn({
        threadId,
        question: input.question,
        answer,
      });
    });
  }

  private async resolveThreadSnapshotRoot(
    projectId: string,
    sourceRevision: string | null,
  ): Promise<string | null> {
    if (!sourceRevision) return null;
    const workspace = await this.store.getKnowledgeWorkspaceByRevision(projectId, sourceRevision);
    if (!workspace) {
      throw new AppError(
        "该 Ask Thread 固定的源码与 DeepWiki 快照已不可用",
        410,
        "ASK_SNAPSHOT_GONE",
      );
    }
    return workspace.rootPath;
  }

  private async withThreadLock<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(threadId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.locks.set(threadId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(threadId) === tail) this.locks.delete(threadId);
    }
  }
}

function requireThreadSourceRevision(
  revision: AskThreadDto["sourceRevision"],
): NonNullable<AskThreadDto["sourceRevision"]> {
  if (revision) return revision;
  throw new AppError(
    "Ask Thread 缺少固定的源码 revision",
    409,
    "ASK_THREAD_REVISION_UNAVAILABLE",
  );
}

function toHistoryMessage(
  message: AskThreadDto["messages"][number],
): AskHistoryMessage {
  return {
    role: message.role,
    content: (message.role === "assistant"
      ? message.answer?.answer ?? message.content
      : message.content).slice(0, 12_000),
  };
}

function boundedHistory(messages: AskThreadDto["messages"]): AskHistoryMessage[] {
  const selected: AskHistoryMessage[] = [];
  let characters = 0;
  for (const message of messages.slice(-maximumHistoryMessages).reverse()) {
    const historyMessage = toHistoryMessage(message);
    if (characters + historyMessage.content.length > 48_000) break;
    characters += historyMessage.content.length;
    selected.push(historyMessage);
  }
  return selected.reverse();
}
