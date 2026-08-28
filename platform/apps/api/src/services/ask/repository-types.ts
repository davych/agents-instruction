import type { TrustedProjectKnowledge } from "../project-knowledge.js";

export interface RepositoryRetrievalLimits {
  /** Maximum directory entries inspected, including skipped entries. */
  maxEntries: number;
  /** Maximum regular files inspected, including sensitive/binary files that are skipped. */
  maxFiles: number;
  /** Maximum bytes read from any one file. */
  maxFileBytes: number;
  /** Maximum aggregate bytes read while building one evidence snapshot. */
  maxTotalBytes: number;
  /** Maximum evidence sources returned to the model. */
  maxSources: number;
  /** Maximum aggregate UTF-8 bytes returned in source excerpts. */
  maxContextBytes: number;
  /** Maximum UTF-8 bytes in one source excerpt. */
  maxExcerptBytes: number;
  /** Maximum lines in one source excerpt. */
  maxExcerptLines: number;
  /** Timeout for each read-only Git query. */
  gitTimeoutMs: number;
  /**
   * Maximum buffered stdout/stderr accepted from one read-only Git query.
   * NUL-delimited file lists stream and use this only as their stderr limit.
   */
  gitMaxBufferBytes: number;
}

export const DEFAULT_REPOSITORY_RETRIEVAL_LIMITS: Readonly<RepositoryRetrievalLimits> =
  Object.freeze({
    maxEntries: 8_000,
    maxFiles: 1_500,
    maxFileBytes: 256 * 1024,
    maxTotalBytes: 8 * 1024 * 1024,
    maxSources: 16,
    maxContextBytes: 64 * 1024,
    maxExcerptBytes: 8 * 1024,
    maxExcerptLines: 120,
    gitTimeoutMs: 5_000,
    gitMaxBufferBytes: 16 * 1024 * 1024,
  });

export interface RepositoryRevision {
  kind: "git" | "unversioned";
  /** Stable public binding used by Ask history and every returned source. */
  revision: string;
  /** Full Git object id, or null when Git/HEAD is unavailable. */
  head: string | null;
  /** True for a Git worktree with changes and for an unversioned workspace. */
  dirty: boolean;
  /** Full sha256 worktree/corpus fingerprint when the revision is not a clean HEAD. */
  dirtyFingerprint: string | null;
}

export interface RepositorySource {
  sourceId: string;
  path: string;
  startLine: number;
  endLine: number;
  excerpt: string;
  /** sha256 of the complete file bytes from which the excerpt was taken. */
  sha256: string;
  revision: string;
}

export interface RepositoryContextPack {
  revision: string;
  dirty: boolean;
  repositoryRevision: RepositoryRevision;
  sources: RepositorySource[];
  truncated: boolean;
  stats: {
    filesVisited: number;
    textFilesRead: number;
    bytesRead: number;
    sourceBytes: number;
  };
}

export interface RepositoryRetrievalRequest {
  /** The root loaded from the registered project record by the caller. */
  projectRoot: string;
  /** Untrusted text used only for in-memory relevance scoring. */
  question: string;
  /** Previous Ask revision; a different current revision is rejected. */
  expectedRevision?: string | null;
  /** Validated DeepWiki index for this exact immutable snapshot. */
  knowledge?: TrustedProjectKnowledge;
  signal?: AbortSignal;
  limits?: Partial<RepositoryRetrievalLimits>;
}

export interface RepositoryRevisionRequest {
  projectRoot: string;
  signal?: AbortSignal;
  limits?: Partial<RepositoryRetrievalLimits>;
}

export class RepositoryRetrievalError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "RepositoryRetrievalError";
  }
}

export class RepositoryAccessError extends RepositoryRetrievalError {
  constructor(
    message = "无法安全读取已登记项目的源码",
    code = "ASK_REPOSITORY_UNAVAILABLE",
    statusCode = 422,
  ) {
    super(message, statusCode, code, statusCode >= 500);
    this.name = "RepositoryAccessError";
  }
}

export class RepositoryRevisionMismatchError extends RepositoryRetrievalError {
  constructor(message = "项目 revision 已变化，请基于当前源码重新提问") {
    super(message, 409, "ASK_REVISION_MISMATCH", true);
    this.name = "RepositoryRevisionMismatchError";
  }
}

export class RepositoryKnowledgeMismatchError extends RepositoryRetrievalError {
  constructor(message = "DeepWiki 项目知识与本轮源码证据不一致") {
    super(message, 409, "ASK_KNOWLEDGE_MISMATCH", true);
    this.name = "RepositoryKnowledgeMismatchError";
  }
}

export class RepositoryRetrievalAbortedError extends RepositoryRetrievalError {
  constructor() {
    super("项目问答已取消", 499, "ASK_ABORTED", true);
    this.name = "RepositoryRetrievalAbortedError";
  }
}
