import {
  readOnlyRepositoryContextsSchema,
  safeRepositoryRelativePathSchema,
  type AgentSessionRepositoryDto,
  type ReadOnlyRepositoryContextDto,
} from "@ai-sdlc/contracts";

import type { PgWorkflowStore } from "../../db/store.js";
import { AppError } from "../../domain/errors.js";
import type {
  ProjectKnowledgeResolverLike,
  TrustedProjectKnowledge,
} from "../project-knowledge.js";
import { redactLikelySecrets } from "./rooted-agent-tool-host.js";

export const MAX_READ_ONLY_REPOSITORIES_PER_TURN = 4;
export const MAX_READ_ONLY_REPOSITORY_SUMMARY_CHARACTERS = 6_000;
export const MAX_READ_ONLY_REPOSITORY_TOTAL_CHARACTERS = 24_000;
export const MAX_READ_ONLY_SIGNAL_PATHS_PER_KIND = 12;
export const MAX_READ_ONLY_SIGNAL_PATH_CHARACTERS = 512;

const signalKinds = [
  "entryPoints",
  "documents",
  "tests",
  "builds",
  "keyPaths",
] as const;

type ReadOnlyRepositoryContextStore = Pick<
  PgWorkflowStore,
  "getKnowledgeWorkspaceByRevision"
>;

export interface ReadOnlyRepositoryContextResolverLike {
  resolve(input: {
    repositories: readonly AgentSessionRepositoryDto[];
    mentionedAliases: readonly string[];
    signal?: AbortSignal;
  }): Promise<ReadOnlyRepositoryContextDto[]>;
}

/**
 * Resolves only explicitly mentioned read bindings into immutable, aggregate
 * repository metadata. Workspace roots are used solely inside the trusted API
 * and are never returned. No source body or model-generated DeepWiki is copied
 * into this context.
 */
export class ReadOnlyRepositoryContextResolver implements ReadOnlyRepositoryContextResolverLike {
  constructor(
    private readonly store: ReadOnlyRepositoryContextStore,
    private readonly knowledge: ProjectKnowledgeResolverLike,
  ) {}

  async resolve(input: {
    repositories: readonly AgentSessionRepositoryDto[];
    mentionedAliases: readonly string[];
    signal?: AbortSignal;
  }): Promise<ReadOnlyRepositoryContextDto[]> {
    const mentioned = new Set(input.mentionedAliases);
    const references = input.repositories.filter((repository) => (
      repository.accessMode === "read" && mentioned.has(repository.repoAlias)
    ));
    if (references.length > MAX_READ_ONLY_REPOSITORIES_PER_TURN) {
      throw new AppError(
        `一条消息最多引用 ${MAX_READ_ONLY_REPOSITORIES_PER_TURN} 个只读 @repo，请缩小范围`,
        422,
        "AGENT_READ_ONLY_REPOSITORY_LIMIT",
      );
    }

    const contexts: ReadOnlyRepositoryContextDto[] = [];
    for (const reference of references) {
      if (input.signal?.aborted) {
        throw new AppError("只读仓库上下文解析已取消", 499, "AGENT_READ_ONLY_REPOSITORY_CANCELLED");
      }
      const workspace = await this.store.getKnowledgeWorkspaceByRevision(
        reference.projectId,
        reference.sourceRevision,
      );
      if (
        !workspace
        || workspace.state !== "ready"
        || workspace.revision !== reference.sourceRevision
      ) {
        throw new AppError(
          `@${reference.repoAlias} 的固定知识快照不可用，请重新同步该仓库`,
          409,
          "AGENT_READ_ONLY_REPOSITORY_KNOWLEDGE_UNAVAILABLE",
        );
      }
      const trusted = await this.knowledge.resolve({
        projectId: reference.projectId,
        revision: reference.sourceRevision,
        workspaceRoot: workspace.rootPath,
        signal: input.signal,
      });
      if (trusted.revision !== reference.sourceRevision) {
        throw new AppError(
          `@${reference.repoAlias} 的知识 revision 与会话绑定不一致，请重新同步该仓库`,
          409,
          "AGENT_READ_ONLY_REPOSITORY_REVISION_MISMATCH",
        );
      }
      contexts.push({
        repoAlias: reference.repoAlias,
        sourceRevision: reference.sourceRevision,
        manifestHash: trusted.manifestHash,
        summary: summarizeReadOnlyRepositoryKnowledge(trusted),
      });
    }
    return readOnlyRepositoryContextsSchema.parse(contexts);
  }
}

/**
 * Keep the cross-repository prompt useful without exposing file bodies. The
 * only file names included are bounded, validated repository-relative signal
 * paths from the verified Git manifest; signal prose is deliberately omitted.
 */
export function summarizeReadOnlyRepositoryKnowledge(
  knowledge: TrustedProjectKnowledge,
): string {
  const languages = knowledge.summary.languages.slice(0, 16).map((language) => ({
    language: language.language,
    files: language.files,
    bytes: language.bytes,
  }));
  const signalPaths = {
    entryPoints: [] as string[],
    documents: [] as string[],
    tests: [] as string[],
    builds: [] as string[],
    keyPaths: [] as string[],
  };
  const candidates = Object.fromEntries(signalKinds.map((kind) => [
    kind,
    knowledge.summary[kind].map(({ path }) => {
      const parsed = safeRepositoryRelativePathSchema.safeParse(path);
      if (!parsed.success) {
        throw new AppError(
          "只读仓库 Manifest 含不安全路径，未发送给模型",
          409,
          "AGENT_READ_ONLY_REPOSITORY_PATH_UNSAFE",
        );
      }
      return parsed.data;
    }),
  ])) as Record<(typeof signalKinds)[number], string[]>;
  let signalPathsTruncated = signalKinds.some(
    (kind) => candidates[kind].length > MAX_READ_ONLY_SIGNAL_PATHS_PER_KIND,
  );
  const aggregate = {
    fileCount: knowledge.summary.fileCount,
    totalBytes: knowledge.summary.totalBytes,
    languages,
    signalCounts: {
      entryPoints: knowledge.summary.entryPoints.length,
      documents: knowledge.summary.documents.length,
      tests: knowledge.summary.tests.length,
      builds: knowledge.summary.builds.length,
      keyPaths: knowledge.summary.keyPaths.length,
    },
    signalPaths,
    signalPathsTruncated,
    truncated: knowledge.summary.truncated,
  };
  for (let index = 0; index < MAX_READ_ONLY_SIGNAL_PATHS_PER_KIND; index += 1) {
    for (const kind of signalKinds) {
      const candidate = candidates[kind][index];
      if (!candidate) continue;
      if (candidate.length > MAX_READ_ONLY_SIGNAL_PATH_CHARACTERS) {
        signalPathsTruncated = true;
        aggregate.signalPathsTruncated = true;
        continue;
      }
      signalPaths[kind].push(candidate);
      if (JSON.stringify(aggregate).length > MAX_READ_ONLY_REPOSITORY_SUMMARY_CHARACTERS) {
        signalPaths[kind].pop();
        signalPathsTruncated = true;
        aggregate.signalPathsTruncated = true;
      }
    }
  }
  const redacted = redactLikelySecrets(JSON.stringify(aggregate));
  if (redacted.text.length > MAX_READ_ONLY_REPOSITORY_SUMMARY_CHARACTERS) {
    throw new AppError(
      "只读仓库 Manifest 摘要超过平台上限",
      413,
      "AGENT_READ_ONLY_REPOSITORY_SUMMARY_LIMIT",
    );
  }
  return redacted.text;
}
