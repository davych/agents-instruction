import assert from "node:assert/strict";
import test from "node:test";

import type {
  AskProviderId,
  DeepWikiGenerationDto,
  KnowledgeSummaryDto,
} from "@ai-sdlc/contracts";

import type { PgWorkflowStore } from "../src/db/store.ts";
import { AppError } from "../src/domain/errors.ts";
import {
  DeepWikiGenerationService,
} from "../src/services/agent/deepwiki-generation-service.ts";
import type {
  RepositoryContextPack,
  RepositoryRetriever,
  RepositoryRevisionRequest,
  RepositoryRetrievalRequest,
  RepositorySource,
} from "../src/services/ask/repository-retriever.ts";
import type {
  ProjectKnowledgeResolverLike,
  TrustedProjectKnowledge,
} from "../src/services/project-knowledge.ts";
import type { AskProviderRegistry } from "../src/services/llm/provider-registry.ts";
import {
  AskProviderError,
  type AskLlmCompleteRequest,
  type AskLlmCompleteResponse,
} from "../src/services/llm/types.ts";

const projectId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const generationId = "33333333-3333-4333-8333-333333333333";
const revision = "a".repeat(40);
const corpusRevision = `git:${revision}:clean:corpus:${"b".repeat(32)}`;
const now = "2026-08-28T12:00:00.000Z";
const manifestHash = "c".repeat(64);

test("DeepWiki queues a cloud job, bounds LM Studio input, and publishes compact verified citations", async () => {
  const gate = deferred<void>();
  const fixture = deepWikiFixture({
    sources: repositorySources(6, 4_000),
    complete: async () => {
      await gate.promise;
      return successfulCompletion();
    },
  });

  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    fixture.service.generate(projectId, request(), cancelled.signal),
    (error: unknown) => error instanceof AppError && error.code === "DEEPWIKI_CANCELLED",
  );
  assert.equal(fixture.storeState.createInputs.length, 0, "a cancelled browser request cannot queue work");

  const browser = new AbortController();
  const queued = await fixture.service.generate(projectId, request(), browser.signal);
  assert.equal(queued.status, "queued", "HTTP work returns before the Provider finishes");
  assert.equal(queued.promptVersion, "deepwiki-v2");
  assert.equal(fixture.storeState.claims, 1);
  assert.equal(fixture.storeState.completedInputs.length, 0);

  // Once queued, closing the browser must not cancel the cloud worker.
  browser.abort();
  gate.resolve();
  await fixture.service.waitForIdle();

  assert.equal(fixture.storeState.current?.status, "ready");
  assert.equal(fixture.providerCalls.length, 1);
  const providerCall = fixture.providerCalls[0]!;
  assert.equal(providerCall.providerId, "lmstudio");
  assert.equal(providerCall.signal, undefined, "the detached worker cannot retain the browser signal");
  assert.equal(providerCall.request.timeoutMs, 180_000);
  assert.equal(providerCall.request.maxOutputTokens, 1_024);
  assert.equal(providerCall.request.temperature, 0.2);
  assert.equal(providerCall.request.jsonSchema, undefined);
  assert.match(providerCall.request.systemPrompt, /不输出 JSON/u);
  assert.ok(providerCall.request.messages[0]!.content.length <= 8_000);

  const expectedLimits = {
    maxSources: 6,
    maxContextBytes: 12 * 1024,
    maxExcerptBytes: 2 * 1024,
    maxExcerptLines: 80,
  };
  assert.deepEqual(fixture.captureCalls[0]?.limits, expectedLimits);
  assert.deepEqual(fixture.retrieveCalls[0]?.limits, expectedLimits);
  assert.equal(fixture.knowledgeCalls[0]?.signal, undefined);
  assert.equal(fixture.captureCalls[0]?.signal, undefined);
  assert.equal(fixture.retrieveCalls[0]?.signal, undefined);

  const sourcePathFilter = fixture.retrieveCalls[0]?.sourcePathFilter;
  assert.equal(typeof sourcePathFilter, "function");
  assert.equal(sourcePathFilter!("assets/hero.svg"), false);
  assert.equal(sourcePathFilter!("dist/app.js.map"), false);
  assert.equal(sourcePathFilter!("package-lock.json"), false);
  assert.equal(sourcePathFilter!("public/app.min.js"), false);
  assert.equal(sourcePathFilter!("src/main.ts"), true);

  const prompt = jsonRecord(JSON.parse(providerCall.request.messages[0]!.content));
  const promptSources = jsonArray(prompt.sources).map(jsonRecord);
  const compactSourceIds = promptSources.map(({ sourceId }) => sourceId);
  assert.deepEqual(compactSourceIds, ["S1", "S2", "S3", "S4", "S5", "S6"]);
  assert.equal(prompt.repositoryEvidenceTruncated, true);

  const completed = fixture.storeState.completedInputs[0]!;
  assert.equal(completed.model, "openai/gpt-oss-20b");
  assert.match(completed.content, /^# 测试项目/mu);
  assert.match(completed.content, /- 核心模块负责主要业务逻辑。 \[S1\]/u);
  assert.match(completed.content, /`README\.md:1-/u);
  assert.deepEqual(completed.citations.map(({ path }) => path), ["README.md", "src/main.ts"]);
  assert.ok(completed.citations.every(({ sha256 }) => sha256 === "d".repeat(64)));
  assert.ok(completed.citations.every(({ startLine, endLine }) => endLine >= startLine));
});

test("DeepWiki automatically retries one malformed local-model Markdown answer", async () => {
  let calls = 0;
  const fixture = deepWikiFixture({
    sources: repositorySources(2, 400),
    complete: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          text: "<|channel|>final <|constrain|>JSON<|message|>{broken",
          model: "openai/gpt-oss-20b",
          usage: { inputTokens: 100, outputTokens: 40 },
        };
      }
      return successfulCompletion();
    },
  });

  const queued = await fixture.service.generate(projectId, request());
  assert.equal(queued.status, "queued");
  await fixture.service.waitForIdle();

  assert.equal(fixture.storeState.current?.status, "ready");
  assert.equal(fixture.providerCalls.length, 2);
  const repair = fixture.providerCalls[1]!;
  assert.equal(repair.request.reasoningEffort, "low");
  assert.equal(repair.request.temperature, 0.1);
  assert.equal(repair.request.timeoutMs, 90_000);
  assert.equal(repair.request.jsonSchema, undefined);
  assert.match(repair.request.systemPrompt, /上一轮答案没有通过/u);
  assert.deepEqual(fixture.storeState.completedInputs[0]?.usage, {
    inputTokens: 900,
    outputTokens: 340,
  });
});

test("DeepWiki keeps a compact strict JSON contract for OpenAI", async () => {
  const fixture = deepWikiFixture({
    sources: repositorySources(2, 400),
    complete: async () => successfulStructuredCompletion(),
  });

  const queued = await fixture.service.generate(projectId, request("openai"));
  assert.equal(queued.status, "queued");
  await fixture.service.waitForIdle();

  assert.equal(fixture.storeState.current?.status, "ready");
  const providerCall = fixture.providerCalls[0]!;
  assert.equal(providerCall.providerId, "openai");
  const jsonSchema = jsonRecord(providerCall.request.jsonSchema);
  assert.doesNotMatch(JSON.stringify(jsonSchema), /"pattern"/u);
  const properties = jsonRecord(jsonSchema.properties);
  const evidence = jsonRecord(properties.evidence);
  const evidenceItems = jsonRecord(evidence.items);
  const evidenceProperties = jsonRecord(evidenceItems.properties);
  assert.deepEqual(jsonRecord(evidenceProperties.sourceId).enum, ["S1", "S2"]);
  assert.equal(jsonRecord(jsonRecord(properties.modules).items).type, "string");
});

test("DeepWiki persists a safe actionable LM Studio context error without upstream data", async () => {
  const fixture = deepWikiFixture({
    sources: repositorySources(2, 400),
    complete: async () => {
      const error = new AskProviderError(
        "lmstudio",
        "ASK_PROVIDER_REQUEST_REJECTED",
        "raw upstream body: TOP-SECRET-MARKER",
        "protocol_error",
        502,
        false,
        500,
      );
      Object.assign(error, { upstreamBody: "TOP-SECRET-UPSTREAM-BODY" });
      throw error;
    },
  });

  const queued = await fixture.service.generate(projectId, request());
  assert.equal(queued.status, "queued");
  await fixture.service.waitForIdle();

  assert.equal(fixture.storeState.current?.status, "failed");
  assert.equal(fixture.storeState.failedMessages.length, 1);
  const message = fixture.storeState.failedMessages[0]!;
  assert.match(message, /LM Studio/u);
  assert.match(message, /上下文不足/u);
  assert.doesNotMatch(message, /TOP-SECRET|raw upstream|upstream body/iu);
});

test("DeepWiki fails readably without spending Provider tokens when no text evidence exists", async () => {
  const fixture = deepWikiFixture({
    sources: [],
    complete: async () => successfulCompletion(),
  });

  const queued = await fixture.service.generate(projectId, request());
  assert.equal(queued.status, "queued");
  await fixture.service.waitForIdle();

  assert.equal(fixture.providerCalls.length, 0);
  assert.equal(fixture.storeState.current?.status, "failed");
  assert.match(fixture.storeState.failedMessages[0] ?? "", /没有足够的可读文本证据/u);
  assert.equal(fixture.storeState.claims, 1);
  assert.deepEqual(fixture.storeState.transitions, []);
});

test("DeepWiki idempotency replay that loses the database claim never runs or fails the winner", async () => {
  const fixture = deepWikiFixture({
    sources: repositorySources(2, 400),
    claimWinner: false,
    complete: async () => successfulCompletion(),
  });

  const replay = await fixture.service.generate(projectId, request());

  assert.equal(replay.status, "scanning");
  assert.equal(fixture.storeState.claims, 1);
  assert.equal(fixture.providerCalls.length, 0);
  assert.equal(fixture.storeState.failedMessages.length, 0);
  await fixture.service.waitForIdle();
});

function deepWikiFixture(input: {
  sources: RepositorySource[];
  claimWinner?: boolean;
  complete: (
    request: AskLlmCompleteRequest,
    signal?: AbortSignal,
  ) => Promise<AskLlmCompleteResponse>;
}) {
  const storeState = fakeStore(input.claimWinner ?? true);
  const providerCalls: Array<{
    providerId: AskProviderId;
    request: AskLlmCompleteRequest;
    signal?: AbortSignal;
  }> = [];
  const providers = {
    runWithProvider<T>(_providerId: AskProviderId, operation: () => T): T {
      return operation();
    },
    status(providerId: AskProviderId) {
      return {
        id: providerId,
        label: "LM Studio",
        configured: true,
        model: "openai/gpt-oss-20b",
        protocol: "openai-chat" as const,
        dataBoundary: "local" as const,
        endpointLabel: "127.0.0.1:1234",
        capabilities: { streaming: false, structuredOutput: true, toolCalling: false },
        message: "已配置",
      };
    },
    async complete(
      providerId: AskProviderId,
      completeRequest: AskLlmCompleteRequest,
      signal?: AbortSignal,
    ) {
      providerCalls.push({ providerId, request: completeRequest, signal });
      return input.complete(completeRequest, signal);
    },
  } as unknown as AskProviderRegistry;

  const captureCalls: RepositoryRevisionRequest[] = [];
  const retrieveCalls: RepositoryRetrievalRequest[] = [];
  const retriever = {
    async captureRevision(captureInput: RepositoryRevisionRequest) {
      captureCalls.push(captureInput);
      return repositoryRevision();
    },
    async retrieve(retrieveInput: RepositoryRetrievalRequest) {
      retrieveCalls.push(retrieveInput);
      return repositoryContext(input.sources);
    },
  } as unknown as RepositoryRetriever;

  const knowledgeCalls: Array<Parameters<ProjectKnowledgeResolverLike["resolve"]>[0]> = [];
  const knowledge = {
    async resolve(resolveInput: Parameters<ProjectKnowledgeResolverLike["resolve"]>[0]) {
      knowledgeCalls.push(resolveInput);
      return trustedKnowledge();
    },
  } satisfies ProjectKnowledgeResolverLike;

  return {
    service: new DeepWikiGenerationService(
      storeState.store,
      providers,
      knowledge,
      retriever,
    ),
    storeState,
    providerCalls,
    captureCalls,
    retrieveCalls,
    knowledgeCalls,
  };
}

function fakeStore(claimWinner: boolean) {
  type CreateInput = Parameters<PgWorkflowStore["createDeepWikiGeneration"]>[0];
  type TransitionInput = Parameters<PgWorkflowStore["transitionDeepWikiGeneration"]>[0];
  type CompleteInput = Parameters<PgWorkflowStore["completeDeepWikiGeneration"]>[0];

  const createInputs: CreateInput[] = [];
  const transitions: TransitionInput[] = [];
  const completedInputs: CompleteInput[] = [];
  const failedMessages: string[] = [];
  let claims = 0;
  let current: DeepWikiGenerationDto | null = null;

  const store = {
    async getProjectAgentSettings() {
      return {
        projectId,
        repoAlias: "repo",
        defaultProviderId: "lmstudio" as const,
        sandboxBlueprintId: "default",
        sandboxBlueprintVersion: "1",
        enabledMcpServerIds: [],
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
    },
    async getProject() {
      return {
        id: projectId,
        sourceKind: "remote-git" as const,
        repositoryState: "ready" as const,
        currentRevision: revision,
      };
    },
    async getActiveProjectWorkspace() {
      return {
        id: workspaceId,
        projectId,
        purpose: "project_snapshot" as const,
        rootPath: "/srv/cloud/project",
        state: "ready" as const,
        revision,
        active: true,
        generation: 1,
        errorMessage: null,
        expiresAt: null,
        createdAt: now,
        updatedAt: now,
      };
    },
    async createDeepWikiGeneration(createInput: CreateInput) {
      createInputs.push(createInput);
      current = generation("queued");
      return structuredClone(current);
    },
    async claimDeepWikiGeneration() {
      claims += 1;
      if (current?.status !== "queued") return null;
      current = {
        ...current,
        status: "scanning",
        updatedAt: now,
      };
      return claimWinner ? structuredClone(current) : null;
    },
    async transitionDeepWikiGeneration(transitionInput: TransitionInput) {
      transitions.push(transitionInput);
      assert.equal(current?.status, transitionInput.expectedStatus);
      current = {
        ...requireGeneration(current),
        status: transitionInput.status,
        updatedAt: now,
      };
      return structuredClone(current);
    },
    async completeDeepWikiGeneration(completeInput: CompleteInput) {
      completedInputs.push(completeInput);
      current = {
        ...requireGeneration(current),
        status: "ready",
        model: completeInput.model,
        manifestHash: completeInput.manifestHash ?? manifestHash,
        content: completeInput.content,
        citations: completeInput.citations,
        usage: completeInput.usage,
        errorMessage: null,
        generatedAt: now,
        staleAt: null,
        updatedAt: now,
      };
      return structuredClone(current);
    },
    async failDeepWikiGeneration(_id: string, message: string) {
      failedMessages.push(message);
      current = {
        ...requireGeneration(current),
        status: "failed",
        model: null,
        manifestHash: null,
        content: null,
        citations: [],
        usage: { inputTokens: null, outputTokens: null },
        errorMessage: message,
        generatedAt: now,
        staleAt: null,
        updatedAt: now,
      };
      return structuredClone(current);
    },
    async getLatestDeepWikiGeneration() {
      return current ? structuredClone(current) : null;
    },
    async getDeepWikiGeneration() {
      return structuredClone(requireGeneration(current));
    },
  } as unknown as PgWorkflowStore;

  return {
    store,
    createInputs,
    transitions,
    completedInputs,
    failedMessages,
    get claims() {
      return claims;
    },
    get current() {
      return current;
    },
  };
}

function generation(status: DeepWikiGenerationDto["status"]): DeepWikiGenerationDto {
  return {
    id: generationId,
    projectId,
    revision,
    providerId: "lmstudio",
    model: null,
    promptVersion: "deepwiki-v2",
    status,
    manifestHash: null,
    content: null,
    citations: [],
    usage: { inputTokens: null, outputTokens: null },
    errorMessage: null,
    generatedAt: null,
    staleAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function requireGeneration(
  value: DeepWikiGenerationDto | null,
): DeepWikiGenerationDto {
  assert.ok(value, "the generation must be queued before the worker updates it");
  return value;
}

function repositoryRevision() {
  return {
    kind: "git" as const,
    revision: corpusRevision,
    head: revision,
    dirty: false,
    dirtyFingerprint: null,
  };
}

function repositoryContext(sources: RepositorySource[]): RepositoryContextPack {
  return {
    revision: corpusRevision,
    dirty: false,
    repositoryRevision: repositoryRevision(),
    sources,
    truncated: false,
    stats: {
      filesVisited: sources.length,
      textFilesRead: sources.length,
      bytesRead: sources.reduce((total, source) => total + source.excerpt.length, 0),
      sourceBytes: 12 * 1024,
    },
  };
}

function repositorySources(count: number, excerptCharacters: number): RepositorySource[] {
  const paths = [
    "README.md",
    "src/main.ts",
    "package.json",
    "src/core.ts",
    "tests/main.test.ts",
    "docs/architecture.md",
  ];
  return Array.from({ length: count }, (_, index) => ({
    sourceId: `S${10_000 + index}`,
    path: paths[index] ?? `src/module-${index}.ts`,
    startLine: 1,
    endLine: 200,
    excerpt: `${paths[index] ?? "module"}\n${"implementation detail ".repeat(excerptCharacters)}`
      .slice(0, excerptCharacters),
    sha256: "d".repeat(64),
    revision: corpusRevision,
  }));
}

function trustedKnowledge(): TrustedProjectKnowledge {
  const summary: KnowledgeSummaryDto = {
    fileCount: 6,
    totalBytes: 24_000,
    languages: [{ language: "TypeScript", files: 4, bytes: 18_000 }],
    entryPoints: [{ path: "src/main.ts", kind: "entry", summary: "应用入口" }],
    documents: [{ path: "README.md", kind: "document", summary: "项目说明" }],
    tests: [{ path: "tests/main.test.ts", kind: "test", summary: "主测试" }],
    builds: [{ path: "package.json", kind: "build", summary: "构建脚本" }],
    keyPaths: [{ path: "src/core.ts", kind: "key-path", summary: "核心实现" }],
    truncated: false,
  };
  return {
    version: 1,
    revision,
    manifestHash,
    summary,
    files: repositorySources(6, 10).map((source) => ({
      path: source.path,
      bytes: source.excerpt.length,
      sha256: source.sha256,
      language: source.path.endsWith(".ts") ? "TypeScript" : "Other",
      tags: [],
    })),
    indexedAt: now,
  };
}

function successfulCompletion(): AskLlmCompleteResponse {
  return {
    text: `# 测试项目

## 项目概览

这是一个用于验证 DeepWiki 的项目。 [S1]

## 架构与边界

入口调用核心模块，测试覆盖主要路径。 [S2]

## 主要模块

- 核心模块负责主要业务逻辑。 [S1]

## 开发与启动

安装依赖后运行开发命令。 [S2]

## 测试

运行测试脚本。 [S2]

## 风险

- 当前证据未说明生产环境配置或是否使用 Amazon S3。

## 仍需确认

- task.js 的实现与功能。`,
    model: "openai/gpt-oss-20b",
    usage: { inputTokens: 800, outputTokens: 300 },
  };
}

function successfulStructuredCompletion(): AskLlmCompleteResponse {
  return {
    text: JSON.stringify({
      title: "测试项目",
      overview: "这是一个用于验证 DeepWiki 的项目。 [S1]",
      architecture: "入口调用核心模块，测试覆盖主要路径。 [S2]",
      modules: ["核心模块负责主要业务逻辑。 [S1]"],
      development: "安装依赖后运行开发命令。 [S2]",
      testing: "运行测试脚本。 [S2]",
      risks: ["当前证据未说明生产环境配置。"],
      unknowns: [],
      evidence: [
        { sourceId: "S1", summary: "README 说明了项目目标。" },
        { sourceId: "S2", summary: "源码包含应用入口。" },
      ],
    }),
    model: "gpt-5-mini",
    usage: { inputTokens: 800, outputTokens: 300 },
  };
}

function request(providerId: AskProviderId = "lmstudio") {
  return { expectedRevision: revision, providerId };
}

function jsonRecord(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function jsonArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
