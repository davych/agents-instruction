import { constants as fsConstants, type Dirent } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import path from "node:path";

import { safeRepositoryRelativePathSchema } from "@ai-sdlc/contracts";
import { z } from "zod";

import { assessDeferredDesignValidations } from "../../domain/design-deferred-validation.js";
import { AppError } from "../../domain/errors.js";
import {
  renderUserStoriesBlocker,
  USER_STORIES_BLOCKER_SENTINEL,
} from "../../domain/user-story-quality.js";
import type {
  AskLlmFunctionTool,
  AskLlmToolCall,
} from "../llm/types.js";
import { isWithin } from "../project-paths.js";

const MAX_SOURCE_FILE_BYTES = 512 * 1_024;
const MAX_WRITE_BYTES = 192 * 1_024;
const MAX_TOOL_OUTPUT_CHARACTERS = 48_000;
const MAX_SEARCHED_FILES = 600;
const MAX_SEARCHED_BYTES = 4 * 1_024 * 1_024;
const SKIPPED_DIRECTORY_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".aws",
  ".azure",
  ".docker",
  ".kube",
  ".ssh",
  "node_modules",
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "build",
  "target",
]);

const listFilesArgumentsSchema = z.object({
  path: z.string().trim().min(1).max(4_096),
  maxDepth: z.number().int().min(1).max(8),
  maxEntries: z.number().int().min(1).max(500),
}).strict();

const readFileArgumentsSchema = z.object({
  path: safeRepositoryRelativePathSchema,
  startLine: z.number().int().min(1).max(100_000),
  endLine: z.number().int().min(1).max(100_000),
}).strict().refine(({ startLine, endLine }) => endLine >= startLine, {
  message: "endLine 不能小于 startLine",
});

const searchTextArgumentsSchema = z.object({
  path: z.string().trim().min(1).max(4_096),
  query: z.string().min(1).max(300),
  // Keep these fields required in the advertised strict function schema for
  // Providers that enforce it. Some local models still omit nonessential
  // controls, so the runtime applies conservative read-only defaults.
  caseSensitive: z.boolean().default(false),
  maxResults: z.number().int().min(1).max(200).default(50),
}).strict();

const writeFileArgumentsSchema = z.object({
  path: safeRepositoryRelativePathSchema,
  content: z.string().max(MAX_WRITE_BYTES),
  overwrite: z.boolean(),
}).strict();

const applyPatchArgumentsSchema = z.object({
  path: safeRepositoryRelativePathSchema,
  oldText: z.string().min(1).max(96_000),
  newText: z.string().max(96_000),
  replaceAll: z.boolean(),
}).strict();

const createDirectoryArgumentsSchema = z.object({
  path: safeRepositoryRelativePathSchema,
}).strict();

const runCheckArgumentsSchema = z.object({
  checkId: z.string().trim().min(1).max(80)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
}).strict();

const blockerNarrativeItemSchema = z.string().trim().min(6).max(800);
const blockerHumanOwnerSchema = z.string().trim().min(2).max(800);
const blockerNarrativeItemsSchema = z.array(blockerNarrativeItemSchema).min(1).max(20);
const userStoriesBlockerArgumentsSchema = z.object({
  status: z.enum(["Blocked", "Pending"]),
  missingFacts: blockerNarrativeItemsSchema.optional(),
  openQuestions: blockerNarrativeItemsSchema.optional(),
  // Runtime-only compatibility for calls produced against the pre-batch tool
  // contract. New Provider schemas expose arrays and never advertise these.
  missingFact: blockerNarrativeItemSchema.optional(),
  openQuestion: blockerNarrativeItemSchema.optional(),
  humanOwner: blockerHumanOwnerSchema,
  nextStep: blockerNarrativeItemSchema,
}).strict().superRefine((value, context) => {
  const missingFacts = value.missingFacts ?? (value.missingFact ? [value.missingFact] : []);
  const openQuestions = value.openQuestions ?? (value.openQuestion ? [value.openQuestion] : []);
  if (missingFacts.length === 0 || (value.missingFacts && value.missingFact)) {
    context.addIssue({ code: "custom", path: ["missingFacts"], message: "missingFacts 必须提供 1-20 项" });
  }
  if (openQuestions.length === 0 || (value.openQuestions && value.openQuestion)) {
    context.addIssue({ code: "custom", path: ["openQuestions"], message: "openQuestions 必须提供 1-20 项" });
  }
  if ([...missingFacts, ...openQuestions].reduce((total, item) => total + item.length, 0) > 8_000) {
    context.addIssue({ code: "custom", path: ["missingFacts"], message: "Blocker 决定内容总长度不能超过 8000 字符" });
  }
}).transform((value) => ({
  status: value.status,
  missingFacts: value.missingFacts ?? [value.missingFact!],
  openQuestions: value.openQuestions ?? [value.openQuestion!],
  humanOwner: value.humanOwner,
  nextStep: value.nextStep,
}));

const designSpecTextSchema = z.string().trim().min(6).max(4_000)
  .refine((value) => !/(?:<[^>\n]+>|\{\{[^}\n]+\}\}|\b(?:TBD|TODO|placeholder)\b)/iu.test(value), {
    message: "不能包含模板占位符",
  });
const designSpecShortTextSchema = z.string().trim().min(2).max(800)
  .refine((value) => !/(?:<[^>\n]+>|\{\{[^}\n]+\}\}|\b(?:TBD|TODO|placeholder)\b)/iu.test(value), {
    message: "不能包含模板占位符",
  });
const designSpecListSchema = z.array(designSpecTextSchema).max(20);
const designSpecBlockerSchema = z.object({
  id: z.string().trim().min(3).max(80).regex(/^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+$/u),
  decision: designSpecTextSchema,
  owner: designSpecShortTextSchema,
  nextAction: designSpecTextSchema,
}).strict();
const designSpecDeferredValidationSchema = z.object({
  id: z.string().trim().min(3).max(80).regex(/^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+$/u),
  owner: z.literal("tester"),
  phase: z.literal("verification"),
  prerequisite: designSpecTextSchema,
  targets: z.array(designSpecShortTextSchema).min(1).max(20),
  checks: z.array(designSpecTextSchema).min(1).max(20),
  passCriteria: designSpecTextSchema,
  evidenceRequired: designSpecTextSchema,
  evidenceTypes: z.array(z.enum([
    "browser-run",
    "screenshot",
    "keyboard-log",
    "accessibility-report",
    "contrast-report",
    "motion-evidence",
  ])).min(1).max(6),
  status: z.literal("deferred"),
  releaseImpact: designSpecTextSchema,
  onFail: z.literal("block_verification"),
  onMissing: z.literal("block_verification"),
}).strict();
const designSpecArgumentsSchema = z.object({
  status: z.enum(["blocked", "ready-for-engineering"]),
  framework: designSpecShortTextSchema,
  screens: z.array(z.object({
    id: z.string().trim().min(2).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
    layout: designSpecTextSchema,
    states: z.array(designSpecShortTextSchema).min(1).max(20),
  }).strict()).min(1).max(20),
  acceptanceCriteria: z.array(z.object({
    id: z.string().trim().min(3).max(80).regex(/^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+$/u),
    requirement: designSpecTextSchema,
    designResponse: designSpecTextSchema,
  }).strict()).min(1).max(50),
  openQuestions: designSpecListSchema,
  blockers: z.array(designSpecBlockerSchema).max(20),
  deferredValidations: z.array(designSpecDeferredValidationSchema).max(20),
  designSummary: designSpecTextSchema,
  responsiveBehavior: designSpecTextSchema,
  accessibilityAndContent: designSpecTextSchema,
  validationEvidence: designSpecTextSchema,
  behaviorToPreserve: designSpecListSchema.min(1),
  allowedDesignFlexibility: designSpecListSchema.min(1),
}).strict().superRefine((value, context) => {
  if (value.status === "ready-for-engineering" && value.blockers.length > 0) {
    context.addIssue({ code: "custom", path: ["blockers"], message: "ready-for-engineering 必须使用空 blockers" });
  }
  if (value.status === "blocked" && value.blockers.length === 0) {
    context.addIssue({ code: "custom", path: ["blockers"], message: "blocked 必须提供至少一个真实 blocker" });
  }
  for (const screen of value.screens) {
    if (!screen.states.includes("default")) {
      context.addIssue({ code: "custom", path: ["screens"], message: `${screen.id} 必须包含 default state` });
    }
    if (new Set(screen.states).size !== screen.states.length) {
      context.addIssue({ code: "custom", path: ["screens"], message: `${screen.id} 的 states 不能重复` });
    }
  }
  const unique = (values: readonly string[]): boolean => new Set(values.map((value) => value.toUpperCase())).size === values.length;
  if (!unique(value.screens.map(({ id }) => id))) {
    context.addIssue({ code: "custom", path: ["screens"], message: "screen id 必须唯一" });
  }
  if (!unique(value.acceptanceCriteria.map(({ id }) => id))) {
    context.addIssue({ code: "custom", path: ["acceptanceCriteria"], message: "acceptance criterion id 必须唯一" });
  }
  const blockerIds = value.blockers.map(({ id }) => id);
  const deferredIds = value.deferredValidations.map(({ id }) => id);
  if (!unique(deferredIds) || deferredIds.some((id) => blockerIds.some((blockerId) => blockerId.toUpperCase() === id.toUpperCase()))) {
    context.addIssue({ code: "custom", path: ["deferredValidations"], message: "deferred validation id 必须唯一且不能同时是 blocker" });
  }
  const deferredAssessment = assessDeferredDesignValidations(value.deferredValidations);
  if (deferredAssessment.errors.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["deferredValidations"],
      message: deferredAssessment.errors.join("；"),
    });
  }
});

const architectureEvidenceRefSchema = z.string().trim().min(2).max(500)
  .refine((value) => (
    !/(?:<[^>\n]+>|\{\{[^}\n]+\}\}|\b(?:TBD|TODO|placeholder)\b)/iu.test(value)
    && !/^(?:n\/?a|none|unknown|pending|not applicable|无|未知|待定)$/iu.test(value)
  ), {
    message: "证据引用必须说明具体依据，不能使用占位符或 N/A",
  });
const architectureNarrativeSchema = z.string().trim().min(2).max(4_000)
  .refine((value) => !/(?:<[^>\n]+>|\{\{[^}\n]+\}\}|\b(?:TBD|TODO|placeholder)\b)/iu.test(value), {
    message: "架构说明不能包含模板占位符",
  });
const architectureCheckpointArgumentsSchema = z.object({
  contextSummary: architectureNarrativeSchema,
  problem: architectureNarrativeSchema,
  constraints: z.array(architectureNarrativeSchema).min(1).max(30),
  scopes: z.array(z.object({
    name: designSpecShortTextSchema,
    boundary: z.enum(["existing", "new"]),
    evidence: architectureEvidenceRefSchema,
  }).strict()).min(1).max(20),
  applicablePackIds: z.array(z.enum([
    "api", "data", "integration", "security", "observability", "frontend",
  ])).max(6),
  options: z.array(z.object({
    title: designSpecShortTextSchema,
    coreIdea: architectureNarrativeSchema,
    optimizes: architectureNarrativeSchema,
    givesUp: architectureNarrativeSchema,
    hardestConstraint: architectureNarrativeSchema,
  }).strict()).min(3).max(6),
  recommendedOptionNumber: z.number().int().min(1).max(6),
  recommendationReason: architectureNarrativeSchema,
}).strict().superRefine((value, context) => {
  if (new Set(value.applicablePackIds).size !== value.applicablePackIds.length) {
    context.addIssue({ code: "custom", path: ["applicablePackIds"], message: "适用规则包不能重复" });
  }
  if (value.recommendedOptionNumber > value.options.length) {
    context.addIssue({
      code: "custom",
      path: ["recommendedOptionNumber"],
      message: "推荐项序号不能超过实际方案数量",
    });
  }
});

const engineeringEvidencePackArgumentsSchema = z.object({
  implementationNotes: z.string().min(1).max(48_000),
  implementationPlan: z.string().min(1).max(48_000),
  implementationTasks: z.string().min(1).max(48_000),
  sessionLog: z.string().min(1).max(48_000),
  independentTestEvidence: z.string().min(1).max(48_000),
  review: z.string().min(1).max(48_000),
  provenance: z.string().min(1).max(48_000),
}).strict().superRefine((value, context) => {
  const totalCharacters = Object.values(value).reduce(
    (total, content) => total + content.length,
    0,
  );
  if (totalCharacters > 160_000) {
    context.addIssue({
      code: "custom",
      message: "工程证据包总长度不能超过 160000 字符",
    });
  }
});

interface StructuredDesignSpecTarget {
  filePath: string;
  title: string;
  sourceArtifactKeys: readonly string[];
}

interface StructuredArchitectureCheckpointTarget {
  discoveryPath: string;
  optionsPath: string;
  architecturePath: string;
  title: string;
  catalogDigest: string;
  configuredProjectMode: "auto" | "greenfield" | "brownfield" | "hybrid";
  rules: ReadonlyArray<{
    id: string;
    packId: "api" | "data" | "integration" | "security" | "observability" | "frontend";
  }>;
}

export interface StructuredEngineeringEvidenceTarget {
  implementationNotesPath: string;
  implementationPlanPath: string;
  implementationTasksPath: string;
  sessionLogPath: string;
  independentTestEvidencePath: string;
  reviewPath: string;
  provenancePath: string;
}

export type RootedAgentAccessMode = "read-only" | "sandbox-write";

export interface AgentSandboxCheckDefinition {
  id: string;
  label: string;
  timeoutMs: number;
}

export interface AgentSandboxCheckResult {
  exitCode: number;
  output: string;
  durationMs: number;
}

/**
 * This port must be implemented by a real container or microVM worker. The API
 * process intentionally has no built-in shell/process implementation: a repo's
 * test script is arbitrary code and a cwd check alone is not a sandbox.
 */
export interface AgentSandboxCheckRunner {
  readonly isolation: "container" | "microvm";
  definitions(): readonly AgentSandboxCheckDefinition[];
  run(input: {
    checkId: string;
    workspaceRoot: string;
    timeoutMs: number;
    maxOutputBytes: number;
    signal: AbortSignal;
  }): Promise<AgentSandboxCheckResult>;
}

export interface ProviderAgentToolExecution {
  summary: string;
  content: string;
  changedPaths: readonly string[];
}

export interface ProviderAgentToolHost {
  readonly accessMode: RootedAgentAccessMode;
  definitions(): readonly AskLlmFunctionTool[];
  execute(
    call: AskLlmToolCall,
    options: { signal: AbortSignal; maxOutputCharacters: number },
  ): Promise<ProviderAgentToolExecution>;
}

export class ProviderAgentToolError extends Error {
  constructor(
    readonly code: string,
    readonly safeMessage: string,
    readonly fatal = false,
  ) {
    super(safeMessage);
    this.name = "ProviderAgentToolError";
  }
}

export class RootedAgentToolHost implements ProviderAgentToolHost {
  private readonly userStoriesSentinelReadmes = new Set<string>();

  private constructor(
    private readonly rootPath: string,
    readonly accessMode: RootedAgentAccessMode,
    private readonly checkRunner?: AgentSandboxCheckRunner,
    private readonly checkDefinitions: readonly AgentSandboxCheckDefinition[] = [],
    private readonly writablePaths: readonly string[] | null = null,
    private readonly writableDirectoryPaths: readonly string[] | null = null,
    private readonly protectedWritePaths: readonly string[] = [],
    private readonly protectedWriteExceptionPaths: readonly string[] = [],
    private readonly protectedWriteExceptionDirectoryPaths: readonly string[] = [],
    private readonly userStoriesBlockerDirectory: string | null = null,
    private readonly structuredDesignSpecTarget: StructuredDesignSpecTarget | null = null,
    private readonly structuredArchitectureCheckpointTarget: StructuredArchitectureCheckpointTarget | null = null,
    private readonly structuredEngineeringEvidenceTarget: StructuredEngineeringEvidenceTarget | null = null,
  ) {}

  static async create(input: {
    rootPath: string;
    accessMode: RootedAgentAccessMode;
    checkRunner?: AgentSandboxCheckRunner;
    /**
     * Optional repository-relative write allowlist. Omitting it preserves the
     * existing whole-sandbox write behavior; providing it limits file writes
     * to these paths (and directory artifacts below them).
     */
    writablePaths?: readonly string[];
    /** Paths from writablePaths that intentionally represent directories. */
    writableDirectoryPaths?: readonly string[];
    /**
     * Repository-relative paths that remain immutable even when writablePaths
     * is omitted for a source-editing phase. Selected artifact outputs may be
     * carved out explicitly through the exception lists below.
     */
    protectedWritePaths?: readonly string[];
    protectedWriteExceptionPaths?: readonly string[];
    protectedWriteExceptionDirectoryPaths?: readonly string[];
    /**
     * Selected user-stories directory that may expose the deterministic
     * structured Blocker writer. No caller-controlled path reaches that tool.
     */
    userStoriesBlockerDirectory?: string;
    /**
     * Selected design-spec file that may expose the deterministic structured
     * Designer writer. The model supplies semantic fields, never a path or a
     * doubly encoded Markdown/JSON document.
     */
    structuredDesignSpecTarget?: StructuredDesignSpecTarget;
    /**
     * Selected Architect checkpoint files. The model supplies semantic scope
     * and option fields; the platform owns paths, rule catalog identity and
     * the three cross-artifact machine contracts.
     */
    structuredArchitectureCheckpointTarget?: StructuredArchitectureCheckpointTarget;
    /**
     * Complete selected Software Engineer evidence pack. The model supplies
     * seven documents in one bounded call; platform-owned paths prevent a
     * small local model from spending one repair round-trip per file.
     */
    structuredEngineeringEvidenceTarget?: StructuredEngineeringEvidenceTarget;
  }): Promise<RootedAgentToolHost> {
    const canonicalRoot = await realpath(path.resolve(input.rootPath));
    const rootStat = await stat(canonicalRoot);
    if (!rootStat.isDirectory()) {
      throw new ProviderAgentToolError("AGENT_WORKSPACE_INVALID", "Sandbox Workspace 不是目录");
    }
    if (
      input.checkRunner
      && input.checkRunner.isolation !== "container"
      && input.checkRunner.isolation !== "microvm"
    ) {
      throw new Error("Sandbox check Runner 没有声明真实隔离边界");
    }
    const checkDefinitions = input.checkRunner
      ? input.checkRunner.definitions().map((definition) => ({ ...definition }))
      : [];
    validateCheckDefinitions(checkDefinitions);
    const resolveScopedPaths = (candidates: readonly string[]): string[] => [...new Set(
      candidates.map((candidate) => {
        const relative = parseRepositoryPath(candidate);
        const absolute = path.resolve(canonicalRoot, relative);
        if (!isWithin(canonicalRoot, absolute)) {
          throw new ProviderAgentToolError(
            "AGENT_WRITE_SCOPE_INVALID",
            "Sandbox 写入范围超出 Workspace",
            true,
          );
        }
        return absolute;
      }),
    )];
    const writablePaths = input.writablePaths === undefined
      ? null
      : resolveScopedPaths(input.writablePaths);
    const writableDirectoryPaths = input.writableDirectoryPaths === undefined
      ? null
      : [...new Set(input.writableDirectoryPaths.map((candidate) => {
          const [absolute] = resolveScopedPaths([candidate]);
          if (!absolute) {
            throw new ProviderAgentToolError(
              "AGENT_WRITE_SCOPE_INVALID",
              "Sandbox 目录写入范围无效",
              true,
            );
          }
          if (
            writablePaths !== null
            && !writablePaths.some((allowed) => allowed === absolute)
          ) {
            throw new ProviderAgentToolError(
              "AGENT_WRITE_SCOPE_INVALID",
              "Sandbox 目录写入范围未包含在文件写入范围内",
              true,
            );
          }
          return absolute;
        }))];
    const protectedWritePaths = resolveScopedPaths(input.protectedWritePaths ?? []);
    const protectedWriteExceptionPaths = resolveScopedPaths(
      input.protectedWriteExceptionPaths ?? [],
    );
    const protectedWriteExceptionDirectoryPaths = resolveScopedPaths(
      input.protectedWriteExceptionDirectoryPaths ?? [],
    );
    if (protectedWriteExceptionDirectoryPaths.some(
      (directory) => !protectedWriteExceptionPaths.includes(directory),
    )) {
      throw new ProviderAgentToolError(
        "AGENT_WRITE_SCOPE_INVALID",
        "Sandbox 受保护目录例外未包含在产物例外范围内",
        true,
      );
    }
    const userStoriesBlockerDirectory = input.userStoriesBlockerDirectory === undefined
      ? null
      : parseRepositoryPath(input.userStoriesBlockerDirectory);
    if (userStoriesBlockerDirectory !== null) {
      const absolute = path.resolve(canonicalRoot, userStoriesBlockerDirectory);
      if (
        input.accessMode !== "sandbox-write"
        || writableDirectoryPaths === null
        || !writableDirectoryPaths.includes(absolute)
      ) {
        throw new ProviderAgentToolError(
          "AGENT_WRITE_SCOPE_INVALID",
          "结构化 User Stories Blocker 工具未绑定到已选择的目录产物",
          true,
        );
      }
    }
    const structuredDesignSpecTarget = input.structuredDesignSpecTarget === undefined
      ? null
      : {
          ...input.structuredDesignSpecTarget,
          filePath: parseRepositoryPath(input.structuredDesignSpecTarget.filePath),
          title: input.structuredDesignSpecTarget.title.trim(),
          sourceArtifactKeys: [...new Set(
            input.structuredDesignSpecTarget.sourceArtifactKeys
              .map((value) => value.trim())
              .filter((value) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)),
          )],
        };
    if (structuredDesignSpecTarget !== null) {
      const absolute = path.resolve(canonicalRoot, structuredDesignSpecTarget.filePath);
      if (
        input.accessMode !== "sandbox-write"
        || writablePaths === null
        || !writablePaths.includes(absolute)
        || writableDirectoryPaths?.includes(absolute)
        || !structuredDesignSpecTarget.title
        || structuredDesignSpecTarget.sourceArtifactKeys.length === 0
      ) {
        throw new ProviderAgentToolError(
          "AGENT_WRITE_SCOPE_INVALID",
          "结构化 Design Spec 工具未绑定到已选择的文件产物和权威输入",
          true,
        );
      }
    }
    const structuredArchitectureCheckpointTarget = input.structuredArchitectureCheckpointTarget === undefined
      ? null
      : {
          ...input.structuredArchitectureCheckpointTarget,
          discoveryPath: parseRepositoryPath(input.structuredArchitectureCheckpointTarget.discoveryPath),
          optionsPath: parseRepositoryPath(input.structuredArchitectureCheckpointTarget.optionsPath),
          architecturePath: parseRepositoryPath(input.structuredArchitectureCheckpointTarget.architecturePath),
          title: input.structuredArchitectureCheckpointTarget.title.trim(),
          rules: input.structuredArchitectureCheckpointTarget.rules.map((rule) => ({ ...rule })),
        };
    if (structuredArchitectureCheckpointTarget !== null) {
      const targetPaths = [
        structuredArchitectureCheckpointTarget.discoveryPath,
        structuredArchitectureCheckpointTarget.optionsPath,
        structuredArchitectureCheckpointTarget.architecturePath,
      ];
      const absolutePaths = targetPaths.map((candidate) => path.resolve(canonicalRoot, candidate));
      if (
        input.accessMode !== "sandbox-write"
        || writablePaths === null
        || absolutePaths.some((absolute) => !writablePaths.includes(absolute))
        || absolutePaths.some((absolute) => writableDirectoryPaths?.includes(absolute))
        || new Set(absolutePaths).size !== 3
        || !structuredArchitectureCheckpointTarget.title
        || !/^[a-f0-9]{64}$/u.test(structuredArchitectureCheckpointTarget.catalogDigest)
        || structuredArchitectureCheckpointTarget.rules.length === 0
      ) {
        throw new ProviderAgentToolError(
          "AGENT_WRITE_SCOPE_INVALID",
          "结构化 Architect 检查点工具未绑定到三份已选择产物和当前规则簿",
          true,
        );
      }
    }
    const structuredEngineeringEvidenceTarget = input.structuredEngineeringEvidenceTarget === undefined
      ? null
      : Object.fromEntries(Object.entries(input.structuredEngineeringEvidenceTarget).map(
          ([key, candidate]) => [key, parseRepositoryPath(candidate)],
        )) as unknown as StructuredEngineeringEvidenceTarget;
    if (structuredEngineeringEvidenceTarget !== null) {
      const targetPaths = Object.values(structuredEngineeringEvidenceTarget);
      const absolutePaths = targetPaths.map((candidate) => path.resolve(canonicalRoot, candidate));
      if (
        input.accessMode !== "sandbox-write"
        || new Set(absolutePaths).size !== 7
        || absolutePaths.some((absolute) => !protectedWriteExceptionPaths.includes(absolute))
        || absolutePaths.some((absolute) => protectedWriteExceptionDirectoryPaths.includes(absolute))
      ) {
        throw new ProviderAgentToolError(
          "AGENT_WRITE_SCOPE_INVALID",
          "结构化工程证据工具未绑定到七份已选择的文件产物",
          true,
        );
      }
    }
    const host = new RootedAgentToolHost(
      canonicalRoot,
      input.accessMode,
      input.checkRunner,
      checkDefinitions,
      writablePaths,
      writableDirectoryPaths,
      protectedWritePaths,
      protectedWriteExceptionPaths,
      protectedWriteExceptionDirectoryPaths,
      userStoriesBlockerDirectory,
      structuredDesignSpecTarget,
      structuredArchitectureCheckpointTarget,
      structuredEngineeringEvidenceTarget,
    );
    await host.refreshUserStoriesSentinelReadmes();
    return host;
  }

  definitions(): readonly AskLlmFunctionTool[] {
    const tools: AskLlmFunctionTool[] = [LIST_FILES_TOOL, READ_FILE_TOOL, SEARCH_TEXT_TOOL];
    if (this.accessMode === "sandbox-write") {
      tools.push(CREATE_DIRECTORY_TOOL, WRITE_FILE_TOOL, APPLY_PATCH_TOOL);
      if (this.userStoriesBlockerDirectory !== null) {
        tools.push(USER_STORIES_BLOCKER_TOOL);
      }
      if (this.structuredDesignSpecTarget !== null) {
        tools.push(WRITE_DESIGN_SPEC_TOOL);
      }
      if (this.structuredArchitectureCheckpointTarget !== null) {
        tools.push(WRITE_ARCHITECTURE_CHECKPOINT_TOOL);
      }
      if (this.structuredEngineeringEvidenceTarget !== null) {
        tools.push(WRITE_ENGINEERING_EVIDENCE_PACK_TOOL);
      }
    }
    if (
      this.accessMode === "sandbox-write"
      && this.checkRunner
      && this.checkDefinitions.length > 0
    ) {
      const checks = this.checkDefinitions;
      tools.push({
        type: "function",
        name: "run_check",
        description: "运行 Sandbox Blueprint 预先批准的一项检查。只能使用 checkId，不能提交命令、参数、环境变量或宿主路径。",
        strict: true,
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["checkId"],
          properties: {
            checkId: {
              type: "string",
              enum: checks.map(({ id }) => id),
              description: checks.map(({ id, label }) => `${id}: ${label}`).join("；"),
            },
          },
        },
      });
    }
    return tools;
  }

  async execute(
    call: AskLlmToolCall,
    options: { signal: AbortSignal; maxOutputCharacters: number },
  ): Promise<ProviderAgentToolExecution> {
    assertNotAborted(options.signal);
    const outputLimit = Math.min(
      Math.max(1, options.maxOutputCharacters),
      MAX_TOOL_OUTPUT_CHARACTERS,
    );
    try {
      switch (call.name) {
        case "list_files":
          return await this.listFiles(listFilesArgumentsSchema.parse(call.arguments), outputLimit);
        case "read_file":
          return await this.readSource(readFileArgumentsSchema.parse(call.arguments), outputLimit);
        case "search_text":
          return await this.searchText(searchTextArgumentsSchema.parse(call.arguments), outputLimit);
        case "write_file":
          this.assertWritable();
          return await this.writeSource(
            writeFileArgumentsSchema.parse(call.arguments),
            options.signal,
          );
        case "apply_patch":
          this.assertWritable();
          return await this.applyPatch(
            applyPatchArgumentsSchema.parse(call.arguments),
            options.signal,
          );
        case "create_directory":
          this.assertWritable();
          return await this.createDirectory(
            createDirectoryArgumentsSchema.parse(call.arguments),
            options.signal,
          );
        case "write_user_stories_blocker":
          this.assertWritable();
          return await this.writeUserStoriesBlocker(
            userStoriesBlockerArgumentsSchema.parse(call.arguments),
            options.signal,
          );
        case "write_design_spec":
          this.assertWritable();
          return await this.writeStructuredDesignSpec(
            designSpecArgumentsSchema.parse(call.arguments),
            options.signal,
          );
        case "write_architecture_checkpoint":
          this.assertWritable();
          return await this.writeStructuredArchitectureCheckpoint(
            architectureCheckpointArgumentsSchema.parse(call.arguments),
            options.signal,
          );
        case "write_engineering_evidence_pack":
          this.assertWritable();
          return await this.writeStructuredEngineeringEvidencePack(
            engineeringEvidencePackArgumentsSchema.parse(call.arguments),
            options.signal,
          );
        case "run_check":
          this.assertWritable();
          return await this.runCheck(
            runCheckArgumentsSchema.parse(call.arguments),
            options.signal,
            outputLimit,
          );
        default:
          throw new ProviderAgentToolError(
            "AGENT_TOOL_NOT_ALLOWED",
            "模型选择了未向本轮开放的工具，平台已拒绝执行",
          );
      }
    } catch (error) {
      if (error instanceof ProviderAgentToolError) throw error;
      if (error instanceof AppError && error.code === "INVALID_USER_STORIES_BLOCKER_DRAFT") {
        const field = safeBlockerDraftField(error.details);
        const reason = safeBlockerDraftReason(error.details);
        throw new ProviderAgentToolError(
          "AGENT_USER_STORIES_BLOCKER_INVALID",
          reason === "BLOCKER_WORKFLOW_MECHANISM_FORBIDDEN"
            ? `User Stories Blocker 字段 ${field ?? "内容"} 必须描述产品或业务事实；不得把已有 Blocker、README/Story 文件、sentinel、工具错误或平台迁移顺序写成阻塞原因`
            : field
            ? `User Stories Blocker 字段 ${field} 必须填写完整、具体的实质内容，请修正后重试`
            : "User Stories Blocker 字段必须填写完整、具体的实质内容，请修正后重试",
        );
      }
      if (error instanceof z.ZodError) {
        if (call.name === "write_design_spec") {
          const fields = [...new Set(error.issues.map((issue) => (
            issue.path.length > 0 ? issue.path.join(".") : "arguments"
          )))].slice(0, 8);
          throw new ProviderAgentToolError(
            "AGENT_DESIGN_SPEC_ARGUMENTS_INVALID",
            `write_design_spec 字段 ${fields.join("、")} 不符合 Designer 合同；请按工具 schema 修正后再次调用，空 ledger 也必须显式提交 []`,
          );
        }
        if (call.name === "write_architecture_checkpoint") {
          const fields = [...new Set(error.issues.map((issue) => (
            issue.path.length > 0 ? issue.path.join(".") : "arguments"
          )))].slice(0, 8);
          throw new ProviderAgentToolError(
            "AGENT_ARCHITECTURE_CHECKPOINT_ARGUMENTS_INVALID",
            `write_architecture_checkpoint 字段 ${fields.join("、")} 不符合 Architect 合同；请按工具 schema 修正后再次调用`,
          );
        }
        if (call.name === "write_engineering_evidence_pack") {
          const fields = [...new Set(error.issues.map((issue) => (
            issue.path.length > 0 ? issue.path.join(".") : "arguments"
          )))].slice(0, 8);
          throw new ProviderAgentToolError(
            "AGENT_ENGINEERING_EVIDENCE_ARGUMENTS_INVALID",
            `write_engineering_evidence_pack 字段 ${fields.join("、")} 不符合工程证据合同；必须一次提交七份完整 Markdown`,
          );
        }
        const fields = [...new Set(error.issues.map((issue) => (
          issue.path.length > 0 ? issue.path.join(".") : "arguments"
        )))].slice(0, 8);
        throw new ProviderAgentToolError(
          "AGENT_TOOL_ARGUMENTS_INVALID",
          `工具参数不符合平台约束，未执行；${call.name} 字段 ${fields.join("、")} 必须严格匹配已声明 schema`,
        );
      }
      throw new ProviderAgentToolError("AGENT_TOOL_FAILED", safeFileError(error));
    }
  }

  private async listFiles(
    input: z.infer<typeof listFilesArgumentsSchema>,
    outputLimit: number,
  ): Promise<ProviderAgentToolExecution> {
    const relative = parseBrowsablePath(input.path);
    const directory = await this.resolveExisting(relative, "directory");
    const entries: string[] = [];
    await walkTree({
      absoluteRoot: directory,
      relativeRoot: relative,
      depth: 0,
      maxDepth: input.maxDepth,
      maxEntries: input.maxEntries,
      entries,
    });
    const omitted = entries.length >= input.maxEntries;
    const content = boundedText(
      entries.join("\n") || "（目录为空，或内容均属于平台禁止暴露的路径。）",
      outputLimit,
    );
    return {
      summary: omitted
        ? `列出 ${entries.length} 项，已达到上限`
        : `列出 ${entries.length} 项`,
      content,
      changedPaths: [],
    };
  }

  private async readSource(
    input: z.infer<typeof readFileArgumentsSchema>,
    outputLimit: number,
  ): Promise<ProviderAgentToolExecution> {
    const relative = parseRepositoryPath(input.path);
    const absolute = await this.resolveExisting(relative, "file");
    const content = await readUtf8Source(absolute);
    const lines = content.split(/\r?\n/u);
    if (input.startLine > lines.length) {
      throw new ProviderAgentToolError(
        "AGENT_FILE_RANGE_INVALID",
        `起始行超出文件范围；文件共 ${lines.length} 行`,
      );
    }
    const endLine = Math.min(input.endLine, input.startLine + 399, lines.length);
    const selected = lines.slice(input.startLine - 1, endLine)
      .map((line, index) => `${input.startLine + index}: ${line}`)
      .join("\n");
    const redacted = redactLikelySecrets(selected);
    return {
      summary: redacted.redacted
        ? `读取 ${relative} 第 ${input.startLine}-${endLine} 行；疑似 Secret 已隐藏`
        : `读取 ${relative} 第 ${input.startLine}-${endLine} 行`,
      content: boundedText(redacted.text, outputLimit),
      changedPaths: [],
    };
  }

  private async searchText(
    input: z.infer<typeof searchTextArgumentsSchema>,
    outputLimit: number,
  ): Promise<ProviderAgentToolExecution> {
    const relative = parseBrowsablePath(input.path);
    const directory = await this.resolveExisting(relative, "directory");
    const files = await collectSourceFiles(directory, relative);
    const needle = input.caseSensitive ? input.query : input.query.toLocaleLowerCase("en-US");
    const matches: string[] = [];
    let searchedBytes = 0;
    let searchedFiles = 0;
    for (const file of files) {
      if (matches.length >= input.maxResults || searchedFiles >= MAX_SEARCHED_FILES) break;
      const fileStat = await lstat(file.absolute);
      if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.nlink !== 1) continue;
      if (fileStat.size > MAX_SOURCE_FILE_BYTES || searchedBytes + fileStat.size > MAX_SEARCHED_BYTES) continue;
      let source: string;
      try {
        source = await readUtf8Source(file.absolute);
      } catch (error) {
        if (error instanceof ProviderAgentToolError && error.code === "AGENT_FILE_NOT_TEXT") continue;
        throw error;
      }
      searchedBytes += fileStat.size;
      searchedFiles += 1;
      const lines = source.split(/\r?\n/u);
      for (let index = 0; index < lines.length && matches.length < input.maxResults; index += 1) {
        const line = lines[index] ?? "";
        const haystack = input.caseSensitive ? line : line.toLocaleLowerCase("en-US");
        if (!haystack.includes(needle)) continue;
        const excerpt = redactLikelySecrets(line.slice(0, 500)).text;
        matches.push(`${file.relative}:${index + 1}: ${excerpt}`);
      }
    }
    return {
      summary: `在 ${searchedFiles} 个文本文件中找到 ${matches.length} 处`,
      content: boundedText(matches.join("\n") || "没有找到匹配内容。", outputLimit),
      changedPaths: [],
    };
  }

  private async writeSource(
    input: z.infer<typeof writeFileArgumentsSchema>,
    signal: AbortSignal,
    options: {
      allowStructuredUserStoriesBlocker?: boolean;
      allowStructuredDesignSpec?: boolean;
      allowStructuredArchitectureCheckpoint?: boolean;
    } = {},
  ): Promise<ProviderAgentToolExecution> {
    const relative = parseRepositoryPath(input.path);
    this.assertWritableFilePath(relative);
    this.assertDesignSpecWriter(relative, options.allowStructuredDesignSpec === true);
    this.assertArchitectureCheckpointWriter(
      relative,
      options.allowStructuredArchitectureCheckpoint === true,
    );
    await this.assertUserStoriesBlockerProvenance(
      relative,
      input.content,
      options.allowStructuredUserStoriesBlocker === true,
    );
    assertNoSecretMaterial(input.content);
    const parentRelative = path.dirname(relative);
    let parentChange: ProviderAgentToolExecution | null = null;
    if (parentRelative !== ".") {
      // A selected directory artifact may contain arbitrarily nested files.
      // Keep the same scope, protected-path and symlink checks as the explicit
      // create_directory tool, but do not make a local model spend three
      // round-trips merely because it omitted one intermediate mkdir.
      parentChange = await this.createDirectory({ path: parentRelative }, signal);
    }
    const target = await this.resolveWritableFile(relative, input.overwrite);
    assertNotAborted(signal);
    if (input.overwrite) {
      try {
        const current = await readUtf8Source(target);
        if (current === input.content) {
          return {
            summary: `目标内容未变化，无需重复写入：${relative}`,
            content: "文件已经与请求内容完全一致。",
            changedPaths: parentChange?.changedPaths ?? [],
          };
        }
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      }
    }
    await writeUtf8NoFollow(target, input.content, input.overwrite, signal);
    if (this.isUserStoriesOutputPath(relative)) {
      await this.refreshUserStoriesSentinelReadmes();
    }
    return {
      summary: [
        ...(parentChange?.changedPaths.length
          ? [`已安全创建缺失父目录 ${parentRelative}`]
          : []),
        `${input.overwrite ? "写入" : "创建"} ${relative}（${Buffer.byteLength(input.content, "utf8")} bytes）`,
      ].join("；"),
      content: "文件已在当前 Session Sandbox 内更新。",
      changedPaths: [
        ...(parentChange?.changedPaths ?? []),
        relative,
      ],
    };
  }

  private async applyPatch(
    input: z.infer<typeof applyPatchArgumentsSchema>,
    signal: AbortSignal,
  ): Promise<ProviderAgentToolExecution> {
    const relative = parseRepositoryPath(input.path);
    this.assertWritableFilePath(relative);
    this.assertDesignSpecWriter(relative, false);
    this.assertArchitectureCheckpointWriter(relative, false);
    const absolute = await this.resolveWritableFile(relative, true);
    const current = await readUtf8Source(absolute);
    const occurrences = countOccurrences(current, input.oldText);
    if (occurrences === 0) {
      if (input.newText && countOccurrences(current, input.newText) === 1) {
        await this.assertUserStoriesBlockerProvenance(relative, current, false, current);
        return {
          summary: `目标已包含相同 newText，重复补丁无需执行：${relative}`,
          content: "文件已处于该补丁要求的结果状态。",
          changedPaths: [],
        };
      }
      throw new ProviderAgentToolError(
        "AGENT_PATCH_CONTEXT_MISSING",
        "补丁的 oldText 在目标文件中不存在，文件未改动；请先 read_file 获取当前内容，或对已授权目标使用 write_file + overwrite=true 完整重写，不要重复相同补丁",
      );
    }
    if (!input.replaceAll && occurrences !== 1) {
      throw new ProviderAgentToolError(
        "AGENT_PATCH_CONTEXT_AMBIGUOUS",
        `补丁的 oldText 出现 ${occurrences} 次；请提供更精确上下文`,
      );
    }
    const updated = input.replaceAll
      ? current.split(input.oldText).join(input.newText)
      : current.replace(input.oldText, input.newText);
    if (Buffer.byteLength(updated, "utf8") > MAX_WRITE_BYTES) {
      throw new ProviderAgentToolError("AGENT_FILE_TOO_LARGE", "补丁后的文件超过 Sandbox 写入上限");
    }
    await this.assertUserStoriesBlockerProvenance(relative, updated, false, current);
    assertNoSecretMaterial(updated);
    assertNotAborted(signal);
    await writeUtf8NoFollow(absolute, updated, true, signal);
    if (this.isUserStoriesOutputPath(relative)) {
      await this.refreshUserStoriesSentinelReadmes();
    }
    return {
      summary: `补丁已应用到 ${relative}${input.replaceAll ? `（${occurrences} 处）` : ""}`,
      content: "文件已在当前 Session Sandbox 内更新。",
      changedPaths: [relative],
    };
  }

  private async createDirectory(
    input: z.infer<typeof createDirectoryArgumentsSchema>,
    signal: AbortSignal,
  ): Promise<ProviderAgentToolExecution> {
    const relative = parseRepositoryPath(input.path);
    this.assertWritableDirectoryPath(relative);
    const components = relative.split(path.sep);
    let cursor = this.rootPath;
    let created = false;
    for (const component of components) {
      assertNotAborted(signal);
      cursor = path.join(cursor, component);
      this.assertWithinRoot(cursor);
      try {
        const entry = await lstat(cursor);
        if (entry.isSymbolicLink() || !entry.isDirectory()) {
          throw new ProviderAgentToolError(
            "AGENT_PATH_KIND_INVALID",
            "目录路径包含符号链接或非目录项",
          );
        }
      } catch (error) {
        if (error instanceof ProviderAgentToolError) throw error;
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
        assertNotAborted(signal);
        await mkdir(cursor);
        created = true;
      }
    }
    return {
      summary: `${created ? "创建" : "确认"}目录 ${relative}`,
      content: created ? "目录已在当前 Session Sandbox 内创建。" : "目录已存在。",
      changedPaths: created ? [relative] : [],
    };
  }

  private async writeUserStoriesBlocker(
    input: z.infer<typeof userStoriesBlockerArgumentsSchema>,
    signal: AbortSignal,
  ): Promise<ProviderAgentToolExecution> {
    if (this.userStoriesBlockerDirectory === null) {
      throw new ProviderAgentToolError(
        "AGENT_TOOL_NOT_ALLOWED",
        "本阶段没有选择 User Stories Blocker 目录，平台已拒绝写入",
      );
    }
    const content = renderUserStoriesBlocker({
      status: input.status,
      knownFacts: [],
      missingFacts: input.missingFacts,
      openQuestions: input.openQuestions,
      humanOwners: [input.humanOwner],
      nextSteps: [input.nextStep],
    });
    assertNoSecretMaterial(content);
    const relative = path.join(this.userStoriesBlockerDirectory, "README.md");
    const result = await this.writeSource({
      path: relative.split(path.sep).join("/"),
      content,
      overwrite: true,
    }, signal, { allowStructuredUserStoriesBlocker: true });
    return {
      ...result,
      summary: `写入结构化 User Stories Blocker（${Buffer.byteLength(content, "utf8")} bytes）`,
    };
  }

  private async writeStructuredDesignSpec(
    input: z.infer<typeof designSpecArgumentsSchema>,
    signal: AbortSignal,
  ): Promise<ProviderAgentToolExecution> {
    if (this.structuredDesignSpecTarget === null) {
      throw new ProviderAgentToolError(
        "AGENT_TOOL_NOT_ALLOWED",
        "本阶段没有选择 Design Spec 文件，平台已拒绝结构化写入",
      );
    }
    const content = renderStructuredDesignSpec(this.structuredDesignSpecTarget, input);
    assertNoSecretMaterial(content);
    const result = await this.writeSource({
      path: this.structuredDesignSpecTarget.filePath.split(path.sep).join("/"),
      content,
      overwrite: true,
    }, signal, { allowStructuredDesignSpec: true });
    return {
      ...result,
      summary: `写入结构化 Design Spec（${Buffer.byteLength(content, "utf8")} bytes）`,
    };
  }

  private async writeStructuredArchitectureCheckpoint(
    input: z.infer<typeof architectureCheckpointArgumentsSchema>,
    signal: AbortSignal,
  ): Promise<ProviderAgentToolExecution> {
    const target = this.structuredArchitectureCheckpointTarget;
    if (target === null) {
      throw new ProviderAgentToolError(
        "AGENT_TOOL_NOT_ALLOWED",
        "本阶段没有选择完整 Architect 检查点，平台已拒绝结构化写入",
      );
    }
    assertConfiguredArchitectureProjectMode(
      target.configuredProjectMode,
      normalizeArchitectureScopes(input.scopes),
    );
    const rendered = renderStructuredArchitectureCheckpoint(target, input);
    for (const content of Object.values(rendered)) assertNoSecretMaterial(content);
    const changedPaths: string[] = [];
    for (const [targetPath, content] of [
      [target.discoveryPath, rendered.discovery],
      [target.optionsPath, rendered.options],
      [target.architecturePath, rendered.architecture],
    ] as const) {
      const result = await this.writeSource({
        path: targetPath.split(path.sep).join("/"),
        content,
        overwrite: true,
      }, signal, { allowStructuredArchitectureCheckpoint: true });
      changedPaths.push(...result.changedPaths);
    }
    const bytes = Object.values(rendered).reduce(
      (total, content) => total + Buffer.byteLength(content, "utf8"),
      0,
    );
    return {
      summary: `写入结构化 Architect 检查点 3 份产物（${bytes} bytes）`,
      content: "三份产物已绑定当前规则簿并在当前 Session Sandbox 内更新。",
      changedPaths: [...new Set(changedPaths)],
    };
  }

  private async writeStructuredEngineeringEvidencePack(
    input: z.infer<typeof engineeringEvidencePackArgumentsSchema>,
    signal: AbortSignal,
  ): Promise<ProviderAgentToolExecution> {
    const target = this.structuredEngineeringEvidenceTarget;
    if (target === null) {
      throw new ProviderAgentToolError(
        "AGENT_TOOL_NOT_ALLOWED",
        "本阶段没有选择完整工程证据包，平台已拒绝结构化写入",
      );
    }
    const documents = [
      [target.implementationNotesPath, input.implementationNotes],
      [target.implementationPlanPath, input.implementationPlan],
      [target.implementationTasksPath, input.implementationTasks],
      [target.sessionLogPath, input.sessionLog],
      [target.independentTestEvidencePath, input.independentTestEvidence],
      [target.reviewPath, input.review],
      [target.provenancePath, input.provenance],
    ] as const;
    for (const [, content] of documents) assertNoSecretMaterial(content);
    const changedPaths: string[] = [];
    for (const [targetPath, content] of documents) {
      const result = await this.writeSource({
        path: targetPath.split(path.sep).join("/"),
        content,
        overwrite: true,
      }, signal);
      changedPaths.push(...result.changedPaths);
    }
    const bytes = documents.reduce(
      (total, [, content]) => total + Buffer.byteLength(content, "utf8"),
      0,
    );
    return {
      summary: `批量写入工程证据 7 份（${bytes} bytes）`,
      content: "七份工程证据已按平台绑定路径在当前 Session Sandbox 内更新。",
      changedPaths: [...new Set(changedPaths)],
    };
  }

  private async runCheck(
    input: z.infer<typeof runCheckArgumentsSchema>,
    signal: AbortSignal,
    outputLimit: number,
  ): Promise<ProviderAgentToolExecution> {
    if (!this.checkRunner) {
      throw new ProviderAgentToolError(
        "AGENT_CHECK_RUNNER_UNAVAILABLE",
        "当前 Sandbox 没有注册隔离测试 Runner，未在 API 宿主执行命令",
      );
    }
    const definition = this.checkDefinitions.find(({ id }) => id === input.checkId);
    if (!definition) {
      throw new ProviderAgentToolError(
        "AGENT_CHECK_NOT_ALLOWED",
        "该检查不在 Sandbox Blueprint 的批准列表中",
      );
    }
    const result = await this.checkRunner.run({
      checkId: definition.id,
      workspaceRoot: this.rootPath,
      timeoutMs: definition.timeoutMs,
      maxOutputBytes: Math.min(outputLimit * 4, 192_000),
      signal,
    });
    if (!Number.isSafeInteger(result.exitCode) || result.durationMs < 0) {
      throw new ProviderAgentToolError("AGENT_CHECK_RESULT_INVALID", "Sandbox Runner 返回了无效结果");
    }
    const redacted = redactLikelySecrets(result.output);
    return {
      summary: `${definition.label} ${result.exitCode === 0 ? "通过" : `失败（exit ${result.exitCode}）`}，耗时 ${Math.round(result.durationMs)}ms`,
      content: boundedText(redacted.text || "（检查没有输出。）", outputLimit),
      changedPaths: [],
    };
  }

  private assertWritable(): void {
    if (this.accessMode !== "sandbox-write") {
      throw new ProviderAgentToolError(
        "AGENT_WORKSPACE_READ_ONLY",
        "当前 @repo 不是本 Session 的可写主仓库，平台已拒绝修改",
      );
    }
  }

  private assertWritableFilePath(relative: string): void {
    const absolute = path.resolve(this.rootPath, relative);
    this.assertProtectedWritePath(absolute, "file");
    if (this.writablePaths === null) return;
    const exactFile = this.writablePaths.some((allowed) => (
      allowed === absolute
      && !(this.writableDirectoryPaths?.includes(allowed) ?? false)
    ));
    const withinDeclaredDirectory = this.writableDirectoryPaths?.some(
      (allowed) => absolute !== allowed && isWithin(allowed, absolute),
    ) ?? false;
    if (exactFile || withinDeclaredDirectory) return;
    throw new ProviderAgentToolError(
      "AGENT_WRITE_SCOPE_FORBIDDEN",
      "该文件不在本阶段允许写入的产物范围内",
    );
  }

  private assertDesignSpecWriter(relative: string, allowStructured: boolean): void {
    if (
      this.structuredDesignSpecTarget === null
      || relative !== this.structuredDesignSpecTarget.filePath
      || allowStructured
    ) return;
    throw new ProviderAgentToolError(
      "AGENT_DESIGN_SPEC_REQUIRES_STRUCTURED_TOOL",
      "所选 design-spec 必须通过 write_design_spec 生成；通用 write_file/apply_patch 不得手写 machine JSON 或 Handoff",
    );
  }

  private assertArchitectureCheckpointWriter(relative: string, allowStructured: boolean): void {
    if (this.structuredArchitectureCheckpointTarget === null || allowStructured) return;
    const protectedTargets = new Set([
      this.structuredArchitectureCheckpointTarget.discoveryPath,
      this.structuredArchitectureCheckpointTarget.optionsPath,
      this.structuredArchitectureCheckpointTarget.architecturePath,
    ]);
    if (!protectedTargets.has(relative)) return;
    throw new ProviderAgentToolError(
      "AGENT_ARCHITECTURE_CHECKPOINT_REQUIRES_STRUCTURED_TOOL",
      "Architect 的 discovery/options/architecture 检查点必须通过 write_architecture_checkpoint 一次生成；通用 write_file/apply_patch 不得手写规则簿机器块",
    );
  }

  private async assertUserStoriesBlockerProvenance(
    relative: string,
    resultingContent: string,
    allowStructuredUserStoriesBlocker: boolean,
    currentContent?: string,
  ): Promise<void> {
    if (this.userStoriesBlockerDirectory === null) return;
    if (!this.isUserStoriesOutputPath(relative)) return;
    const canonicalBlockerPath = path.join(this.userStoriesBlockerDirectory, "README.md");
    if (allowStructuredUserStoriesBlocker && relative === canonicalBlockerPath) return;
    // The repository can change outside this Provider tool host while an
    // execution is active. Re-scan before every generic provenance decision
    // so a post-create Blocker cannot be hidden by a stale empty cache, and a
    // Blocker removed externally does not keep sidecars falsely locked.
    await this.refreshUserStoriesSentinelReadmes();
    if (containsUserStoriesBlockerSentinelCandidate(resultingContent)) {
      throw new ProviderAgentToolError(
        "AGENT_BLOCKER_REQUIRES_STRUCTURED_TOOL",
        "User Stories Blocker 必须通过 write_user_stories_blocker 生成；通用文件工具只能用不含 sentinel 的真实 Stories 替换现有 Blocker",
      );
    }
    if (this.userStoriesSentinelReadmes.size === 0) return;
    let existingContent = currentContent;
    if (existingContent === undefined) {
      try {
        const existing = await this.resolveExisting(relative, "file");
        existingContent = await readUtf8Source(existing);
      } catch {
        existingContent = undefined;
      }
    }
    if (
      existingContent !== undefined
      && containsUserStoriesBlockerSentinelCandidate(existingContent)
    ) {
      // Legacy or externally edited directories can contain a second sentinel
      // in a case-variant README or nested file. That file may be rewritten only
      // to content without the sentinel, allowing the deterministic gate to
      // recover without granting a general delete primitive.
      return;
    }
    throw new ProviderAgentToolError(
      "AGENT_BLOCKER_MIGRATION_REQUIRED",
      "这是平台产物迁移顺序，不是产品或业务缺失事实：当前 User Stories 仍有既存 Blocker；如目标文件本身含旧 sentinel，可用 write_file + overwrite=true 直接清除，否则请先重写根 README 并移除 sentinel，再修改同目录的 Story 或 sidecar 文件；不得把本错误、Blocker/README/sentinel、工具或平台机制写回 User Stories Blocker",
    );
  }

  private isUserStoriesOutputPath(relative: string): boolean {
    if (this.userStoriesBlockerDirectory === null) return false;
    return isWithin(
      path.resolve(this.rootPath, this.userStoriesBlockerDirectory),
      path.resolve(this.rootPath, relative),
    );
  }

  private async refreshUserStoriesSentinelReadmes(): Promise<void> {
    const discovered = new Set<string>();
    if (this.userStoriesBlockerDirectory !== null) {
      const absoluteDirectory = path.resolve(this.rootPath, this.userStoriesBlockerDirectory);
      let entries: Dirent[];
      try {
        const directoryStat = await lstat(absoluteDirectory);
        if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
          throw new ProviderAgentToolError(
            "AGENT_PATH_KIND_INVALID",
            "User Stories 产物路径不是安全的普通目录",
          );
        }
        entries = await readdir(absoluteDirectory, { withFileTypes: true });
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") entries = [];
        else throw error;
      }
      for (const entry of entries) {
        if (entry.name.toLocaleLowerCase("en-US") !== "readme.md") continue;
        if (entry.isSymbolicLink()) {
          throw new ProviderAgentToolError(
            "AGENT_PATH_KIND_INVALID",
            "User Stories 根 README 不能是符号链接",
          );
        }
        if (!entry.isFile()) continue;
        const relative = path.join(this.userStoriesBlockerDirectory, entry.name);
        const content = await readUtf8Source(path.resolve(this.rootPath, relative));
        if (containsUserStoriesBlockerSentinelCandidate(content)) discovered.add(relative);
      }
    }
    this.userStoriesSentinelReadmes.clear();
    for (const relative of discovered) this.userStoriesSentinelReadmes.add(relative);
  }

  private assertWritableDirectoryPath(relative: string): void {
    const absolute = path.resolve(this.rootPath, relative);
    this.assertProtectedWritePath(absolute, "directory");
    if (this.writablePaths === null) return;
    const withinDeclaredDirectory = this.writableDirectoryPaths?.some(
      (allowed) => isWithin(allowed, absolute),
    ) ?? false;
    const requiredParent = this.writablePaths.some(
      (allowed) => absolute !== allowed && isWithin(absolute, allowed),
    );
    if (withinDeclaredDirectory || requiredParent) return;
    throw new ProviderAgentToolError(
      "AGENT_WRITE_SCOPE_FORBIDDEN",
      "该目录不在本阶段允许写入的产物范围内",
    );
  }

  private assertProtectedWritePath(
    absolute: string,
    kind: "file" | "directory",
  ): void {
    if (this.protectedWritePaths.length === 0) return;
    if (kind === "file") {
      const exactSelectedFile = this.protectedWriteExceptionPaths.some((allowed) => (
        allowed === absolute
        && !this.protectedWriteExceptionDirectoryPaths.includes(allowed)
      ));
      const insideSelectedDirectory = this.protectedWriteExceptionDirectoryPaths.some(
        (allowed) => absolute !== allowed && isWithin(allowed, absolute),
      );
      if (exactSelectedFile || insideSelectedDirectory) return;
    } else {
      const insideSelectedDirectory = this.protectedWriteExceptionDirectoryPaths.some(
        (allowed) => isWithin(allowed, absolute),
      );
      const requiredSelectedParent = this.protectedWriteExceptionPaths.some(
        (allowed) => absolute !== allowed && isWithin(absolute, allowed),
      );
      if (insideSelectedDirectory || requiredSelectedParent) return;
    }
    if (this.protectedWritePaths.some((protectedPath) => isWithin(protectedPath, absolute))) {
      throw new ProviderAgentToolError(
        "AGENT_PROTECTED_PATH_FORBIDDEN",
        "该路径属于未选择产物或平台控制区，本阶段禁止写入",
      );
    }
  }

  private async resolveExisting(
    relative: string,
    kind: "file" | "directory",
  ): Promise<string> {
    const absolute = path.resolve(this.rootPath, relative === "." ? "" : relative);
    this.assertWithinRoot(absolute);
    await assertPathHasNoSymlink(this.rootPath, relative, false);
    const canonical = await realpath(absolute);
    this.assertWithinRoot(canonical);
    const targetStat = await stat(canonical);
    if (kind === "file" ? !targetStat.isFile() : !targetStat.isDirectory()) {
      throw new ProviderAgentToolError(
        "AGENT_PATH_KIND_INVALID",
        kind === "file" ? "目标不是普通文本文件" : "目标不是目录",
      );
    }
    return canonical;
  }

  private async resolveWritableFile(relative: string, overwrite: boolean): Promise<string> {
    const absolute = path.resolve(this.rootPath, relative);
    this.assertWithinRoot(absolute);
    const parentRelative = path.posix.dirname(relative);
    await this.resolveExisting(parentRelative === "." ? "." : parentRelative, "directory");
    try {
      const targetStat = await lstat(absolute);
      if (targetStat.isSymbolicLink() || !targetStat.isFile() || targetStat.nlink !== 1) {
        throw new ProviderAgentToolError(
          "AGENT_PATH_KIND_INVALID",
          "目标不是可写的单链接普通文件",
        );
      }
      if (!overwrite) {
        throw new ProviderAgentToolError(
          "AGENT_FILE_EXISTS",
          "目标文件已存在；只有明确 overwrite 才能覆盖",
        );
      }
      const canonical = await realpath(absolute);
      this.assertWithinRoot(canonical);
      return canonical;
    } catch (error) {
      if (error instanceof ProviderAgentToolError) throw error;
      if (isNodeError(error) && error.code === "ENOENT") return absolute;
      throw error;
    }
  }

  private assertWithinRoot(candidate: string): void {
    if (!isWithin(this.rootPath, candidate)) {
      throw new ProviderAgentToolError(
        "AGENT_PATH_OUTSIDE_WORKSPACE",
        "工具路径超出当前 Session Sandbox，平台已拒绝",
      );
    }
  }
}

function renderStructuredDesignSpec(
  target: StructuredDesignSpecTarget,
  input: z.infer<typeof designSpecArgumentsSchema>,
): string {
  const baselineArtifactKey = target.sourceArtifactKeys.find((artifactKey) => (
    artifactKey === "design-baseline"
  ));
  const contract = {
    spec_version: "1.0",
    title: target.title,
    mode: baselineArtifactKey ? "change" : "new",
    ...(baselineArtifactKey ? { extends: `artifact:${baselineArtifactKey}` } : {}),
    status: input.status,
    framework: input.framework,
    source: target.sourceArtifactKeys.map((artifactKey) => `artifact:${artifactKey}`),
    screens: input.screens,
    components: [],
    acceptance_criteria: input.acceptanceCriteria.map((criterion) => ({
      id: criterion.id,
      requirement: criterion.requirement,
      design_response: criterion.designResponse,
    })),
    assumptions: [],
    open_questions: input.openQuestions,
    blockers: input.blockers.map((blocker) => ({
      id: blocker.id,
      decision: blocker.decision,
      owner: blocker.owner,
      next_action: blocker.nextAction,
    })),
    deferred_validations: input.deferredValidations.map((validation) => ({
      id: validation.id,
      owner: validation.owner,
      phase: validation.phase,
      prerequisite: validation.prerequisite,
      targets: validation.targets,
      checks: validation.checks,
      pass_criteria: validation.passCriteria,
      evidence_required: validation.evidenceRequired,
      evidence_types: validation.evidenceTypes,
      status: validation.status,
      release_impact: validation.releaseImpact,
      on_fail: validation.onFail,
      on_missing: validation.onMissing,
    })),
  };
  const coverage = input.acceptanceCriteria.map(({ id, designResponse }) => `${id}: ${designResponse}`);
  const stateBehavior = input.screens.map(({ id, layout, states }) => (
    `${id}: ${layout}; states: ${states.join(", ")}`
  ));
  const doNotInfer = [
    ...input.openQuestions.map((question) => `Open question: ${question}`),
    ...input.blockers.map(({ id, decision, owner }) => `${id}: ${decision}（owner: ${owner}）`),
  ];
  const deferred = input.deferredValidations.map((validation) => [
    `${validation.id}: prerequisite: ${validation.prerequisite}`,
    `targets: ${validation.targets.join(", ")}`,
    `checks: ${validation.checks.join(" | ")}`,
    `pass: ${validation.passCriteria}`,
    `evidence required: ${validation.evidenceRequired}`,
    `evidence types: ${validation.evidenceTypes.join(", ")}`,
    `release impact: ${validation.releaseImpact}`,
    `on fail: ${validation.onFail}`,
    `on missing: ${validation.onMissing}`,
  ].join("; "));
  const openDecisions = [
    ...input.blockers.map(({ id, decision, owner, nextAction }) => (
      `${id}: ${decision}; owner: ${owner}; next: ${nextAction}`
    )),
    ...input.openQuestions.map((question) => `Open question: ${question}`),
  ];
  return [
    "```json",
    JSON.stringify(contract, null, 2),
    "```",
    "",
    `# ${markdownHeadingText(target.title)}`,
    "",
    "## Intent",
    "",
    input.designSummary,
    "",
    "## Coverage",
    "",
    markdownBullets(coverage),
    "",
    "## Experience and layout",
    "",
    input.designSummary,
    "",
    "## States and behavior",
    "",
    markdownBullets(stateBehavior),
    "",
    "## Responsive behavior",
    "",
    input.responsiveBehavior,
    "",
    "## Components and assets",
    "",
    "No unverified component-library binding is declared; implementation must reuse verified repository primitives or keep the change local to this feature.",
    "",
    "## Accessibility and content",
    "",
    input.accessibilityAndContent,
    "",
    "## Validation",
    "",
    input.validationEvidence,
    "",
    "## Handoff to Software Engineer",
    "",
    "**Next owner:** Software Engineer",
    "",
    "### Build scope",
    "",
    markdownBullets(input.acceptanceCriteria.map(({ id }) => id)),
    "",
    "### Behavior to preserve",
    "",
    markdownBullets(input.behaviorToPreserve),
    "",
    "### Do not infer",
    "",
    markdownBullets(doNotInfer),
    "",
    "### Allowed design flexibility",
    "",
    markdownBullets(input.allowedDesignFlexibility),
    "",
    "### Validation evidence",
    "",
    markdownBullets([input.validationEvidence]),
    "",
    "### Deferred verification",
    "",
    markdownBullets(deferred),
    "",
    "### Open decisions and blockers",
    "",
    markdownBullets(openDecisions),
    "",
  ].join("\n");
}

interface NormalizedArchitectureScope {
  id: string;
  mode: "greenfield" | "brownfield";
  boundary: "existing" | "new";
  evidenceRefs: string[];
}

function normalizeArchitectureScopes(
  scopes: z.infer<typeof architectureCheckpointArgumentsSchema>["scopes"],
): NormalizedArchitectureScope[] {
  return scopes.map((scope, index) => ({
    id: `scope-${index + 1}`,
    mode: scope.boundary === "existing" ? "brownfield" : "greenfield",
    boundary: scope.boundary,
    evidenceRefs: [`${scope.name}: ${scope.evidence}`],
  }));
}

function assertConfiguredArchitectureProjectMode(
  configuredMode: StructuredArchitectureCheckpointTarget["configuredProjectMode"],
  scopes: readonly NormalizedArchitectureScope[],
): void {
  if (configuredMode === "auto") return;
  if (configuredMode === "greenfield" && scopes.some((scope) => (
    scope.mode !== "greenfield" || scope.boundary !== "new"
  ))) {
    throw new ProviderAgentToolError(
      "AGENT_ARCHITECTURE_PROJECT_MODE_MISMATCH",
      "当前规则簿指定 greenfield；所有 scope 必须是 greenfield/new",
    );
  }
  if (configuredMode === "brownfield" && scopes.some((scope) => (
    scope.mode !== "brownfield" || scope.boundary !== "existing"
  ))) {
    throw new ProviderAgentToolError(
      "AGENT_ARCHITECTURE_PROJECT_MODE_MISMATCH",
      "当前规则簿指定 brownfield；所有 scope 必须是 brownfield/existing",
    );
  }
  if (configuredMode === "hybrid") {
    const hasExisting = scopes.some(({ boundary }) => boundary === "existing");
    const hasNew = scopes.some(({ boundary }) => boundary === "new");
    const incompatible = scopes.some((scope) => (
      (scope.boundary === "existing" && scope.mode === "greenfield")
      || (scope.boundary === "new" && scope.mode === "brownfield")
    ));
    if (!hasExisting || !hasNew || incompatible) {
      throw new ProviderAgentToolError(
        "AGENT_ARCHITECTURE_PROJECT_MODE_MISMATCH",
        "当前规则簿指定 hybrid；必须同时声明 existing 与 new scope，且 scope mode 与边界一致",
      );
    }
  }
}

function renderStructuredArchitectureCheckpoint(
  target: StructuredArchitectureCheckpointTarget,
  input: z.infer<typeof architectureCheckpointArgumentsSchema>,
): { discovery: string; options: string; architecture: string } {
  const packIds = [
    "api", "data", "integration", "security", "observability", "frontend",
  ] as const;
  const scopes = normalizeArchitectureScopes(input.scopes);
  const applicablePackIds = new Set(input.applicablePackIds);
  const scopeIds = scopes.map(({ id }) => id);
  const reviewedEvidence = scopes.flatMap(({ evidenceRefs }) => evidenceRefs).join("; ");
  const packById = new Map(packIds.map((id) => [id, {
    id,
    status: applicablePackIds.has(id) ? "applicable" as const : "not_applicable" as const,
    triggerEvidenceRefs: applicablePackIds.has(id)
      ? [`Architect marked ${id} applicable to ${scopeIds.join(", ")}; reviewed evidence: ${reviewedEvidence}`]
      : [`Architect marked ${id} not applicable to the bounded scopes; reviewed evidence: ${reviewedEvidence}`],
    affectedScopeIds: applicablePackIds.has(id) ? scopeIds : [],
  }]));
  const optionIds = input.options.map((_, index) => String.fromCharCode(65 + index));
  const recommendedOptionId = optionIds[input.recommendedOptionNumber - 1]!;
  const applicableRules = target.rules.filter((rule) => (
    packById.get(rule.packId)?.status === "applicable"
  ));
  const discoveryPacks = packIds.map((id) => {
    const pack = packById.get(id)!;
    return {
      id,
      status: pack.status,
      triggerEvidenceRefs: pack.triggerEvidenceRefs,
      affectedScopeIds: pack.status === "applicable" ? pack.affectedScopeIds : [],
      loadedPath: pack.status === "applicable" ? `rules/${id}.md` : null,
      blockerOwner: null,
    };
  });
  const optionRules = applicableRules.map((rule) => ({
    ruleId: rule.id,
    state: "constrains" as const,
    affectedOptionIds: optionIds,
    evidenceRefs: [
      `Current ${rule.packId} rule ${rule.id} is conservatively applied across documented options ${optionIds.join(", ")}.`,
    ],
  }));
  const architecturePacks = packIds.map((id) => {
    const pack = packById.get(id)!;
    return {
      id,
      status: pack.status,
      ruleIds: pack.status === "applicable"
        ? target.rules.filter((rule) => rule.packId === id).map((rule) => rule.id)
        : [],
      justifiedDeviationRuleIds: [],
      exceptionRuleIds: [],
      blockedRuleIds: [],
    };
  });
  const machineContract = (value: unknown): string => [
    "<!-- ai-sdlc:architecture-rulebook:v1 -->",
    "```json",
    JSON.stringify(value, null, 2),
    "```",
  ].join("\n");
  const discovery = [
    `# Architecture Discovery Context: ${markdownHeadingText(target.title)}`,
    "",
    "## Context summary",
    "",
    input.contextSummary,
    "",
    "## Affected scopes",
    "",
    "| Scope | Mode | Boundary | Evidence |",
    "|---|---|---|---|",
    ...scopes.map((scope) => (
      `| ${markdownTableCell(scope.id)} | ${scope.mode} | ${scope.boundary} | ${markdownTableCell(scope.evidenceRefs.join("; "))} |`
    )),
    "",
    "## Rule pack applicability",
    "",
    ...discoveryPacks.map((pack) => (
      `- **${pack.id}:** ${pack.status}; ${pack.triggerEvidenceRefs.join("; ")}`
    )),
    "",
    machineContract({
      schemaVersion: 1,
      document: "discovery",
      catalogDigest: target.catalogDigest,
      scopes,
      packs: discoveryPacks,
    }),
    "",
  ].join("\n");
  const options = [
    `# Architecture Options: ${markdownHeadingText(target.title)}`,
    "",
    "**Status:** Awaiting human selection",
    "",
    "## Problem and constraints",
    "",
    input.problem,
    "",
    markdownBullets(input.constraints),
    "",
    "## Rule Constraints",
    "",
    applicableRules.length > 0
      ? markdownBullets(applicableRules.map((rule) => `${rule.id} (${rule.packId}) constrains every documented option.`))
      : "- No conditional rule pack is applicable to the bounded scope; core role invariants still apply.",
    "",
    ...input.options.flatMap((option, index) => [
      `## Option ${optionIds[index]}: ${markdownHeadingText(option.title)}`,
      "",
      option.coreIdea,
      "",
      `- **Optimizes:** ${singleLine(option.optimizes)}`,
      `- **Gives up:** ${singleLine(option.givesUp)}`,
      `- **Hardest constraint:** ${singleLine(option.hardestConstraint)}`,
      `- **Rule fit:** ${applicableRules.length > 0
        ? `Constrained by current applicable rule packs: ${[...applicablePackIds].join(", ")}.`
        : "No conditional rule pack was marked applicable; core role invariants still apply."}`,
      "",
    ]),
    "## Architect recommendation",
    "",
    `推荐 Option ${recommendedOptionId} 供人工考虑；这不是人工选型记录。${input.recommendationReason}`,
    "",
    machineContract({
      schemaVersion: 1,
      document: "options",
      catalogDigest: target.catalogDigest,
      rules: optionRules,
    }),
    "",
  ].join("\n");
  const architecture = [
    `# Architecture Pack: ${markdownHeadingText(target.title)}`,
    "",
    "**Status:** Awaiting human selection",
    "",
    "## Decision boundary",
    "",
    input.problem,
    "",
    "No option has been selected by a human. The final architecture, ADRs, C4 views, NFRs and adversarial review must be generated only after a selection is bound to the current options revision.",
    "",
    "## Rulebook conformance",
    "",
    ...architecturePacks.map((pack) => (
      `- **${pack.id}:** ${pack.status}; rules: ${pack.ruleIds.join(", ") || "none"}`
    )),
    "",
    "## Next step",
    "",
    `Review Options ${optionIds.join(", ")} and record exactly one human selection against this options revision.`,
    "",
    machineContract({
      schemaVersion: 1,
      document: "architecture",
      catalogDigest: target.catalogDigest,
      state: "awaiting_selection",
      selection: null,
      packs: architecturePacks,
    }),
    "",
  ].join("\n");
  return { discovery, options, architecture };
}

function singleLine(value: string): string {
  return value.replace(/\r?\n/gu, " ").trim();
}

function markdownTableCell(value: string): string {
  return singleLine(value).replace(/\|/gu, "\\|");
}

function markdownBullets(values: readonly string[]): string {
  if (values.length === 0) return "- None";
  return values.map((value) => `- ${value.replace(/\r?\n/gu, " ").trim()}`).join("\n");
}

function markdownHeadingText(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function designStringArrayToolSchema(
  minItems: number,
  maxItems: number,
  maxLength = 4_000,
): Record<string, unknown> {
  return {
    type: "array",
    minItems,
    maxItems,
    items: { type: "string", minLength: 6, maxLength },
  };
}

function architectureStringArrayToolSchema(
  minItems: number,
  maxItems: number,
  maxLength: number,
  minLength = 6,
): Record<string, unknown> {
  return {
    type: "array",
    minItems,
    maxItems,
    items: { type: "string", minLength, maxLength },
  };
}

const LIST_FILES_TOOL: AskLlmFunctionTool = {
  type: "function",
  name: "list_files",
  description: "列出当前 Session Sandbox 中某个目录下的文件。path 使用仓库相对路径，根目录写成 .；不会跟随符号链接。",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path", "maxDepth", "maxEntries"],
    properties: {
      path: { type: "string" },
      maxDepth: { type: "integer", minimum: 1, maximum: 8 },
      maxEntries: { type: "integer", minimum: 1, maximum: 500 },
    },
  },
};

const READ_FILE_TOOL: AskLlmFunctionTool = {
  type: "function",
  name: "read_file",
  description: "按行读取当前 Session Sandbox 内一个 UTF-8 文本文件。每次最多返回 400 行；Secret 会被隐藏。",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path", "startLine", "endLine"],
    properties: {
      path: { type: "string" },
      startLine: { type: "integer", minimum: 1 },
      endLine: { type: "integer", minimum: 1 },
    },
  },
};

const SEARCH_TEXT_TOOL: AskLlmFunctionTool = {
  type: "function",
  name: "search_text",
  description: "在当前 Session Sandbox 的文本源码中做字面量搜索，不支持正则，不读取敏感或生成目录。",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path", "query", "caseSensitive", "maxResults"],
    properties: {
      path: { type: "string" },
      query: { type: "string" },
      caseSensitive: { type: "boolean" },
      maxResults: { type: "integer", minimum: 1, maximum: 200 },
    },
  },
};

const WRITE_FILE_TOOL: AskLlmFunctionTool = {
  type: "function",
  name: "write_file",
  description: "在可写主仓库的 Session Sandbox 内创建或完整写入一个 UTF-8 文本文件；平台会在已授权写入范围内安全创建缺失父目录。不能写 Secret 或越出根目录。",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path", "content", "overwrite"],
    properties: {
      path: { type: "string" },
      content: { type: "string" },
      overwrite: { type: "boolean" },
    },
  },
};

const CREATE_DIRECTORY_TOOL: AskLlmFunctionTool = {
  type: "function",
  name: "create_directory",
  description: "在可写主仓库的 Session Sandbox 内安全创建仓库相对目录；可逐级创建缺失父目录，不能越出本阶段写入范围。",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string" },
    },
  },
};

const APPLY_PATCH_TOOL: AskLlmFunctionTool = {
  type: "function",
  name: "apply_patch",
  description: "在可写主仓库的 Session Sandbox 内用精确 oldText 替换应用小补丁。默认 oldText 必须只出现一次。",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path", "oldText", "newText", "replaceAll"],
    properties: {
      path: { type: "string" },
      oldText: { type: "string" },
      newText: { type: "string" },
      replaceAll: { type: "boolean" },
    },
  },
};

const WRITE_DESIGN_SPEC_TOOL: AskLlmFunctionTool = {
  type: "function",
  name: "write_design_spec",
  description: "为本阶段已选择的 design-spec 确定性生成合法 machine JSON 与完整工程交接。不要提供 path、Markdown 或 JSON 字符串；只提交真实设计字段，平台负责转义、模板结构和 overwrite。",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: [
      "status",
      "framework",
      "screens",
      "acceptanceCriteria",
      "openQuestions",
      "blockers",
      "deferredValidations",
      "designSummary",
      "responsiveBehavior",
      "accessibilityAndContent",
      "validationEvidence",
      "behaviorToPreserve",
      "allowedDesignFlexibility",
    ],
    properties: {
      status: { type: "string", enum: ["blocked", "ready-for-engineering"] },
      framework: { type: "string", minLength: 2, maxLength: 800 },
      screens: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "layout", "states"],
          properties: {
            id: { type: "string", minLength: 2, maxLength: 80 },
            layout: { type: "string", minLength: 6, maxLength: 4_000 },
            states: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              items: { type: "string", minLength: 2, maxLength: 800 },
            },
          },
        },
      },
      acceptanceCriteria: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "requirement", "designResponse"],
          properties: {
            id: { type: "string", minLength: 3, maxLength: 80 },
            requirement: { type: "string", minLength: 6, maxLength: 4_000 },
            designResponse: { type: "string", minLength: 6, maxLength: 4_000 },
          },
        },
      },
      openQuestions: designStringArrayToolSchema(0, 20),
      blockers: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "decision", "owner", "nextAction"],
          properties: {
            id: { type: "string", minLength: 3, maxLength: 80 },
            decision: { type: "string", minLength: 6, maxLength: 4_000 },
            owner: { type: "string", minLength: 2, maxLength: 800 },
            nextAction: { type: "string", minLength: 6, maxLength: 4_000 },
          },
        },
      },
      deferredValidations: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id", "owner", "phase", "prerequisite", "targets", "checks",
            "passCriteria", "evidenceRequired", "evidenceTypes", "status",
            "releaseImpact", "onFail", "onMissing",
          ],
          properties: {
            id: { type: "string", minLength: 3, maxLength: 80 },
            owner: { type: "string", enum: ["tester"] },
            phase: { type: "string", enum: ["verification"] },
            prerequisite: { type: "string", minLength: 6, maxLength: 4_000 },
            targets: designStringArrayToolSchema(1, 20, 800),
            checks: designStringArrayToolSchema(1, 20),
            passCriteria: { type: "string", minLength: 6, maxLength: 4_000 },
            evidenceRequired: { type: "string", minLength: 6, maxLength: 4_000 },
            evidenceTypes: {
              type: "array",
              minItems: 1,
              maxItems: 6,
              items: {
                type: "string",
                enum: [
                  "browser-run", "screenshot", "keyboard-log",
                  "accessibility-report", "contrast-report", "motion-evidence",
                ],
              },
            },
            status: { type: "string", enum: ["deferred"] },
            releaseImpact: { type: "string", minLength: 6, maxLength: 4_000 },
            onFail: { type: "string", enum: ["block_verification"] },
            onMissing: { type: "string", enum: ["block_verification"] },
          },
        },
      },
      designSummary: { type: "string", minLength: 6, maxLength: 4_000 },
      responsiveBehavior: { type: "string", minLength: 6, maxLength: 4_000 },
      accessibilityAndContent: { type: "string", minLength: 6, maxLength: 4_000 },
      validationEvidence: { type: "string", minLength: 6, maxLength: 4_000 },
      behaviorToPreserve: designStringArrayToolSchema(1, 20),
      allowedDesignFlexibility: designStringArrayToolSchema(1, 20),
    },
  },
};

const WRITE_ARCHITECTURE_CHECKPOINT_TOOL: AskLlmFunctionTool = {
  type: "function",
  name: "write_architecture_checkpoint",
  description: "为本阶段已选择的 discovery/options/architecture 三份 Architect 检查点确定性生成同一规则簿 revision 的机器合同。不要提供 path、Markdown、JSON、digest、规则 ID、scope ID 或 option ID；只提交真实范围、适用规则包 ID 与至少三个可比较方案，平台会补全固定结构。",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: [
      "contextSummary", "problem", "constraints", "scopes", "applicablePackIds",
      "options", "recommendedOptionNumber", "recommendationReason",
    ],
    properties: {
      contextSummary: { type: "string", minLength: 2, maxLength: 4_000 },
      problem: { type: "string", minLength: 2, maxLength: 4_000 },
      constraints: architectureStringArrayToolSchema(1, 30, 4_000, 2),
      scopes: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "boundary", "evidence"],
          properties: {
            name: { type: "string", minLength: 2, maxLength: 800 },
            boundary: { type: "string", enum: ["existing", "new"] },
            evidence: { type: "string", minLength: 2, maxLength: 500 },
          },
        },
      },
      applicablePackIds: {
        type: "array",
        maxItems: 6,
        items: {
          type: "string",
          enum: ["api", "data", "integration", "security", "observability", "frontend"],
        },
      },
      options: {
        type: "array",
        minItems: 3,
        maxItems: 6,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "coreIdea", "optimizes", "givesUp", "hardestConstraint"],
          properties: {
            title: { type: "string", minLength: 2, maxLength: 800 },
            coreIdea: { type: "string", minLength: 2, maxLength: 4_000 },
            optimizes: { type: "string", minLength: 2, maxLength: 4_000 },
            givesUp: { type: "string", minLength: 2, maxLength: 4_000 },
            hardestConstraint: { type: "string", minLength: 2, maxLength: 4_000 },
          },
        },
      },
      recommendedOptionNumber: { type: "integer", minimum: 1, maximum: 6 },
      recommendationReason: { type: "string", minLength: 2, maxLength: 4_000 },
    },
  },
};

const WRITE_ENGINEERING_EVIDENCE_PACK_TOOL: AskLlmFunctionTool = {
  type: "function",
  name: "write_engineering_evidence_pack",
  description: "一次完整写入本 Software Engineer 阶段已绑定的七份工程证据。不要提交 path；先完成真实源码/内容修改，再按 canonical templates 提交七个完整 Markdown 字段。平台负责固定路径和 overwrite。",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: [
      "implementationNotes",
      "implementationPlan",
      "implementationTasks",
      "sessionLog",
      "independentTestEvidence",
      "review",
      "provenance",
    ],
    properties: {
      implementationNotes: { type: "string", minLength: 1, maxLength: 48_000 },
      implementationPlan: { type: "string", minLength: 1, maxLength: 48_000 },
      implementationTasks: { type: "string", minLength: 1, maxLength: 48_000 },
      sessionLog: { type: "string", minLength: 1, maxLength: 48_000 },
      independentTestEvidence: { type: "string", minLength: 1, maxLength: 48_000 },
      review: { type: "string", minLength: 1, maxLength: 48_000 },
      provenance: { type: "string", minLength: 1, maxLength: 48_000 },
    },
  },
};

const USER_STORIES_BLOCKER_TOOL: AskLlmFunctionTool = {
  type: "function",
  name: "write_user_stories_blocker",
  description: "当产品或业务事实不足以诚实生成 User Story 时，一次汇总当前全部具体缺失事实和开放问题，并提交人工负责人和可执行下一步；不得把同一阶段拆成一问一轮。字段不得引用已有 Blocker、README/Story 文件、路径、sentinel、工具错误或平台迁移顺序。负责人可使用 PM、PO、BA、QA 等明确角色缩写。平台会在本阶段已选择的 user-stories 根目录确定性生成唯一 versioned Blocker README；不要自行提供路径、Markdown、标题或 sentinel。",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: [
      "status",
      "missingFacts",
      "openQuestions",
      "humanOwner",
      "nextStep",
    ],
    properties: {
      status: { type: "string", enum: ["Blocked", "Pending"] },
      missingFacts: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: { type: "string", minLength: 6, maxLength: 800 },
      },
      openQuestions: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: { type: "string", minLength: 6, maxLength: 800 },
      },
      humanOwner: { type: "string", minLength: 2, maxLength: 800 },
      nextStep: { type: "string", minLength: 6, maxLength: 800 },
    },
  },
};

function containsUserStoriesBlockerSentinelCandidate(content: string): boolean {
  return content.toLocaleLowerCase("en-US").includes(USER_STORIES_BLOCKER_SENTINEL);
}

function parseBrowsablePath(candidate: string): string {
  const normalizedRootAlias = candidate.trim();
  // Local models commonly express the repository root as `/` or `./` even
  // though every concrete file path must remain repository-relative. Treat
  // only these exact browse-only aliases as `.`, never an absolute child path.
  if ([".", "./", "/"].includes(normalizedRootAlias)) return ".";
  return parseRepositoryPath(candidate);
}

function safeBlockerDraftField(details: unknown): string | null {
  if (!details || typeof details !== "object" || !("field" in details)) return null;
  const field = (details as { field?: unknown }).field;
  return typeof field === "string" && blockerDraftFields.has(field) ? field : null;
}

function safeBlockerDraftReason(details: unknown): string | null {
  if (!details || typeof details !== "object" || !("reason" in details)) return null;
  const reason = (details as { reason?: unknown }).reason;
  return reason === "BLOCKER_WORKFLOW_MECHANISM_FORBIDDEN" ? reason : null;
}

const blockerDraftFields = new Set([
  "Known facts",
  "Missing facts",
  "Open questions",
  "Human owner",
  "Next step",
]);

function parseRepositoryPath(candidate: string): string {
  const parsed = safeRepositoryRelativePathSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ProviderAgentToolError(
      "AGENT_PATH_INVALID",
      "工具路径必须是安全的仓库相对路径",
    );
  }
  const normalized = parsed.data.split("/").join(path.sep);
  if (isSensitiveRelativePath(parsed.data)) {
    throw new ProviderAgentToolError(
      "AGENT_SENSITIVE_PATH_FORBIDDEN",
      "该路径可能包含凭据或版本库内部数据，平台不会向模型暴露或写入",
    );
  }
  return normalized;
}

function isSensitiveRelativePath(candidate: string): boolean {
  const parts = candidate.toLocaleLowerCase("en-US").split(/[\\/]/u);
  const basename = parts.at(-1) ?? "";
  if (parts.some((part) => [
    ".git",
    ".ssh",
    ".aws",
    ".azure",
    ".docker",
    ".kube",
    ".gnupg",
    ".terraform.d",
  ].includes(part))) return true;
  if (/^\.env(?:\.|$)/u.test(basename) && !/^\.env\.(?:example|sample|template)$/u.test(basename)) {
    return true;
  }
  return /^(?:\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.yarnrc(?:\.yml)?|credentials(?:\.json|\.toml)?|id_(?:rsa|dsa|ecdsa|ed25519))$/u.test(basename)
    || /\.(?:pem|p12|pfx|key|keystore|jks)$/u.test(basename);
}

async function assertPathHasNoSymlink(
  rootPath: string,
  relative: string,
  allowMissingLeaf: boolean,
): Promise<void> {
  if (relative === ".") return;
  const components = relative.split(path.sep);
  let cursor = rootPath;
  for (let index = 0; index < components.length; index += 1) {
    cursor = path.join(cursor, components[index]!);
    try {
      const entry = await lstat(cursor);
      if (entry.isSymbolicLink()) {
        throw new ProviderAgentToolError(
          "AGENT_SYMLINK_FORBIDDEN",
          "工具路径包含符号链接，平台已拒绝访问",
        );
      }
    } catch (error) {
      if (
        allowMissingLeaf
        && index === components.length - 1
        && isNodeError(error)
        && error.code === "ENOENT"
      ) return;
      throw error;
    }
  }
}

async function walkTree(input: {
  absoluteRoot: string;
  relativeRoot: string;
  depth: number;
  maxDepth: number;
  maxEntries: number;
  entries: string[];
}): Promise<void> {
  if (input.entries.length >= input.maxEntries) return;
  const children = (await readdir(input.absoluteRoot, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const child of children) {
    if (input.entries.length >= input.maxEntries) return;
    const relative = input.relativeRoot === "." ? child.name : path.join(input.relativeRoot, child.name);
    if (isSensitiveRelativePath(relative)) continue;
    if (child.isSymbolicLink()) continue;
    if (child.isDirectory()) {
      if (SKIPPED_DIRECTORY_NAMES.has(child.name)) continue;
      input.entries.push(`${relative.split(path.sep).join("/")}/`);
      if (input.depth + 1 < input.maxDepth) {
        await walkTree({
          ...input,
          absoluteRoot: path.join(input.absoluteRoot, child.name),
          relativeRoot: relative,
          depth: input.depth + 1,
        });
      }
    } else if (child.isFile()) {
      const fileStat = await lstat(path.join(input.absoluteRoot, child.name));
      if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.nlink !== 1) continue;
      input.entries.push(`${relative.split(path.sep).join("/")} (${fileStat.size} bytes)`);
    }
  }
}

async function collectSourceFiles(
  absoluteRoot: string,
  relativeRoot: string,
): Promise<Array<{ absolute: string; relative: string }>> {
  const collected: Array<{ absolute: string; relative: string }> = [];
  async function visit(directory: string, relativeDirectory: string, depth: number): Promise<void> {
    if (depth > 10 || collected.length >= MAX_SEARCHED_FILES * 2) return;
    const children = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const child of children) {
      if (collected.length >= MAX_SEARCHED_FILES * 2) return;
      const relative = relativeDirectory === "."
        ? child.name
        : path.join(relativeDirectory, child.name);
      if (isSensitiveRelativePath(relative) || child.isSymbolicLink()) continue;
      if (child.isDirectory()) {
        if (SKIPPED_DIRECTORY_NAMES.has(child.name)) continue;
        await visit(path.join(directory, child.name), relative, depth + 1);
      } else if (child.isFile()) {
        const absolute = path.join(directory, child.name);
        const fileStat = await lstat(absolute);
        if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.nlink !== 1) continue;
        collected.push({
          absolute,
          relative: relative.split(path.sep).join("/"),
        });
      }
    }
  }
  await visit(absoluteRoot, relativeRoot, 0);
  return collected;
}

async function readUtf8Source(absolute: string): Promise<string> {
  const handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      throw new ProviderAgentToolError("AGENT_PATH_KIND_INVALID", "目标不是普通文件");
    }
    if (fileStat.nlink !== 1) {
      throw new ProviderAgentToolError(
        "AGENT_HARDLINK_FORBIDDEN",
        "目标文件使用了硬链接，平台已拒绝读取",
      );
    }
    if (fileStat.size > MAX_SOURCE_FILE_BYTES) {
      throw new ProviderAgentToolError("AGENT_FILE_TOO_LARGE", "文件超过单次源码读取上限");
    }
    const buffer = await handle.readFile();
    if (buffer.includes(0)) {
      throw new ProviderAgentToolError("AGENT_FILE_NOT_TEXT", "目标不是 UTF-8 文本文件");
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new ProviderAgentToolError("AGENT_FILE_NOT_TEXT", "目标不是 UTF-8 文本文件");
    }
  } finally {
    await handle.close();
  }
}

async function writeUtf8NoFollow(
  absolute: string,
  content: string,
  overwrite: boolean,
  signal: AbortSignal,
): Promise<void> {
  assertNotAborted(signal);
  const flags = fsConstants.O_WRONLY
    | fsConstants.O_CREAT
    | fsConstants.O_NOFOLLOW
    | (overwrite ? fsConstants.O_TRUNC : fsConstants.O_EXCL);
  const handle = await open(absolute, flags, 0o644);
  try {
    assertNotAborted(signal);
    await handle.writeFile(content, { encoding: "utf8" });
    assertNotAborted(signal);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function countOccurrences(source: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= source.length - needle.length) {
    const found = source.indexOf(needle, offset);
    if (found < 0) break;
    count += 1;
    offset = found + needle.length;
  }
  return count;
}

function validateCheckDefinitions(definitions: readonly AgentSandboxCheckDefinition[]): void {
  const ids = new Set<string>();
  if (definitions.length > 32) throw new Error("Sandbox check 数量超过上限");
  for (const definition of definitions) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u.test(definition.id)
      || ids.has(definition.id)
      || !definition.label.trim()
      || definition.label.length > 200
      || !Number.isSafeInteger(definition.timeoutMs)
      || definition.timeoutMs < 1_000
      || definition.timeoutMs > 10 * 60_000
    ) {
      throw new Error("Sandbox check 定义无效");
    }
    ids.add(definition.id);
  }
}

const DIRECT_SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu,
  /\bAKIA[A-Z0-9]{16}\b/gu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
];
const BEARER_SECRET_PATTERN = /(\bBearer[ \t]+)([A-Za-z0-9._~+/-]{12,}={0,2})/giu;
const LABELLED_SECRET_PATTERN = /((?:"?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|secret|password|auth|authorization)"?)\s*[:=]\s*["']?)([^\s"';,}]{12,})/giu;

export function containsLikelySecret(source: string): boolean {
  if (DIRECT_SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(source);
  })) return true;
  BEARER_SECRET_PATTERN.lastIndex = 0;
  for (const match of source.matchAll(BEARER_SECRET_PATTERN)) {
    const value = (match[2] ?? "").toLocaleLowerCase("en-US");
    if (!isClearlyNonSecretValue(value)) return true;
  }
  LABELLED_SECRET_PATTERN.lastIndex = 0;
  for (const match of source.matchAll(LABELLED_SECRET_PATTERN)) {
    const value = (match[2] ?? "").toLocaleLowerCase("en-US");
    if (!isClearlyNonSecretValue(value)) return true;
  }
  return false;
}

export function redactLikelySecrets(source: string): { text: string; redacted: boolean } {
  let text = source;
  for (const pattern of DIRECT_SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, "[REDACTED]");
  }
  BEARER_SECRET_PATTERN.lastIndex = 0;
  text = text.replace(BEARER_SECRET_PATTERN, "$1[REDACTED]");
  LABELLED_SECRET_PATTERN.lastIndex = 0;
  text = text.replace(LABELLED_SECRET_PATTERN, "$1[REDACTED]");
  return { text, redacted: text !== source };
}

function assertNoSecretMaterial(source: string): void {
  if (containsLikelySecret(source)) {
    throw new ProviderAgentToolError(
      "AGENT_SECRET_WRITE_FORBIDDEN",
      "写入内容包含疑似真实 Secret，平台已拒绝；请只写变量名或占位符",
    );
  }
}

function boundedText(source: string, maxCharacters: number): string {
  if (source.length <= maxCharacters) return source;
  const marker = "\n…（输出已达到平台上限）";
  if (maxCharacters <= marker.length) return marker.slice(0, maxCharacters);
  return `${source.slice(0, maxCharacters - marker.length)}${marker}`;
}

function isClearlyNonSecretValue(value: string): boolean {
  return /^(?:process\.env\b|import\.meta\.env\b|os\.getenv\b|system\.getenv\b|env\.|config\.get\b|\$\{|<|\[|your[_-]|example|placeholder|change[_-]?me|dummy|test[_-]?only|[a-z_$][\w$]*\([^)]*\)|[a-z_$][\w$]*(?:\.[a-z_$][\w$]*)+)/u.test(value);
}

function safeFileError(error: unknown): string {
  if (isNodeError(error)) {
    if (error.code === "ENOENT") return "目标路径不存在，未执行";
    if (error.code === "EACCES" || error.code === "EPERM") return "Sandbox 拒绝访问该路径";
    if (error.code === "EEXIST") return "目标文件已存在，未覆盖";
    if (error.code === "ELOOP") return "路径包含符号链接，平台已拒绝";
  }
  return "Sandbox 工具执行失败；内部路径和错误细节未暴露给模型";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ProviderAgentToolError("AGENT_TOOL_CANCELLED", "工具执行已取消");
  }
}
