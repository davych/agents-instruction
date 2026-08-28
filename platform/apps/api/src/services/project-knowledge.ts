import { isDeepStrictEqual } from "node:util";

import type { GitRevision } from "@ai-sdlc/contracts";

import type { KnowledgeSnapshotRecord, PgWorkflowStore } from "../db/store.js";
import { AppError } from "../domain/errors.js";
import {
  DeepWikiLiteIndexer,
  deepWikiLiteIndexSchema,
  type DeepWikiLiteIndex,
} from "./deepwiki-lite.js";

type ProjectKnowledgeStore = Pick<PgWorkflowStore, "getKnowledgeSnapshotByRevision">;

export interface TrustedProjectKnowledge extends DeepWikiLiteIndex {
  indexedAt: string;
}

export interface ProjectKnowledgeResolverLike {
  resolve(input: {
    projectId: string;
    revision: GitRevision;
    workspaceRoot: string;
    signal?: AbortSignal;
  }): Promise<TrustedProjectKnowledge>;
}

/**
 * Turns the persisted DeepWiki result back into trusted runtime context.
 *
 * The database row, its internal JSON index and the exact Git snapshot must all
 * agree. A summary is never sent to Ask or a phase Worker merely because a row
 * says `ready`.
 */
export class ProjectKnowledgeResolver implements ProjectKnowledgeResolverLike {
  private readonly verifiedIndexes = new Map<string, Promise<DeepWikiLiteIndex>>();
  private readonly maximumCachedIndexes = 128;

  constructor(
    private readonly store: ProjectKnowledgeStore,
    private readonly indexer = new DeepWikiLiteIndexer(),
  ) {}

  async resolve(input: {
    projectId: string;
    revision: GitRevision;
    workspaceRoot: string;
    signal?: AbortSignal;
  }): Promise<TrustedProjectKnowledge> {
    throwIfKnowledgeCancelled(input.signal);
    const record = await this.store.getKnowledgeSnapshotByRevision(
      input.projectId,
      input.revision,
    );
    throwIfKnowledgeCancelled(input.signal);
    const stored = validateStoredKnowledge(record, input.projectId, input.revision);
    const cacheKey = `${input.projectId}:${input.revision}:${stored.manifestHash}`;
    let verified = this.verifiedIndexes.get(cacheKey);
    if (verified) {
      // A cache entry proves the index once, not that this Run/Ask path still
      // points at the same commit. Keep that cheaper binding check per call.
      await this.indexer.assertRevision({
        workspaceRoot: input.workspaceRoot,
        revision: input.revision,
        signal: input.signal,
      });
    } else {
      verified = this.indexer.build({
        workspaceRoot: input.workspaceRoot,
        revision: input.revision,
      }).then((actual) => {
        assertActualKnowledge(actual, stored);
        return actual;
      });
      this.verifiedIndexes.set(cacheKey, verified);
      this.trimCache(cacheKey);
      void verified.catch(() => {
        if (this.verifiedIndexes.get(cacheKey) === verified) {
          this.verifiedIndexes.delete(cacheKey);
        }
      });
    }
    const actual = await waitForSharedVerification(verified, input.signal);
    // Re-check against the freshly parsed row even on a cache hit. The cache
    // never grants authority to changed database JSON.
    assertActualKnowledge(actual, stored);
    return {
      ...actual,
      indexedAt: record!.indexedAt!,
    };
  }

  private trimCache(currentKey: string): void {
    while (this.verifiedIndexes.size > this.maximumCachedIndexes) {
      const oldest = this.verifiedIndexes.keys().next().value as string | undefined;
      if (!oldest) return;
      if (oldest === currentKey && this.verifiedIndexes.size === 1) return;
      this.verifiedIndexes.delete(oldest);
    }
  }
}

function waitForSharedVerification<T>(
  verification: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return verification;
  throwIfKnowledgeCancelled(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(knowledgeCancelled());
    signal.addEventListener("abort", onAbort, { once: true });
    void verification.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function throwIfKnowledgeCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw knowledgeCancelled();
}

function knowledgeCancelled(): AppError {
  return new AppError("项目知识校验已取消", 499, "KNOWLEDGE_CANCELLED");
}

function assertActualKnowledge(
  actual: DeepWikiLiteIndex,
  stored: DeepWikiLiteIndex,
): void {
  if (actual.manifestHash !== stored.manifestHash) {
    throw new AppError(
      "DeepWiki 索引与固定源码快照不一致，请重新同步项目",
      409,
      "KNOWLEDGE_MANIFEST_MISMATCH",
    );
  }
  if (
    !isDeepStrictEqual(actual.summary, stored.summary)
    || !isDeepStrictEqual(actual.files, stored.files)
  ) {
    throw new AppError(
      "DeepWiki 索引内容校验失败，请重新建立项目知识",
      409,
      "KNOWLEDGE_INDEX_MISMATCH",
    );
  }
}

/** Keep a remote Run bound to the knowledge produced for its own base SHA. */
export async function resolveRunProjectKnowledge(
  input: {
    project: {
      id: string;
      sourceKind: "legacy-local" | "remote-git";
      rootPath: string;
    };
    run: { baseRevision?: GitRevision | null };
    signal?: AbortSignal;
  },
  resolver?: ProjectKnowledgeResolverLike,
): Promise<TrustedProjectKnowledge | undefined> {
  if (input.project.sourceKind !== "remote-git") return undefined;
  if (!resolver) {
    throw new AppError(
      "Cloud Project knowledge 服务尚未配置",
      503,
      "KNOWLEDGE_SERVICE_UNAVAILABLE",
    );
  }
  if (!input.run.baseRevision) {
    throw new AppError(
      "远程 Run 缺少固定的源码 revision",
      500,
      "RUN_BASE_REVISION_MISSING",
    );
  }
  return resolver.resolve({
    projectId: input.project.id,
    revision: input.run.baseRevision,
    workspaceRoot: input.project.rootPath,
    signal: input.signal,
  });
}

function validateStoredKnowledge(
  record: KnowledgeSnapshotRecord | null,
  projectId: string,
  revision: GitRevision,
): DeepWikiLiteIndex {
  if (
    !record
    || record.projectId !== projectId
    || record.status !== "ready"
    || record.revision !== revision
    || !record.workspaceId
    || !record.indexedAt
    || !record.summary
    || !record.manifestHash
  ) {
    throw new AppError(
      "这个源码 revision 没有可用的 DeepWiki 项目知识",
      409,
      "KNOWLEDGE_SNAPSHOT_UNAVAILABLE",
    );
  }
  const parsed = deepWikiLiteIndexSchema.safeParse(record.indexData);
  if (
    !parsed.success
    || parsed.data.revision !== revision
    || parsed.data.manifestHash !== record.manifestHash
    || !isDeepStrictEqual(parsed.data.summary, record.summary)
  ) {
    throw new AppError(
      "DeepWiki 索引记录不完整或已损坏，请重新建立项目知识",
      409,
      "KNOWLEDGE_RECORD_INVALID",
    );
  }
  return parsed.data;
}
