import { createHash } from "node:crypto";

import YAML from "yaml";
import { z } from "zod";

import { AppError } from "../domain/errors.js";

export const architectureRulePackIds = [
  "api",
  "data",
  "integration",
  "security",
  "observability",
  "frontend",
] as const;

export type ArchitectureRulePackId = typeof architectureRulePackIds[number];
export type ArchitectureRuleLevel = "MUST" | "DEFAULT" | "WHEN" | "FORBIDDEN";
export type ArchitectureRuleDeviationPolicy = "not_applicable" | "reason_allowed" | "adr_required";
export type ArchitectureRulebookValidationMode = "required" | "advisory";
export type ArchitectureRulebookProjectMode = "auto" | "greenfield" | "brownfield" | "hybrid";

export interface ArchitectureRulebookSource {
  indexMarkdown: string;
  packMarkdownByPath: Readonly<Record<string, string | undefined>>;
  projectMode: ArchitectureRulebookProjectMode;
}

export interface ArchitectureAdrFile {
  relativePath: string;
  content: string;
}

export interface ArchitectureRulebookValidationInput {
  validation?: ArchitectureRulebookValidationMode;
  stage: "checkpoint" | "final";
  rulebook?: ArchitectureRulebookSource;
  discoveryContext?: string;
  architectureOptions?: string;
  architectureIndex?: string;
  architecturePatterns?: string;
  architectureC4Context?: string;
  architectureC4Containers?: string;
  architectureAdrs?: string;
  architectureAdrFiles?: ReadonlyArray<ArchitectureAdrFile>;
  architectureAdrsRevisionSource?: "ai" | "human";
  architectureNfrs?: string;
  architectureAdversarial?: string;
  documentedOptionIds?: string[];
  architectureSelection?: {
    optionId: string;
    reviewId: string;
    optionsArtifactId: string;
    selectedAt: string;
  };
}

export interface ArchitectureRule {
  id: string;
  level: ArchitectureRuleLevel;
  deviationPolicy: ArchitectureRuleDeviationPolicy;
  packId: ArchitectureRulePackId;
  sourcePath: string;
}

export interface ArchitectureRulebookIssue {
  code: string;
  message: string;
  document?: string;
  packId?: string;
  ruleId?: string;
}

export interface ArchitectureRulebookValidationResult {
  enabled: boolean;
  rules: ArchitectureRule[];
  issues: ArchitectureRulebookIssue[];
}

const contractSentinel = "<!-- ai-sdlc:architecture-rulebook:v1 -->";
const contractBytesLimit = 64 * 1024;
const packSpecs: ReadonlyArray<{ id: ArchitectureRulePackId; path: string }> = architectureRulePackIds.map(
  (id) => ({ id, path: `rules/${id}.md` }),
);
const ruleIdSchema = z.string().regex(/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/u);
const scopeIdSchema = z.string().regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u);
const optionIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const substantiveEvidenceRefSchema = z.string().trim().min(1).max(500).refine(
  isSubstantiveEvidenceRef,
  "evidence reference must not be a placeholder or unresolved value",
);
const evidenceRefsSchema = z.array(substantiveEvidenceRefSchema).min(1).max(50);
const packStatusSchema = z.enum(["applicable", "not_applicable", "blocked"]);
const selectionEvidenceSchema = z.object({
  optionId: optionIdSchema,
  reviewId: z.string().uuid(),
  optionsArtifactId: z.string().uuid(),
  selectedAt: z.string().datetime({ offset: true }),
}).strict();

const discoveryContractSchema = z.object({
  schemaVersion: z.literal(1),
  document: z.literal("discovery"),
  catalogDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  scopes: z.array(z.object({
    id: scopeIdSchema,
    mode: z.enum(["greenfield", "brownfield", "hybrid", "blocked"]),
    boundary: z.enum(["existing", "new"]),
    evidenceRefs: evidenceRefsSchema,
  }).strict()).min(1).max(100),
  packs: z.array(z.object({
    id: z.enum(architectureRulePackIds),
    status: packStatusSchema,
    triggerEvidenceRefs: evidenceRefsSchema,
    affectedScopeIds: z.array(scopeIdSchema).max(100),
    loadedPath: z.string().trim().min(1).nullable(),
    blockerOwner: z.string().trim().min(1).nullable(),
  }).strict()).length(architectureRulePackIds.length),
}).strict();

const optionsContractSchema = z.object({
  schemaVersion: z.literal(1),
  document: z.literal("options"),
  catalogDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  rules: z.array(z.object({
    ruleId: ruleIdSchema,
    state: z.enum(["constrains", "not_triggered", "blocked"]),
    affectedOptionIds: z.array(optionIdSchema).max(100),
    evidenceRefs: evidenceRefsSchema,
  }).strict()).max(500),
}).strict();

const architectureContractSchema = z.object({
  schemaVersion: z.literal(1),
  document: z.literal("architecture"),
  catalogDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  state: z.enum(["awaiting_selection", "ready_for_human_acceptance", "blocked"]),
  selection: selectionEvidenceSchema.nullable(),
  packs: z.array(z.object({
    id: z.enum(architectureRulePackIds),
    status: packStatusSchema,
    ruleIds: z.array(ruleIdSchema).max(500),
    justifiedDeviationRuleIds: z.array(ruleIdSchema).max(500),
    exceptionRuleIds: z.array(ruleIdSchema).max(500),
    blockedRuleIds: z.array(ruleIdSchema).max(500),
  }).strict()).length(architectureRulePackIds.length),
}).strict();

const patternsContractSchema = z.object({
  schemaVersion: z.literal(1),
  document: z.literal("patterns"),
  catalogDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  selection: selectionEvidenceSchema,
  dispositions: z.array(z.object({
    ruleId: ruleIdSchema,
    scopeId: scopeIdSchema,
    state: z.enum(["satisfied", "not_triggered", "justified_deviation", "exception", "blocked"]),
    evidenceRefs: evidenceRefsSchema,
    decisionRef: z.string().trim().min(1).nullable(),
  }).strict()).max(500),
}).strict();

type DiscoveryContract = z.infer<typeof discoveryContractSchema>;
type OptionsContract = z.infer<typeof optionsContractSchema>;
type ArchitectureContract = z.infer<typeof architectureContractSchema>;
type PatternsContract = z.infer<typeof patternsContractSchema>;

export function inspectArchitectureRulebook(
  input: ArchitectureRulebookValidationInput,
): ArchitectureRulebookValidationResult {
  if (input.validation !== "required") return { enabled: false, rules: [], issues: [] };

  const issues: ArchitectureRulebookIssue[] = [];
  const rules = parseRuleCatalog(input.rulebook, issues);
  const catalogDigest = input.rulebook
    ? calculateArchitectureRulebookDigest(input.rulebook)
    : undefined;
  const discovery = parseContract(
    input.discoveryContext,
    "discovery",
    discoveryContractSchema,
    issues,
  );
  const options = parseContract(
    input.architectureOptions,
    "options",
    optionsContractSchema,
    issues,
  );
  const architecture = parseContract(
    input.architectureIndex,
    "architecture",
    architectureContractSchema,
    issues,
  );
  const patterns = input.stage === "final"
    ? parseContract(
        input.architecturePatterns,
        "patterns",
        patternsContractSchema,
        issues,
      )
    : undefined;

  if (discovery && options && architecture && rules.length > 0 && catalogDigest) {
    validateCrossArtifactContract(
      input,
      rules,
      catalogDigest,
      discovery,
      options,
      architecture,
      patterns,
      issues,
    );
  }
  return { enabled: true, rules, issues };
}

export function calculateArchitectureRulebookDigest(source: ArchitectureRulebookSource): string {
  const entries = [
    ["config.project_mode", source.projectMode ?? "auto"] as const,
    ["architecture-rules.md", source.indexMarkdown] as const,
    ["rules/core.md", source.packMarkdownByPath["rules/core.md"] ?? ""] as const,
    ...packSpecs.map((spec) => [spec.path, source.packMarkdownByPath[spec.path] ?? ""] as const),
  ];
  const hash = createHash("sha256");
  for (const [relativePath, content] of entries) {
    hash.update(relativePath, "utf8");
    hash.update("\0", "utf8");
    hash.update(content.replace(/\r\n?/gu, "\n"), "utf8");
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

export function validateArchitectureRulebook(
  input: ArchitectureRulebookValidationInput,
): ArchitectureRulebookValidationResult {
  const result = inspectArchitectureRulebook(input);
  if (result.issues.length > 0) {
    throw new AppError(
      "架构规则簿语义校验失败",
      409,
      "ARCHITECTURE_RULEBOOK_INVALID",
      { stage: input.stage, issues: result.issues },
    );
  }
  return result;
}

function parseRuleCatalog(
  source: ArchitectureRulebookSource | undefined,
  issues: ArchitectureRulebookIssue[],
): ArchitectureRule[] {
  if (!source) {
    addIssue(issues, "RULEBOOK_REQUIRED", "项目要求规则簿校验，但规则簿源文件不可用");
    return [];
  }

  const rules: ArchitectureRule[] = [];
  if (!source.indexMarkdown.toLowerCase().includes("](rules/core.md)")) {
    addIssue(issues, "RULEBOOK_CORE_ROUTE_MISSING", "规则簿索引缺少 always-loaded core 路由");
  }
  if (typeof source.packMarkdownByPath["rules/core.md"] !== "string") {
    addIssue(issues, "RULEBOOK_CORE_MISSING", "规则簿缺少 rules/core.md");
  }
  for (const spec of packSpecs) {
    const expectedLink = `](rules/${spec.id}.md)`;
    if (!source.indexMarkdown.toLowerCase().includes(expectedLink)) {
      addIssue(
        issues,
        "RULEBOOK_ROUTE_MISSING",
        `规则簿索引缺少 ${spec.id} 规则包路由`,
        { packId: spec.id },
      );
    }
    const markdown = source.packMarkdownByPath[spec.path];
    if (typeof markdown !== "string") {
      addIssue(
        issues,
        "RULEBOOK_PACK_MISSING",
        `规则包 ${spec.path} 不存在`,
        { packId: spec.id },
      );
      continue;
    }
    rules.push(...parseRulePack(spec.id, spec.path, markdown, issues));
  }

  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.id)) {
      addIssue(
        issues,
        "RULEBOOK_RULE_DUPLICATE",
        `规则 ID ${rule.id} 重复`,
        { ruleId: rule.id, packId: rule.packId },
      );
    }
    seen.add(rule.id);
  }
  return rules;
}

function parseRulePack(
  packId: ArchitectureRulePackId,
  sourcePath: string,
  markdown: string,
  issues: ArchitectureRulebookIssue[],
): ArchitectureRule[] {
  const lines = markdown.split(/\r?\n/u);
  const headerIndex = lines.findIndex((line) => {
    const cells = markdownCells(line);
    return cells[0]?.toLowerCase() === "id"
      && cells[1]?.toLowerCase() === "level"
      && cells[2]?.toLowerCase() === "deviation";
  });
  if (headerIndex < 0) {
    addIssue(
      issues,
      "RULEBOOK_RULE_TABLE_MISSING",
      `规则包 ${sourcePath} 缺少 ID / Level / Deviation 规则表`,
      { packId },
    );
    return [];
  }

  const rules: ArchitectureRule[] = [];
  for (let index = headerIndex + 2; index < lines.length; index += 1) {
    if (!lines[index]!.trim().startsWith("|")) break;
    const cells = markdownCells(lines[index]!);
    if (cells.length < 3) continue;
    const id = stripMarkdown(cells[0] ?? "").toUpperCase();
    const level = stripMarkdown(cells[1] ?? "").toUpperCase();
    const deviationPolicy = parseDeviationPolicy(stripMarkdown(cells[2] ?? ""));
    if (
      !ruleIdSchema.safeParse(id).success
      || !isRuleLevel(level)
      || deviationPolicy === undefined
      || (level === "DEFAULT") !== (deviationPolicy !== "not_applicable")
    ) {
      addIssue(
        issues,
        "RULEBOOK_RULE_INVALID",
        `规则包 ${sourcePath} 第 ${index + 1} 行的 ID 或 Level 无效`,
        { packId, ruleId: id || undefined },
      );
      continue;
    }
    rules.push({ id, level, deviationPolicy, packId, sourcePath });
  }
  if (rules.length === 0) {
    addIssue(
      issues,
      "RULEBOOK_PACK_EMPTY",
      `规则包 ${sourcePath} 没有可执行规则`,
      { packId },
    );
  }
  return rules;
}

function parseContract<T>(
  markdown: string | undefined,
  document: string,
  schema: z.ZodType<T>,
  issues: ArchitectureRulebookIssue[],
): T | undefined {
  if (typeof markdown !== "string") {
    addIssue(issues, "CONTRACT_DOCUMENT_MISSING", `缺少 ${document} 产物内容`, { document });
    return undefined;
  }
  const sentinelCount = markdown.split(contractSentinel).length - 1;
  if (sentinelCount !== 1) {
    addIssue(
      issues,
      sentinelCount === 0 ? "CONTRACT_MISSING" : "CONTRACT_DUPLICATE",
      `${document} 必须且只能包含一个规则簿 v1 机器块`,
      { document },
    );
    return undefined;
  }
  const escapedSentinel = contractSentinel.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = markdown.match(new RegExp(
    `${escapedSentinel}[ \\t]*\\r?\\n\`\`\`json[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n\`\`\``,
    "u",
  ));
  if (!match?.[1]) {
    addIssue(
      issues,
      "CONTRACT_FORMAT_INVALID",
      `${document} 的 sentinel 后必须紧邻一个 json fenced block`,
      { document },
    );
    return undefined;
  }
  if (Buffer.byteLength(match[1], "utf8") > contractBytesLimit) {
    addIssue(issues, "CONTRACT_TOO_LARGE", `${document} 机器块超过 64 KiB`, { document });
    return undefined;
  }

  let value: unknown;
  try {
    value = JSON.parse(match[1]);
    const parsed = YAML.parseDocument(match[1], { schema: "json", uniqueKeys: true });
    if (parsed.errors.length > 0) throw parsed.errors[0];
    parsed.toJS({ maxAliasCount: 0 });
  } catch (error) {
    addIssue(
      issues,
      "CONTRACT_JSON_INVALID",
      `${document} 机器块不是无重复键的有效 JSON：${error instanceof Error ? error.message : String(error)}`,
      { document },
    );
    return undefined;
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    addIssue(
      issues,
      "CONTRACT_SCHEMA_INVALID",
      `${document} 机器块不符合 v1 schema`,
      { document },
    );
    return undefined;
  }
  return result.data;
}

function validateCrossArtifactContract(
  input: ArchitectureRulebookValidationInput,
  rules: ArchitectureRule[],
  catalogDigest: string,
  discovery: DiscoveryContract,
  options: OptionsContract,
  architecture: ArchitectureContract,
  patterns: PatternsContract | undefined,
  issues: ArchitectureRulebookIssue[],
): void {
  for (const [document, digest] of [
    ["discovery", discovery.catalogDigest],
    ["options", options.catalogDigest],
    ["architecture", architecture.catalogDigest],
    ...(patterns ? [["patterns", patterns.catalogDigest] as const] : []),
  ] as const) {
    if (digest !== catalogDigest) {
      addIssue(issues, "RULEBOOK_DIGEST_MISMATCH", `${document} 的 catalogDigest 与当前规则簿不一致，必须重新生成并重新选型`, {
        document,
      });
    }
  }
  const scopes = uniqueByKey(discovery.scopes, (scope) => scope.id, "DISCOVERY_SCOPE_DUPLICATE", issues);
  for (const scope of scopes.values()) {
    if (scope.mode === "blocked") {
      addIssue(issues, "DISCOVERY_SCOPE_BLOCKED", `作用域 ${scope.id} 的项目模式仍为 blocked`, {
        document: "discovery",
      });
    }
    if (scope.mode === "greenfield" && scope.boundary !== "new") {
      addIssue(issues, "DISCOVERY_SCOPE_MODE_INVALID", `Greenfield 作用域 ${scope.id} 必须是 new boundary`, {
        document: "discovery",
      });
    }
    if (scope.mode === "brownfield" && scope.boundary !== "existing") {
      addIssue(issues, "DISCOVERY_SCOPE_MODE_INVALID", `Brownfield 作用域 ${scope.id} 必须是 existing boundary`, {
        document: "discovery",
      });
    }
  }
  validateConfiguredProjectMode(input.rulebook?.projectMode ?? "auto", scopes, issues);

  const discoveryPacks = uniqueByKey(
    discovery.packs,
    (pack) => pack.id,
    "DISCOVERY_PACK_DUPLICATE",
    issues,
  );
  requireExactPackIds(discoveryPacks, "discovery", issues);
  for (const spec of packSpecs) {
    const pack = discoveryPacks.get(spec.id);
    if (!pack) continue;
    for (const scopeId of pack.affectedScopeIds) {
      if (!scopes.has(scopeId)) {
        addIssue(issues, "DISCOVERY_SCOPE_UNKNOWN", `规则包 ${pack.id} 引用了未知作用域 ${scopeId}`, {
          document: "discovery",
          packId: pack.id,
        });
      }
    }
    if (pack.status === "not_applicable") {
      if (pack.loadedPath !== null || pack.blockerOwner !== null || pack.affectedScopeIds.length > 0) {
        addIssue(issues, "DISCOVERY_PACK_STATE_INVALID", `不适用规则包 ${pack.id} 必须保持 loadedPath/blockerOwner 为 null 且 affectedScopeIds 为空`, {
          document: "discovery",
          packId: pack.id,
        });
      }
    } else {
      if (pack.loadedPath !== spec.path || pack.affectedScopeIds.length === 0) {
        addIssue(issues, "DISCOVERY_PACK_STATE_INVALID", `规则包 ${pack.id} 必须加载 ${spec.path} 并关联作用域`, {
          document: "discovery",
          packId: pack.id,
        });
      }
      if (pack.status === "blocked") {
        if (pack.blockerOwner === null) {
          addIssue(issues, "DISCOVERY_PACK_STATE_INVALID", `阻塞规则包 ${pack.id} 必须指定 blockerOwner`, {
            document: "discovery",
            packId: pack.id,
          });
        }
        addIssue(issues, "DISCOVERY_PACK_BLOCKED", `规则包 ${pack.id} 仍为 blocked`, {
          document: "discovery",
          packId: pack.id,
        });
      } else if (pack.blockerOwner !== null) {
        addIssue(issues, "DISCOVERY_PACK_STATE_INVALID", `适用规则包 ${pack.id} 的 blockerOwner 必须为 null`, {
          document: "discovery",
          packId: pack.id,
        });
      }
    }
  }

  const applicableRules = rules.filter(
    (rule) => discoveryPacks.get(rule.packId)?.status === "applicable",
  );
  const applicableRuleIds = new Set(applicableRules.map((rule) => rule.id));
  const optionRules = uniqueByKey(options.rules, (rule) => rule.ruleId, "OPTIONS_RULE_DUPLICATE", issues);
  compareExactIds(applicableRuleIds, new Set(optionRules.keys()), "OPTIONS", issues);
  const documentedOptionIds = new Set(input.documentedOptionIds ?? []);
  for (const rule of optionRules.values()) {
    if (rule.state === "blocked") {
      addIssue(issues, "OPTIONS_RULE_BLOCKED", `规则 ${rule.ruleId} 在方案比较中仍为 blocked`, {
        document: "options",
        ruleId: rule.ruleId,
      });
    }
    if (rule.state === "constrains" && rule.affectedOptionIds.length === 0) {
      addIssue(issues, "OPTIONS_EFFECT_INVALID", `约束规则 ${rule.ruleId} 必须列出受影响方案`, {
        document: "options",
        ruleId: rule.ruleId,
      });
    }
    if (rule.state === "not_triggered" && rule.affectedOptionIds.length > 0) {
      addIssue(issues, "OPTIONS_EFFECT_INVALID", `未触发规则 ${rule.ruleId} 不应列出受影响方案`, {
        document: "options",
        ruleId: rule.ruleId,
      });
    }
    for (const optionId of rule.affectedOptionIds) {
      if (documentedOptionIds.size > 0 && !documentedOptionIds.has(optionId)) {
        addIssue(issues, "OPTIONS_OPTION_UNKNOWN", `规则 ${rule.ruleId} 引用了未知方案 ${optionId}`, {
          document: "options",
          ruleId: rule.ruleId,
        });
      }
    }
  }

  const architecturePacks = uniqueByKey(
    architecture.packs,
    (pack) => pack.id,
    "ARCHITECTURE_PACK_DUPLICATE",
    issues,
  );
  requireExactPackIds(architecturePacks, "architecture", issues);
  const expectedState = input.stage === "checkpoint"
    ? "awaiting_selection"
    : "ready_for_human_acceptance";
  if (architecture.state !== expectedState) {
    addIssue(issues, "ARCHITECTURE_STATE_INVALID", `架构机器状态必须是 ${expectedState}`, {
      document: "architecture",
    });
  }
  if (input.stage === "checkpoint") {
    if (architecture.selection !== null) {
      addIssue(issues, "ARCHITECTURE_SELECTION_PREMATURE", "选型检查点的 architecture.selection 必须为 null", {
        document: "architecture",
      });
    }
  } else if (!input.architectureSelection) {
    addIssue(issues, "ARCHITECTURE_SELECTION_REQUIRED", "最终规则校验缺少平台验证的架构选型", {
      document: "architecture",
    });
  } else if (
    architecture.selection === null
    || architecture.selection.optionId !== input.architectureSelection.optionId
    || architecture.selection.reviewId !== input.architectureSelection.reviewId
    || architecture.selection.optionsArtifactId !== input.architectureSelection.optionsArtifactId
    || architecture.selection.selectedAt !== input.architectureSelection.selectedAt
  ) {
    addIssue(issues, "ARCHITECTURE_SELECTION_MISMATCH", "Architecture 机器块未绑定当前平台验证的选型证据", {
      document: "architecture",
    });
  }
  if (
    input.stage === "final"
    && patterns
    && input.architectureSelection
    && (
      patterns.selection.optionId !== input.architectureSelection.optionId
      || patterns.selection.reviewId !== input.architectureSelection.reviewId
      || patterns.selection.optionsArtifactId !== input.architectureSelection.optionsArtifactId
      || patterns.selection.selectedAt !== input.architectureSelection.selectedAt
    )
  ) {
    addIssue(issues, "PATTERNS_SELECTION_MISMATCH", "Patterns 机器块未绑定当前平台验证的选型证据", {
      document: "patterns",
    });
  }
  for (const spec of packSpecs) {
    const summary = architecturePacks.get(spec.id);
    const discoveryPack = discoveryPacks.get(spec.id);
    if (!summary || !discoveryPack) continue;
    if (summary.status !== discoveryPack.status) {
      addIssue(issues, "PACK_STATUS_MISMATCH", `架构索引与 Discovery 的 ${spec.id} 状态不一致`, {
        document: "architecture",
        packId: spec.id,
      });
    }
    const expectedIds = new Set(
      discoveryPack.status === "applicable"
        ? rules.filter((rule) => rule.packId === spec.id).map((rule) => rule.id)
        : [],
    );
    compareExactIds(expectedIds, new Set(summary.ruleIds), `ARCHITECTURE_${spec.id}`, issues);
    assertUniqueStrings(summary.ruleIds, "ARCHITECTURE_RULE_DUPLICATE", issues, spec.id);
    assertUniqueStrings(summary.justifiedDeviationRuleIds, "ARCHITECTURE_DEVIATION_DUPLICATE", issues, spec.id);
    assertUniqueStrings(summary.exceptionRuleIds, "ARCHITECTURE_EXCEPTION_DUPLICATE", issues, spec.id);
    assertUniqueStrings(summary.blockedRuleIds, "ARCHITECTURE_BLOCKED_DUPLICATE", issues, spec.id);
    for (const id of [
      ...summary.justifiedDeviationRuleIds,
      ...summary.exceptionRuleIds,
      ...summary.blockedRuleIds,
    ]) {
      if (!expectedIds.has(id)) {
        addIssue(issues, "ARCHITECTURE_RULE_UNKNOWN", `架构索引的 ${spec.id} 引用了非适用规则 ${id}`, {
          document: "architecture",
          packId: spec.id,
          ruleId: id,
        });
      }
    }
    if (
      input.stage === "checkpoint"
      && (
        summary.justifiedDeviationRuleIds.length > 0
        || summary.exceptionRuleIds.length > 0
        || summary.blockedRuleIds.length > 0
      )
    ) {
      addIssue(issues, "ARCHITECTURE_CHECKPOINT_DISPOSITION_INVALID", `选型检查点的 ${spec.id} 不能预先声明 exception 或 blocked rule`, {
        document: "architecture",
        packId: spec.id,
      });
    }
  }

  if (input.stage === "final" && patterns) {
    validateFinalDispositions(
      applicableRules,
      scopes,
      discoveryPacks,
      optionRules,
      input.architectureSelection?.optionId,
      architecturePacks,
      patterns,
      input.architectureAdrFiles ?? [],
      input.architectureAdrsRevisionSource,
      issues,
    );
    if (input.architectureSelection) {
      for (const [artifactKey, content, style] of [
        ["architecture-c4-context", input.architectureC4Context, "mermaid"],
        ["architecture-c4-containers", input.architectureC4Containers, "mermaid"],
        ["architecture-nfrs", input.architectureNfrs, "markdown"],
        ["architecture-adversarial", input.architectureAdversarial, "markdown"],
      ] as const) {
        validateSelectionMarker(content, artifactKey, style, input.architectureSelection, issues);
      }
      validateAdrSelectionMarker(input.architectureAdrFiles, input.architectureSelection, issues);
    }
  }
}

function validateAdrSelectionMarker(
  files: ReadonlyArray<ArchitectureAdrFile> | undefined,
  expected: NonNullable<ArchitectureRulebookValidationInput["architectureSelection"]>,
  issues: ArchitectureRulebookIssue[],
): void {
  if (!files) {
    addIssue(issues, "SELECTION_MARKER_MISSING", "architecture-adrs 缺少真实 ADR 文件清单", {
      document: "architecture-adrs",
    });
    return;
  }
  for (const file of files) {
    if (!isSafeAggregatedMarkdownPath(file.relativePath)) {
      addIssue(issues, "ADR_FILE_PATH_INVALID", `architecture-adrs 包含不安全路径 ${file.relativePath}`, {
        document: "architecture-adrs",
      });
    }
  }
  const selectionFiles = files.filter((file) => file.relativePath === "00-selection.md");
  if (selectionFiles.length !== 1) {
    addIssue(
      issues,
      selectionFiles.length === 0 ? "SELECTION_MARKER_MISSING" : "SELECTION_MARKER_DUPLICATE",
      "architecture-adrs 必须且只能包含一个真实的根目录 00-selection.md",
      { document: "architecture-adrs" },
    );
    return;
  }
  validateSelectionMarker(
    selectionFiles[0]!.content,
    "architecture-adrs/00-selection.md",
    "markdown",
    expected,
    issues,
  );
}

function validateSelectionMarker(
  content: string | undefined,
  artifactKey: string,
  style: "markdown" | "mermaid",
  expected: NonNullable<ArchitectureRulebookValidationInput["architectureSelection"]>,
  issues: ArchitectureRulebookIssue[],
): void {
  const sentinel = "ai-sdlc:architecture-selection:v1";
  if (typeof content !== "string") {
    addIssue(issues, "SELECTION_MARKER_MISSING", `${artifactKey} 缺少选型绑定内容`, { document: artifactKey });
    return;
  }
  const count = content.split(sentinel).length - 1;
  if (count !== 1) {
    addIssue(
      issues,
      count === 0 ? "SELECTION_MARKER_MISSING" : "SELECTION_MARKER_DUPLICATE",
      `${artifactKey} 必须且只能包含一个选型绑定标记`,
      { document: artifactKey },
    );
    return;
  }
  const pattern = style === "mermaid"
    ? /^%% ai-sdlc:architecture-selection:v1 (\{[^\r\n]+\})\s*$/mu
    : /^<!-- ai-sdlc:architecture-selection:v1 (\{[^\r\n]+\}) -->\s*$/mu;
  const json = content.match(pattern)?.[1];
  if (!json) {
    addIssue(issues, "SELECTION_MARKER_INVALID", `${artifactKey} 的选型绑定标记格式无效`, { document: artifactKey });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
    const duplicateCheck = YAML.parseDocument(json, { schema: "json", uniqueKeys: true });
    if (duplicateCheck.errors.length > 0) throw duplicateCheck.errors[0];
  } catch {
    addIssue(issues, "SELECTION_MARKER_INVALID", `${artifactKey} 的选型绑定不是有效 JSON`, { document: artifactKey });
    return;
  }
  const selection = selectionEvidenceSchema.safeParse(parsed);
  if (!selection.success) {
    addIssue(issues, "SELECTION_MARKER_INVALID", `${artifactKey} 的选型绑定不符合 v1 schema`, { document: artifactKey });
    return;
  }
  if (
    selection.data.optionId !== expected.optionId
    || selection.data.reviewId !== expected.reviewId
    || selection.data.optionsArtifactId !== expected.optionsArtifactId
    || selection.data.selectedAt !== expected.selectedAt
  ) {
    addIssue(issues, "SELECTION_MARKER_MISMATCH", `${artifactKey} 未绑定当前平台选型`, { document: artifactKey });
  }
}

function validateFinalDispositions(
  applicableRules: ArchitectureRule[],
  scopes: Map<string, DiscoveryContract["scopes"][number]>,
  discoveryPacks: Map<ArchitectureRulePackId, DiscoveryContract["packs"][number]>,
  optionRules: Map<string, OptionsContract["rules"][number]>,
  selectedOptionId: string | undefined,
  architecturePacks: Map<ArchitectureRulePackId, ArchitectureContract["packs"][number]>,
  patterns: PatternsContract,
  architectureAdrFiles: ReadonlyArray<ArchitectureAdrFile>,
  architectureAdrsRevisionSource: "ai" | "human" | undefined,
  issues: ArchitectureRulebookIssue[],
): void {
  const dispositions = uniqueByKey(
    patterns.dispositions,
    (item) => dispositionKey(item.ruleId, item.scopeId),
    "DISPOSITION_RULE_SCOPE_DUPLICATE",
    issues,
  );
  const ruleById = new Map(applicableRules.map((rule) => [rule.id, rule]));
  const expectedPairs = new Map<string, { rule: ArchitectureRule; scopeId: string }>();
  for (const rule of applicableRules) {
    for (const scopeId of discoveryPacks.get(rule.packId)?.affectedScopeIds ?? []) {
      expectedPairs.set(dispositionKey(rule.id, scopeId), { rule, scopeId });
    }
  }
  for (const [key, expected] of expectedPairs) {
    if (!dispositions.has(key)) {
      addIssue(issues, "DISPOSITION_MISSING", `规则 ${expected.rule.id} 缺少作用域 ${expected.scopeId} 的处置`, {
        document: "patterns",
        ruleId: expected.rule.id,
      });
    }
  }
  for (const [key, disposition] of dispositions) {
    if (!expectedPairs.has(key)) {
      addIssue(issues, "DISPOSITION_UNKNOWN", `规则 ${disposition.ruleId} 在作用域 ${disposition.scopeId} 不适用或未登记`, {
        document: "patterns",
        ruleId: disposition.ruleId,
      });
    }
  }
  const deviationByPack = new Map<ArchitectureRulePackId, Set<string>>();
  const exceptionByPack = new Map<ArchitectureRulePackId, Set<string>>();
  const blockedByPack = new Map<ArchitectureRulePackId, Set<string>>();
  for (const spec of packSpecs) {
    deviationByPack.set(spec.id, new Set());
    exceptionByPack.set(spec.id, new Set());
    blockedByPack.set(spec.id, new Set());
  }

  for (const disposition of dispositions.values()) {
    const rule = ruleById.get(disposition.ruleId);
    if (!rule) continue;
    const optionRule = optionRules.get(rule.id);
    if (
      optionRule?.state === "not_triggered"
      && disposition.state !== "not_triggered"
    ) {
      addIssue(
        issues,
        "RULE_TRIGGER_CHANGED_RESELECTION_REQUIRED",
        `规则 ${rule.id} 在已审核 Options 中未触发，最终处置不能改为 ${disposition.state}；必须重新生成 Options 并重新选型`,
        { document: "patterns", ruleId: rule.id },
      );
    } else if (
      optionRule?.state === "constrains"
      && selectedOptionId !== undefined
      && optionRule.affectedOptionIds.includes(selectedOptionId)
      && disposition.state === "not_triggered"
    ) {
      addIssue(
        issues,
        "RULE_TRIGGER_CHANGED_RESELECTION_REQUIRED",
        `规则 ${rule.id} 在已审核 Options 中约束所选方案 ${selectedOptionId}，最终处置不能改为 not_triggered；必须重新生成 Options 并重新选型`,
        { document: "patterns", ruleId: rule.id },
      );
    }
    const scope = scopes.get(disposition.scopeId);
    if (!scope) {
      addIssue(issues, "DISPOSITION_SCOPE_UNKNOWN", `规则 ${rule.id} 引用了未知作用域 ${disposition.scopeId}`, {
        document: "patterns",
        ruleId: rule.id,
      });
    }
    if (disposition.state === "blocked") {
      blockedByPack.get(rule.packId)!.add(rule.id);
      addIssue(issues, "DISPOSITION_BLOCKED", `规则 ${rule.id} 仍为 blocked`, {
        document: "patterns",
        ruleId: rule.id,
      });
    }
    if (disposition.state === "justified_deviation") {
      deviationByPack.get(rule.packId)!.add(rule.id);
      if (rule.deviationPolicy !== "reason_allowed") {
        addIssue(issues, "DISPOSITION_DEVIATION_POLICY_INVALID", `规则 ${rule.id} 的 catalog policy 不允许无 ADR 偏离`, {
          document: "patterns",
          ruleId: rule.id,
        });
      }
      if (disposition.decisionRef !== null) {
        addIssue(issues, "DISPOSITION_DECISION_UNEXPECTED", `非重大偏离 ${rule.id} 的 decisionRef 必须为 null`, {
          document: "patterns",
          ruleId: rule.id,
        });
      }
    } else if (disposition.state === "exception") {
      exceptionByPack.get(rule.packId)!.add(rule.id);
      const decision = disposition.decisionRef?.match(/^accepted-adr:(ADR-\d{3,})$/u);
      if (!decision || !hasAcceptedAdr(
        architectureAdrFiles,
        architectureAdrsRevisionSource,
        decision[1]!,
        rule.id,
        disposition.scopeId,
        new Set(["Deviates from", "Supersedes"]),
      )) {
        addIssue(issues, "DISPOSITION_EXCEPTION_UNAPPROVED", `规则 ${rule.id} 的例外缺少已批准决定引用`, {
          document: "patterns",
          ruleId: rule.id,
        });
      }
    } else if (
      ["FE-002", "FE-003", "FE-004"].includes(rule.id)
      && disposition.state === "satisfied"
      && (scope?.mode === "brownfield" || scope?.boundary === "existing")
    ) {
      const decision = disposition.decisionRef?.match(/^accepted-adr:(ADR-\d{3,})$/u);
      if (!decision || !hasAcceptedAdr(
        architectureAdrFiles,
        architectureAdrsRevisionSource,
        decision[1]!,
        rule.id,
        disposition.scopeId,
        new Set(["Implements", "Supersedes"]),
      )) {
        addIssue(issues, "BROWNFIELD_DEFAULT_FORCED", `Greenfield 默认 ${rule.id} 不能直接应用到 Brownfield/existing scope`, {
          document: "patterns",
          ruleId: rule.id,
        });
      }
    } else if (disposition.decisionRef !== null) {
      addIssue(issues, "DISPOSITION_DECISION_UNEXPECTED", `规则 ${rule.id} 的当前处置不允许 decisionRef`, {
        document: "patterns",
        ruleId: rule.id,
      });
    }
    if (rule.id === "FE-001" && disposition.state === "not_triggered") {
      addIssue(issues, "FRONTEND_MODE_UNRESOLVED", `Frontend pack 适用时 ${rule.id} 不能标为 not_triggered`, {
        document: "patterns",
        ruleId: rule.id,
      });
    }
  }

  for (const spec of packSpecs) {
    const summary = architecturePacks.get(spec.id);
    if (!summary) continue;
    compareExactIds(
      deviationByPack.get(spec.id)!,
      new Set(summary.justifiedDeviationRuleIds),
      `ARCHITECTURE_DEVIATION_${spec.id}`,
      issues,
    );
    compareExactIds(
      exceptionByPack.get(spec.id)!,
      new Set(summary.exceptionRuleIds),
      `ARCHITECTURE_EXCEPTION_${spec.id}`,
      issues,
    );
    compareExactIds(
      blockedByPack.get(spec.id)!,
      new Set(summary.blockedRuleIds),
      `ARCHITECTURE_BLOCKED_${spec.id}`,
      issues,
    );
  }
}

function hasAcceptedAdr(
  files: ReadonlyArray<ArchitectureAdrFile>,
  revisionSource: "ai" | "human" | undefined,
  targetId: string,
  ruleId: string,
  scopeId: string,
  allowedEffects: ReadonlySet<string>,
): boolean {
  if (revisionSource !== "human") return false;
  const targetFiles = files.filter((file) => isSafeAggregatedMarkdownPath(file.relativePath)).filter((file) => {
    const basename = file.relativePath.split("/").at(-1)!;
    const match = basename.match(/^(ADR-\d{3,})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u);
    return match?.[1] === targetId;
  });
  if (targetFiles.length !== 1) return false;

  const fileContent = maskMarkdownFencedCode(targetFiles[0]!.content);
  const firstNonBlank = fileContent.search(/\S/u);
  if (firstNonBlank < 0) return false;
  const heading = fileContent.slice(firstNonBlank).match(/^# (ADR-\d{3,}):[^\r\n]*\S[^\r\n]*(?:\r?\n|$)/u);
  if (heading?.[1] !== targetId) return false;

  const afterHeading = fileContent.slice(firstNonBlank + heading[0].length);
  const nextHeading = afterHeading.search(/^#{1,6}[ \t]+\S/mu);
  const preamble = nextHeading < 0 ? afterHeading : afterHeading.slice(0, nextHeading);
  if (containsRawHtml(preamble)) return false;
  const status = readUniqueAdrMetadata(preamble, "Status");
  const humanApproval = readUniqueAdrSection(fileContent, "Human Approval");
  if (humanApproval !== undefined && containsRawHtml(humanApproval)) return false;
  const approvedBy = humanApproval === undefined
    ? undefined
    : readUniqueAdrMetadata(humanApproval, "Approved by");
  const approvalEvidence = humanApproval === undefined
    ? undefined
    : readUniqueAdrMetadata(humanApproval, "Approval evidence");
  const relatedRules: string[] = readUniqueAdrMetadata(preamble, "Related architecture rules")
    ?.match(/[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+/gu) ?? [];
  const relatedScopes = (readUniqueAdrMetadata(preamble, "Related scopes") ?? "")
    .split(/[\s,]+/u)
    .map((value) => value.trim())
    .filter(Boolean);
  const ruleEffect = readUniqueAdrMetadata(preamble, "Rule effect");
  return status === "Accepted"
    && isSubstantiveHumanApprovalValue(approvedBy)
    && isSubstantiveHumanApprovalValue(approvalEvidence)
    && relatedRules.includes(ruleId)
    && relatedScopes.includes(scopeId)
    && Boolean(ruleEffect && allowedEffects.has(ruleEffect));
}

function isSafeAggregatedMarkdownPath(value: string): boolean {
  if (value !== value.trim() || value.startsWith("/") || value.includes("\\") || !value.endsWith(".md")) {
    return false;
  }
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function maskMarkdownFencedCode(content: string): string {
  const withoutComments = content.replace(
    /<!--[\s\S]*?(?:-->|$)/gu,
    (comment) => comment.replace(/[^\r\n]/gu, " "),
  );
  const parts = withoutComments.split(/(\r\n|\n|\r)/u);
  let fence: { character: "`" | "~"; length: number } | undefined;
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index]!;
    const run = line.match(/^[ \t]{0,3}(`+|~+)/u)?.[1];
    if (!fence) {
      if (!run || run.length < 3) continue;
      fence = { character: run[0] as "`" | "~", length: run.length };
      parts[index] = " ".repeat(line.length);
      continue;
    }

    parts[index] = " ".repeat(line.length);
    if (
      run
      && run[0] === fence.character
      && run.length >= fence.length
      && line.slice(line.indexOf(run) + run.length).trim().length === 0
    ) {
      fence = undefined;
    }
  }
  return parts.join("");
}

function containsRawHtml(content: string): boolean {
  return /<\/?[A-Za-z][A-Za-z0-9-]*(?:[ \t\r\n][^>]*)?\/?>/u.test(content)
    || /<![A-Z]/u.test(content);
}

function readUniqueAdrMetadata(preamble: string, label: string): string | undefined {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`^\\*\\*${escapedLabel}:\\*\\*[ \\t]*([^\\r\\n]+)[ \\t]*$`, "gmu");
  const values = [...preamble.matchAll(pattern)].map((match) => match[1]!.trim());
  return values.length === 1 ? values[0] : undefined;
}

function readUniqueAdrSection(content: string, title: string): string | undefined {
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`^##[ \\t]+${escapedTitle}[ \\t]*\\r?$`, "gmu");
  const headings = [...content.matchAll(pattern)];
  if (headings.length !== 1 || headings[0]!.index === undefined) return undefined;
  const bodyStart = headings[0]!.index + headings[0]![0].length;
  const afterHeading = content.slice(bodyStart);
  const nextPeerOrParentHeading = afterHeading.search(/^#{1,2}[ \t]+\S/mu);
  return nextPeerOrParentHeading < 0
    ? afterHeading
    : afterHeading.slice(0, nextPeerOrParentHeading);
}

function isSubstantiveHumanApprovalValue(value: string | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  const autolink = isMarkdownAutolink(trimmed);
  if (!autolink && /[{}<>`*_~\[\]\\]/u.test(trimmed)) return false;
  const normalized = (autolink ? trimmed.slice(1, -1) : trimmed)
    .toLocaleLowerCase("en-US");
  return normalized.length > 1
    && !/[{}<>]/u.test(normalized)
    && !/^(?:n\/?a|none|unknown|tbd|todo|pending)(?:\b|$)/u.test(normalized)
    && !/(?:^|\b)not(?:[\s_-]+)(?:approved|provided|available|known)(?:\b|$)/u.test(normalized);
}

function isMarkdownAutolink(value: string): boolean {
  return /^<(?:https?:\/\/[^\s<>]+|mailto:[^\s<>]+|[^\s<>@]+@[^\s<>@]+)>$/iu.test(value);
}

function isSubstantiveEvidenceRef(value: string): boolean {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  if (/[{}<>]/u.test(normalized)) return false;
  const semantic = normalized
    .replace(/[`*_~\[\]()\\]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (/^(?:evidence|source|reference|ref)$/u.test(semantic)) {
    return false;
  }
  return !/(?:^|\b)(?:tbd|todo|placeholder|lorem\s+ipsum)(?:\b|$)/u.test(semantic)
    && !/^(?:n\/?a|none|unknown|pending|example)(?:\b|\s*[:—-])/u.test(semantic)
    && !/^(?:not\s+(?:provided|available|known|confirmed|applicable)|no\s+evidence)(?:\b|$)/u.test(semantic);
}

function validateConfiguredProjectMode(
  configuredMode: ArchitectureRulebookProjectMode,
  scopes: Map<string, DiscoveryContract["scopes"][number]>,
  issues: ArchitectureRulebookIssue[],
): void {
  if (configuredMode === "auto") return;
  const values = [...scopes.values()];
  if (configuredMode === "greenfield") {
    for (const scope of values) {
      if (scope.mode !== "greenfield" || scope.boundary !== "new") {
        addIssue(issues, "PROJECT_MODE_MISMATCH", `配置指定 Greenfield，但作用域 ${scope.id} 不是 greenfield/new`, {
          document: "discovery",
        });
      }
    }
    return;
  }
  if (configuredMode === "brownfield") {
    for (const scope of values) {
      if (scope.mode !== "brownfield" || scope.boundary !== "existing") {
        addIssue(issues, "PROJECT_MODE_MISMATCH", `配置指定 Brownfield，但作用域 ${scope.id} 不是 brownfield/existing`, {
          document: "discovery",
        });
      }
    }
    return;
  }

  const existing = values.filter((scope) => scope.boundary === "existing");
  const created = values.filter((scope) => scope.boundary === "new");
  if (existing.length === 0 || created.length === 0) {
    addIssue(issues, "PROJECT_MODE_MISMATCH", "配置指定 Hybrid，Discovery 必须同时声明 existing 与 new 作用域", {
      document: "discovery",
    });
  }
  for (const scope of existing) {
    if (scope.mode === "greenfield") {
      addIssue(issues, "PROJECT_MODE_MISMATCH", `Hybrid 的 existing 作用域 ${scope.id} 不能标为 greenfield`, {
        document: "discovery",
      });
    }
  }
  for (const scope of created) {
    if (scope.mode === "brownfield") {
      addIssue(issues, "PROJECT_MODE_MISMATCH", `Hybrid 的 new 作用域 ${scope.id} 不能标为 brownfield`, {
        document: "discovery",
      });
    }
  }
}

function dispositionKey(ruleId: string, scopeId: string): string {
  return `${ruleId}\0${scopeId}`;
}

function requireExactPackIds<T>(
  packs: Map<ArchitectureRulePackId, T>,
  document: string,
  issues: ArchitectureRulebookIssue[],
): void {
  for (const id of architectureRulePackIds) {
    if (!packs.has(id)) {
      addIssue(issues, "PACK_MISSING", `${document} 缺少规则包 ${id}`, { document, packId: id });
    }
  }
}

function uniqueByKey<T, K extends string>(
  values: T[],
  keyOf: (value: T) => K,
  duplicateCode: string,
  issues: ArchitectureRulebookIssue[],
): Map<K, T> {
  const result = new Map<K, T>();
  for (const value of values) {
    const key = keyOf(value);
    if (result.has(key)) {
      addIssue(issues, duplicateCode, `机器块包含重复项 ${key}`);
      continue;
    }
    result.set(key, value);
  }
  return result;
}

function compareExactIds(
  expected: Set<string>,
  actual: Set<string>,
  prefix: string,
  issues: ArchitectureRulebookIssue[],
): void {
  for (const id of expected) {
    if (!actual.has(id)) addIssue(issues, `${prefix}_MISSING`, `${prefix} 缺少规则 ${id}`, { ruleId: id });
  }
  for (const id of actual) {
    if (!expected.has(id)) addIssue(issues, `${prefix}_UNKNOWN`, `${prefix} 包含未知或不适用规则 ${id}`, { ruleId: id });
  }
}

function assertUniqueStrings(
  values: string[],
  code: string,
  issues: ArchitectureRulebookIssue[],
  packId?: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) addIssue(issues, code, `列表重复包含 ${value}`, { packId, ruleId: value });
    seen.add(value);
  }
}

function markdownCells(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return [];
  return trimmed.replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((cell) => cell.trim());
}

function stripMarkdown(value: string): string {
  return value.replace(/[`*_]/gu, "").trim();
}

function isRuleLevel(value: string): value is ArchitectureRuleLevel {
  return value === "MUST" || value === "DEFAULT" || value === "WHEN" || value === "FORBIDDEN";
}

function parseDeviationPolicy(value: string): ArchitectureRuleDeviationPolicy | undefined {
  const normalized = value.toLocaleLowerCase("en-US").replace(/[\s-]+/gu, "_");
  if (normalized === "n/a" || normalized === "not_applicable") return "not_applicable";
  if (normalized === "reason_allowed") return "reason_allowed";
  if (normalized === "adr_required") return "adr_required";
  return undefined;
}

function addIssue(
  issues: ArchitectureRulebookIssue[],
  code: string,
  message: string,
  context: Partial<ArchitectureRulebookIssue> = {},
): void {
  issues.push({ code, message, ...context });
}
