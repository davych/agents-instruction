import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  ArtifactDto,
  CodexReasoningEffort,
  FigmaTarget,
  PhaseDefinition,
  PhaseResolutionDto,
  ProjectDto,
  WorkflowRunDto
} from "@ai-sdlc/contracts";

import { AppError } from "../domain/errors.js";
import type { ArchitectureSelectionEvidence } from "../domain/workflow.js";
import type { ArtifactRecordInput, SelectionArtifact } from "../db/store.js";
import {
  assertRuntimePath,
  readArtifactContent,
  withArtifactPathsRollbackOnError,
  withProtectedArtifactPaths,
} from "./artifact-workspace.js";
import { loadArchitectureRulebookContext } from "./architecture-rulebook-runtime.js";
import { calculateArchitectureRulebookDigest } from "./architecture-rulebook-validator.js";
import type { LoadedDefinition } from "./definition-loader.js";
import { isWithin } from "./project-paths.js";

export interface CodexRunRequest {
  executionId: string;
  project: ProjectDto;
  run: WorkflowRunDto;
  phase: PhaseDefinition;
  definition: LoadedDefinition;
  selectedArtifacts: SelectionArtifact[];
  currentArtifacts?: Array<ArtifactDto & { content: string }>;
  revisionFeedback?: string[];
  selectedOutputKeys?: string[];
  requireEverySelectedOutputUpdated?: boolean;
  architectureSelection?: ArchitectureSelectionEvidence;
  phaseResolution?: PhaseResolutionDto | null;
  model: string | null;
  reasoningEffort: CodexReasoningEffort | null;
  figmaTarget?: ResolvedFigmaTarget;
}

export type ResolvedFigmaTarget =
  | Extract<FigmaTarget, { mode: "new_private_draft" }>
  | (Extract<FigmaTarget, { mode: "existing_file" }> & {
      fileKey: string;
      nodeId?: string;
    });

export interface CodexRunResult {
  exitCode: number;
  artifacts: ArtifactRecordInput[];
}

export interface CodexRunnerOptions {
  binary?: string;
  fake?: boolean;
  maxArtifactBytes?: number;
  maxEvents?: number;
  maxStderrBytes?: number;
  maxStdoutBytes?: number;
  maxStdoutLineBytes?: number;
  timeoutMs?: number;
}

export type CodexRunnerMode = "real" | "fake";

interface FigmaToolCallEvidence {
  tool: string;
  operation: "create_file" | "design_mutation";
  successful: boolean;
  failureReason?: "rate_limit";
  argumentPlanKeys: string[];
  argumentFileNames: string[];
  argumentEditorTypes: string[];
  hasArgumentProjectId: boolean;
  argumentFileKeys: string[];
  resultFileKeys: string[];
  resultNodeIds: string[];
}

interface ResolvedFigmaWriteEvidence {
  targetFileKey: string;
  mutationCall: FigmaToolCallEvidence;
  createCallMatched: boolean;
}

const FIGMA_APP_CONNECTOR_ID = "connector_68df038e0ba48191908c8434991bbac2";

export class CodexTerminalRunner {
  private readonly binary: string;
  private readonly fake: boolean;
  private readonly maxArtifactBytes: number;
  private readonly maxEvents: number;
  private readonly maxStderrBytes: number;
  private readonly maxStdoutBytes: number;
  private readonly maxStdoutLineBytes: number;
  private readonly timeoutMs: number;

  constructor(options: CodexRunnerOptions = {}) {
    this.binary = options.binary ?? "codex";
    this.fake = options.fake ?? false;
    this.maxArtifactBytes = options.maxArtifactBytes ?? 2_000_000;
    this.maxEvents = options.maxEvents ?? 50_000;
    this.maxStderrBytes = options.maxStderrBytes ?? 32_000;
    this.maxStdoutBytes = options.maxStdoutBytes ?? 32_000_000;
    this.maxStdoutLineBytes = options.maxStdoutLineBytes ?? 2_000_000;
    this.timeoutMs = options.timeoutMs ?? 30 * 60_000;
  }

  mode(): CodexRunnerMode {
    return this.fake ? "fake" : "real";
  }

  commandLabel(config?: { model: string; reasoningEffort: CodexReasoningEffort }): string {
    return this.fake
      ? "AI_SDLC_CODEX_FAKE=1"
      : [
          path.basename(this.binary),
          "--dangerously-bypass-approvals-and-sandbox exec",
          config ? `--model ${config.model} --config model_reasoning_effort=${JSON.stringify(config.reasoningEffort)}` : null,
          "--json --color never"
        ].filter(Boolean).join(" ");
  }

  async run(
    request: CodexRunRequest,
    onEvent: (eventType: string, payload: unknown) => Promise<void>
  ): Promise<CodexRunResult> {
    if (this.fake && outputKeys(request).includes("figma-handoff")) {
      throw new AppError(
        "Figma 产物只能由真实 Codex Runner 和已授权的 Figma MCP 或 Desktop App connector 生成",
        409,
        "FIGMA_REQUIRES_REAL_RUNNER"
      );
    }
    const selected = new Set(outputKeys(request));
    assertNonOverlappingOutputPaths(request.definition.artifacts);
    const protectedArtifacts = request.definition.artifacts
      .filter((artifact) => !selected.has(artifact.id))
      .map((artifact) => ({ id: artifact.id, absolutePath: artifact.absolutePath }));
    if (request.phase.id === "architecture") {
      const architectRoleRoot = path.join(request.project.rootPath, ".ai-sdlc", "roles", "architect");
      protectedArtifacts.push(
        { id: "architect-config", absolutePath: path.join(architectRoleRoot, "config.yaml") },
        { id: "architect-workflow", absolutePath: path.join(architectRoleRoot, "workflow.md") },
        {
          id: "architect-rulebook-index",
          absolutePath: path.join(architectRoleRoot, "references", "architecture-rules.md"),
        },
        {
          id: "architect-rulebook-packs",
          absolutePath: path.join(architectRoleRoot, "references", "rules"),
        },
      );
    }
    const selectedArtifacts = request.definition.artifacts
      .filter((artifact) => selected.has(artifact.id))
      .map((artifact) => ({ id: artifact.id, absolutePath: artifact.absolutePath }));
    return withArtifactPathsRollbackOnError(
      request.project.rootPath,
      selectedArtifacts,
      this.maxArtifactBytes,
      () => withProtectedArtifactPaths(
        request.project.rootPath,
        protectedArtifacts,
        this.maxArtifactBytes,
        () => this.runUnprotected(request, onEvent),
      ),
    );
  }

  private async runUnprotected(
    request: CodexRunRequest,
    onEvent: (eventType: string, payload: unknown) => Promise<void>
  ): Promise<CodexRunResult> {
    const baseline = await this.snapshotArtifactHashes(request);
    if (this.fake) {
      await onEvent("runner.started", {
        mode: "fake",
        simulated: true,
        phaseId: request.phase.id,
        selectedOutputKeys: outputKeys(request),
        model: null,
        reasoningEffort: null
      });
      await this.createFakeOutputs(request);
      const artifacts = await this.collectArtifacts(request);
      assertOutputsUpdated(baseline, artifacts, outputKeys(request), requiredUpdatedOutputKeys(request, baseline));
      await onEvent("runner.completed", { mode: "fake", simulated: true, phaseId: request.phase.id });
      return { exitCode: 0, artifacts };
    }

    if (!request.model || !request.reasoningEffort) {
      throw new AppError(
        "真实 Codex 执行缺少已解析的 model / reasoning effort",
        500,
        "CODEX_EXECUTION_CONFIG_MISSING"
      );
    }

    const prompt = buildTaskEnvelope(request);
    const args = [
      "--dangerously-bypass-approvals-and-sandbox",
      "exec",
      "--model", request.model,
      "--config", `model_reasoning_effort=${JSON.stringify(request.reasoningEffort)}`,
      "--json", "--color", "never",
      "--skip-git-repo-check", "-C", request.project.rootPath, "-"
    ];
    await onEvent("runner.started", {
      mode: "real",
      command: this.commandLabel({ model: request.model, reasoningEffort: request.reasoningEffort }),
      workingDirectory: request.project.rootPath,
      phaseId: request.phase.id,
      selectedOutputKeys: outputKeys(request),
      model: request.model,
      reasoningEffort: request.reasoningEffort,
      figmaTargetMode: request.figmaTarget?.mode ?? null
    });

    const child = spawn(this.binary, args, {
      cwd: request.project.rootPath,
      stdio: ["pipe", "pipe", "pipe"],
      env: codexEnvironment(process.env)
    });
    child.stdin.end(prompt);
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    child.stderr.on("data", (chunk: Buffer | string) => {
      const remaining = this.maxStderrBytes - stderrBytes;
      if (remaining <= 0) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const bounded = bytes.subarray(0, remaining);
      stderr.push(bounded);
      stderrBytes += bounded.length;
    });
    const figmaCalls: FigmaToolCallEvidence[] = [];
    child.stdout.setEncoding("utf8");
    let eventPumpError: unknown;
    let stdoutBytes = 0;
    let eventCount = 0;
    const processLine = async (line: string): Promise<void> => {
      if (!line.trim()) return;
      const lineBytes = Buffer.byteLength(line);
      if (lineBytes > this.maxStdoutLineBytes) {
        throw codexOutputLimitError("line_bytes", this.maxStdoutLineBytes, lineBytes);
      }
      eventCount += 1;
      if (eventCount > this.maxEvents) {
        throw codexOutputLimitError("event_count", this.maxEvents, eventCount);
      }
      let parsed: { type?: string };
      try {
        parsed = JSON.parse(line) as { type?: string };
      } catch {
        await onEvent("codex.stdout", {
          redacted: true,
          byteLength: lineBytes
        });
        return;
      }
      const figmaEvidence = readFigmaToolCallEvidence(parsed);
      if (figmaEvidence) figmaCalls.push(figmaEvidence);
      await onEvent(safeEventIdentifier(parsed.type) ?? "codex.event", sanitizeCodexEvent(parsed));
    };
    const eventPump = (async () => {
      let pending = "";
      for await (const chunk of child.stdout) {
        const text = String(chunk);
        stdoutBytes += Buffer.byteLength(text);
        if (stdoutBytes > this.maxStdoutBytes) {
          throw codexOutputLimitError("total_bytes", this.maxStdoutBytes, stdoutBytes);
        }
        pending += text;
        let newlineIndex = pending.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = pending.slice(0, newlineIndex).replace(/\r$/u, "");
          pending = pending.slice(newlineIndex + 1);
          await processLine(line);
          newlineIndex = pending.indexOf("\n");
        }
        const pendingBytes = Buffer.byteLength(pending);
        if (pendingBytes > this.maxStdoutLineBytes) {
          throw codexOutputLimitError("line_bytes", this.maxStdoutLineBytes, pendingBytes);
        }
      }
      if (pending.trim()) await processLine(pending.replace(/\r$/u, ""));
    })().catch((error: unknown) => {
      eventPumpError = error;
      child.kill("SIGKILL");
    });
    let timedOut = false;
    let forceKill: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
      forceKill.unref();
    }, this.timeoutMs);
    timeout.unref();
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    }).finally(() => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
    });
    await eventPump;
    if (eventPumpError) throw eventPumpError;
    if (timedOut) {
      throw new AppError(
        `Codex 执行超过 ${Math.round(this.timeoutMs / 1000)} 秒，已终止`,
        504,
        "CODEX_EXEC_TIMEOUT"
      );
    }
    if (exitCode !== 0) {
      const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
      throw new AppError(
        `Codex 执行失败（exit ${exitCode}），原始诊断未写入平台记录，请在本机安全终端中复现排查`,
        502,
        "CODEX_EXEC_FAILED",
        {
          exitCode,
          diagnosticBytes: Buffer.byteLength(diagnostic),
          diagnosticHash: diagnostic
            ? createHash("sha256").update(diagnostic).digest("hex")
            : null
        }
      );
    }
    assertFigmaWriteAttempted(request, figmaCalls);
    const figmaWriteEvidence = assertFigmaDesignWriteCompleted(request, figmaCalls);
    const artifacts = await this.collectArtifacts(request);
    assertOutputsUpdated(baseline, artifacts, outputKeys(request), requiredUpdatedOutputKeys(request, baseline));
    assertFigmaExecutionEvidence(request, figmaWriteEvidence, artifacts);
    await onEvent("runner.completed", { exitCode });
    return { exitCode, artifacts };
  }

  private async createFakeOutputs(request: CodexRunRequest): Promise<void> {
    const outputs = configuredOutputs(request);
    let rulebookDigest = "0".repeat(64);
    if (request.phase.id === "architecture") {
      const configuredRulebook = await loadArchitectureRulebookContext(request.project.rootPath);
      if (configuredRulebook.source) {
        rulebookDigest = calculateArchitectureRulebookDigest(configuredRulebook.source);
      }
    }
    for (const artifact of outputs) {
      await assertRuntimePath(request.project.rootPath, artifact.absolutePath);
      const extension = path.extname(artifact.absolutePath);
      const target = extension
        ? artifact.absolutePath
        : path.join(
            artifact.absolutePath,
            artifact.id === "architecture-adrs" ? "00-selection.md" : `${artifact.id}.md`,
          );
      await mkdir(path.dirname(target), { recursive: true });
      await assertRuntimePath(request.project.rootPath, target);
      const architectureContent = fakeArchitectureArtifactContent(artifact.id, request, rulebookDigest);
      const architectureSelectionMarker = fakeArchitectureSelectionMarker(artifact.id, request);
      const content = artifact.id === "design-prototype"
        ? [
            "<!doctype html>",
            '<html lang="zh-CN">',
            '<meta charset="utf-8">',
            `<title>${escapeHtml(request.run.title)} · 快速原型</title>`,
            '<style>body{font-family:system-ui;margin:2rem;color:#172033}summary{cursor:pointer;font-weight:700}</style>',
            `<main><h1>${escapeHtml(request.run.title)}</h1><p>${escapeHtml(request.run.objective)}</p>`,
            '<details><summary>体验原型状态</summary><p>这是隔离预览中的展开状态。</p></details></main>',
            "</html>",
            ""
          ].join("\n")
        : architectureContent ?? [
            ...(architectureSelectionMarker ? [architectureSelectionMarker, ""] : []),
            `# ${artifact.id}`,
            "",
            `Deterministic fake artifact for ${request.run.title}.`,
            "",
            `- Run: ${request.run.id}`,
            `- Execution: ${request.executionId}`,
            `- Phase: ${request.phase.id}`,
            `- Objective: ${request.run.objective}`,
            ""
          ].join("\n");
      await writeFile(target, content, "utf8");
    }
  }

  private async collectArtifacts(request: CodexRunRequest): Promise<ArtifactRecordInput[]> {
    const configured = configuredOutputs(request);
    const collected: ArtifactRecordInput[] = [];
    const missing: string[] = [];
    for (const artifact of configured) {
      await assertRuntimePath(request.project.rootPath, artifact.absolutePath);
      if (!existsSync(artifact.absolutePath)) {
        missing.push(`${artifact.id} (${artifact.relativePath})`);
        continue;
      }
      const content = await readArtifactContent(artifact.absolutePath, this.maxArtifactBytes);
      if (!content.trim()) {
        missing.push(`${artifact.id} (${artifact.relativePath}, empty)`);
        continue;
      }
      collected.push({
        artifactKey: artifact.id,
        filePath: artifact.relativePath,
        content,
        contentHash: createHash("sha256").update(content).digest("hex")
      });
    }
    if (missing.length > 0) {
      if (
        outputKeys(request).includes("figma-handoff")
        && missing.some((value) => value.startsWith("figma-handoff ("))
      ) {
        throw new AppError(
          "Figma 已完成真实写调用，但 Codex 没有生成本次审核所需的 figma-handoff.md；Figma 文件不会被伪造为已审核产物",
          422,
          "FIGMA_HANDOFF_MISSING",
          { targetMode: request.figmaTarget?.mode ?? null },
        );
      }
      throw new AppError(
        `Codex 未生成所有必需产物：${missing.join(", ")}`,
        422,
        "OUTPUT_ARTIFACTS_MISSING",
        { missing }
      );
    }
    return collected;
  }

  private async snapshotArtifactHashes(request: CodexRunRequest): Promise<Map<string, string>> {
    const hashes = new Map<string, string>();
    const configured = configuredOutputs(request);
    for (const artifact of configured) {
      await assertRuntimePath(request.project.rootPath, artifact.absolutePath);
      if (!existsSync(artifact.absolutePath)) continue;
      const content = await readArtifactContent(artifact.absolutePath, this.maxArtifactBytes);
      hashes.set(artifact.id, createHash("sha256").update(content).digest("hex"));
    }
    return hashes;
  }

}

function fakeArchitectureArtifactContent(
  artifactId: string,
  request: CodexRunRequest,
  catalogDigest: string,
): string | undefined {
  const applicableRuleIds: Record<string, string[]> = {
    api: ["API-001", "API-002", "API-003"],
    frontend: ["FE-001", "FE-002", "FE-003", "FE-004"],
  };
  const packs = architectureRulePackIdsForFake().map((id) => {
    const applicable = id in applicableRuleIds;
    return {
      id,
      status: applicable ? "applicable" : "not_applicable",
      triggerEvidenceRefs: [applicable
        ? `Deterministic fake fixture exercises the ${id} rule path.`
        : `Deterministic fake run has no confirmed ${id} scope.`],
      affectedScopeIds: applicable ? ["deterministic-fake"] : [],
      loadedPath: applicable ? `rules/${id}.md` : null,
      blockerOwner: null,
    };
  });
  const optionRules = Object.values(applicableRuleIds).flat().map((ruleId) => {
    const notTriggered = ruleId === "API-003" || ruleId === "FE-004";
    return {
      ruleId,
      state: notTriggered ? "not_triggered" : "constrains",
      affectedOptionIds: notTriggered ? [] : ["A", "B", "C"],
      evidenceRefs: [`Deterministic fake option evidence for ${ruleId}`],
    };
  });
  if (artifactId === "architecture-discovery-context") {
    return [
      `# Architecture Discovery Context: ${request.run.title}`,
      "",
      "## Project Mode",
      "",
      "| Affected Scope | Mode | Evidence | Compatibility Effect | Status |",
      "|---|---|---|---|---|",
      "| deterministic-fake | Greenfield | Fake runner fixture | No production compatibility claim | Confirmed |",
      "",
      "## Rule Pack Applicability",
      "",
      ...packs.map((pack) => `- ${pack.id}: Not applicable — ${pack.triggerEvidenceRefs[0]}`),
      "",
      fakeRulebookContract({
        schemaVersion: 1,
        document: "discovery",
        catalogDigest,
        scopes: [{
          id: "deterministic-fake",
          mode: "greenfield",
          boundary: "new",
          evidenceRefs: ["Deterministic fake runner fixture"],
        }],
        packs,
      }),
      "",
      `- Run: ${request.run.id}`,
      `- Execution: ${request.executionId}`,
      "",
    ].join("\n");
  }
  if (artifactId === "architecture-options") {
    return [
      `# Architecture Options: ${request.run.title}`,
      "",
      "**Status:** Awaiting human selection",
      "",
      "## Rule Constraints",
      "",
      "The deterministic fixture exercises API and Frontend conditional packs.",
      "",
      "## Option A: Modular baseline",
      "",
      "- Deterministic fake option A.",
      "",
      "## Option B: Service split",
      "",
      "- Deterministic fake option B.",
      "",
      "## Option C: Event-driven split",
      "",
      "- Deterministic fake option C.",
      "",
      fakeRulebookContract({ schemaVersion: 1, document: "options", catalogDigest, rules: optionRules }),
      "",
      `- Run: ${request.run.id}`,
      `- Execution: ${request.executionId}`,
      "",
    ].join("\n");
  }
  if (artifactId === "architecture") {
    return [
      `# Architecture Pack: ${request.run.title}`,
      "",
      `**Status:** ${request.architectureSelection ? "Ready for human acceptance" : "Awaiting human selection"}`,
      "",
      "## Rulebook Conformance",
      "",
      ...packs.map((pack) => `- ${pack.id}: Not applicable`),
      "",
      fakeRulebookContract({
        schemaVersion: 1,
        document: "architecture",
        catalogDigest,
        state: request.architectureSelection ? "ready_for_human_acceptance" : "awaiting_selection",
        selection: request.architectureSelection ?? null,
        packs: packs.map((pack) => ({
          id: pack.id,
          status: pack.status,
          ruleIds: applicableRuleIds[pack.id] ?? [],
          justifiedDeviationRuleIds: [],
          exceptionRuleIds: [],
          blockedRuleIds: [],
        })),
      }),
      "",
      `- Run: ${request.run.id}`,
      `- Execution: ${request.executionId}`,
      "",
    ].join("\n");
  }
  if (artifactId === "architecture-patterns") {
    return [
      `# Architecture Pattern Decisions: ${request.run.title}`,
      "",
      "The deterministic fixture closes every API and Frontend rule for its Greenfield scope.",
      "",
      fakeRulebookContract({
        schemaVersion: 1,
        document: "patterns",
        catalogDigest,
        selection: request.architectureSelection,
        dispositions: optionRules.map((rule) => ({
          ruleId: rule.ruleId,
          scopeId: "deterministic-fake",
          state: rule.state === "not_triggered" ? "not_triggered" : "satisfied",
          evidenceRefs: [`Deterministic fake final evidence for ${rule.ruleId}`],
          decisionRef: null,
        })),
      }),
      "",
      `- Run: ${request.run.id}`,
      `- Execution: ${request.executionId}`,
      "",
    ].join("\n");
  }
  return undefined;
}

function architectureRulePackIdsForFake(): string[] {
  return ["api", "data", "integration", "security", "observability", "frontend"];
}

function fakeArchitectureSelectionMarker(
  artifactId: string,
  request: CodexRunRequest,
): string | undefined {
  if (!request.architectureSelection) return undefined;
  const markdownArtifacts = new Set([
    "architecture-adrs",
    "architecture-nfrs",
    "architecture-adversarial",
  ]);
  const mermaidArtifacts = new Set([
    "architecture-c4-context",
    "architecture-c4-containers",
  ]);
  const json = JSON.stringify(request.architectureSelection);
  if (markdownArtifacts.has(artifactId)) {
    return `<!-- ai-sdlc:architecture-selection:v1 ${json} -->`;
  }
  if (mermaidArtifacts.has(artifactId)) {
    return `%% ai-sdlc:architecture-selection:v1 ${json}`;
  }
  return undefined;
}

function fakeRulebookContract(value: unknown): string {
  return [
    "<!-- ai-sdlc:architecture-rulebook:v1 -->",
    "```json",
    JSON.stringify(value, null, 2),
    "```",
  ].join("\n");
}

function readFigmaToolCallEvidence(event: unknown): FigmaToolCallEvidence | undefined {
  if (!event || typeof event !== "object") return undefined;
  const item = (event as { item?: unknown }).item;
  if (!item || typeof item !== "object") return undefined;
  const candidate = item as {
    type?: unknown;
    server?: unknown;
    tool?: unknown;
    status?: unknown;
    error?: unknown;
    result?: unknown;
    arguments?: unknown;
    appContext?: unknown;
    app_context?: unknown;
  };
  const appContext = isRecord(candidate.appContext)
    ? candidate.appContext
    : isRecord(candidate.app_context)
      ? candidate.app_context
      : undefined;
  const connectorId = appContext?.connectorId ?? appContext?.connector_id;
  const actionName = appContext?.actionName ?? appContext?.action_name;
  const operationNames = [candidate.tool, actionName].filter(
    (value): value is string => typeof value === "string",
  );
  const isNamespacedFigmaTool = candidate.server === "codex_apps"
    && operationNames.some(isFigmaNamespacedOperation);
  const isFigmaProvider = candidate.server === "figma"
    || connectorId === FIGMA_APP_CONNECTOR_ID
    || isNamespacedFigmaTool;
  const isCreateFile = operationNames.some(isFigmaCreateFileOperation);
  const hasExplicitDesignMutation = operationNames.some(isFigmaDesignMutationOperation);
  const hasScriptMutation = isFigmaProvider
    && operationNames.some(isFigmaUseOperation)
    && isRecord(candidate.arguments)
    && typeof candidate.arguments.code === "string"
    && hasFigmaMutationCode(candidate.arguments.code);
  if (
    candidate.type !== "mcp_tool_call"
    || !isFigmaProvider
    || typeof candidate.tool !== "string"
    || (!isCreateFile && !hasExplicitDesignMutation && !hasScriptMutation)
  ) return undefined;
  const resultEvidenceText = figmaResultEvidenceText(candidate.result);
  const successful = candidate.status === "completed" && candidate.error == null;
  return {
    tool: candidate.tool,
    operation: isCreateFile ? "create_file" : "design_mutation",
    successful,
    ...(!successful && isFigmaRateLimitResult(resultEvidenceText)
      ? { failureReason: "rate_limit" as const }
      : {}),
    argumentPlanKeys: namedStringValues(candidate.arguments, new Set(["plankey"])),
    argumentFileNames: namedStringValues(candidate.arguments, new Set(["filename"])),
    argumentEditorTypes: namedStringValues(candidate.arguments, new Set(["editortype"])),
    hasArgumentProjectId: hasNamedProperty(candidate.arguments, "projectid"),
    argumentFileKeys: namedStringValues(candidate.arguments, new Set(["filekey"])),
    resultFileKeys: uniqueStrings([
      ...namedStringValues(candidate.result, new Set(["filekey"])),
      ...figmaFileKeys(resultEvidenceText),
    ]),
    resultNodeIds: figmaEvidenceNodeIds(candidate.result, resultEvidenceText),
  };
}

function isFigmaCreateFileOperation(value: string): boolean {
  return /(?:^|[.:/])create_new_file$/iu.test(normalizeOperationName(value));
}

function isFigmaNamespacedOperation(value: string): boolean {
  return /^figma[.:/]/iu.test(normalizeOperationName(value));
}

function isFigmaUseOperation(value: string): boolean {
  return /(?:^|[.:/])use_figma$/iu.test(normalizeOperationName(value));
}

function normalizeOperationName(value: string): string {
  return value.replace(/([a-z])([A-Z])/gu, "$1_$2").toLocaleLowerCase("en-US");
}

function isFigmaDesignMutationOperation(value: string): boolean {
  return /(?:^|[.:/])generate_figma_design$/iu.test(normalizeOperationName(value));
}

function isFigmaRateLimitResult(value: string): boolean {
  return /(?:tool call limit|rate[ _-]?limit|rate_limit_paywall|upgrade your plan for more tool calls)/iu.test(value);
}

function hasFigmaMutationCode(code: string): boolean {
  const withoutComments = code
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/(^|[^:])\/\/.*$/gmu, "$1 ")
    .replace(/'(?:\\.|[^'\\])*'/gsu, "''")
    .replace(/"(?:\\.|[^"\\])*"/gsu, '""')
    .replace(/`(?:\\.|[^`\\])*`/gsu, "``");
  if (!/\bfigma\./u.test(withoutComments)) return false;
  return [
    /\bfigma\.(?:create[A-Z]\w*|group|flatten|union|subtract|intersect|exclude|combineAsVariants)\s*\(/u,
    /\bfigma\.variables\.(?:create\w*|set\w*)\s*\(/u,
    /\.(?:appendChild|insertChild|remove|resize|setBoundVariable|setPluginData|setRelaunchData|setValueForMode)\s*\(/u,
    /\.(?:name|characters|fills|strokes|effects|opacity|visible|locked|x|y|rotation|layoutMode|itemSpacing|paddingTop|paddingRight|paddingBottom|paddingLeft)\s*=/u
  ].some((pattern) => pattern.test(withoutComments));
}

function sanitizeCodexEvent(event: unknown): Record<string, unknown> {
  if (!isRecord(event)) return { type: "codex.event", redacted: true };
  const sanitized: Record<string, unknown> = {
    type: safeEventIdentifier(event.type) ?? "codex.event"
  };
  if (isRecord(event.usage)) {
    const usage = Object.fromEntries(
      Object.entries(event.usage).flatMap(([key, value]) =>
        safeEventIdentifier(key) && typeof value === "number" && Number.isFinite(value)
          ? [[key, value]]
          : []
      )
    );
    if (Object.keys(usage).length > 0) sanitized.usage = usage;
  }
  if (isRecord(event.item)) {
    const item: Record<string, unknown> = {};
    for (const key of ["type", "status", "server", "tool"] as const) {
      const value = safeEventIdentifier(event.item[key]);
      if (value) item[key] = value;
    }
    for (const key of ["exit_code", "duration_ms"] as const) {
      const value = event.item[key];
      if (typeof value === "number" && Number.isFinite(value)) item[key] = value;
    }
    if (typeof event.item.text === "string") {
      item.textBytes = Buffer.byteLength(event.item.text);
    }
    if (event.item.command !== undefined) item.commandRedacted = true;
    if (event.item.arguments !== undefined) item.argumentsRedacted = true;
    if (event.item.result !== undefined) item.resultRedacted = true;
    if (event.item.error != null) item.hasError = true;
    sanitized.item = item;
  }
  if (event.error != null) sanitized.hasError = true;
  return sanitized;
}

function safeEventIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 160) return undefined;
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(value) ? value : undefined;
}

function codexOutputLimitError(
  limitType: "event_count" | "line_bytes" | "total_bytes",
  limit: number,
  observed: number
): AppError {
  return new AppError(
    "Codex 事件输出超过平台安全上限，执行已终止",
    502,
    "CODEX_OUTPUT_LIMIT_EXCEEDED",
    { limitType, limit, observed }
  );
}

function assertFigmaExecutionEvidence(
  request: CodexRunRequest,
  writeEvidence: ResolvedFigmaWriteEvidence | undefined,
  artifacts: ArtifactRecordInput[]
): void {
  if (!outputKeys(request).includes("figma-handoff")) return;
  if (!writeEvidence) throw new AppError("Figma 写入证据丢失", 500, "FIGMA_EVIDENCE_MISSING");
  const handoff = artifacts.find((artifact) => artifact.artifactKey === "figma-handoff");
  const handoffUrls = handoff ? figmaHandoffUrls(handoff.content) : [];
  const handoffFileKeys = figmaFileKeys(handoffUrls.join("\n"));
  const handoffNodeIds = handoff ? figmaHandoffNodeIds(handoff.content, handoffUrls) : [];
  const hasNodeEvidence = handoffNodeIds.length > 0;
  const handoffMatchesTarget = handoffFileKeys.length === 1
    && handoffFileKeys[0] === writeEvidence.targetFileKey;
  const handoffMatchesMutation = writeEvidence.mutationCall.resultNodeIds.some(
    (nodeId) => handoffNodeIds.includes(nodeId),
  );

  if (!handoffMatchesTarget || !hasNodeEvidence || !handoffMatchesMutation) {
    throw new AppError(
      "本次执行没有可验证的 Figma 写入证据：必须在人工选定的 exact 文件中完成真实设计写入，并让 handoff 的 fileKey 与 node ID 和工具结果一致",
      422,
      "FIGMA_EXECUTION_UNVERIFIED",
      {
        targetMode: request.figmaTarget?.mode ?? null,
        createCallMatched: writeEvidence.createCallMatched,
        mutationCallMatched: true,
        handoffMatchesTarget,
        handoffMatchesMutation,
        hasNodeEvidence,
        successfulWriteTools: [writeEvidence.mutationCall.tool],
      }
    );
  }
}

function assertFigmaDesignWriteCompleted(
  request: CodexRunRequest,
  calls: FigmaToolCallEvidence[],
): ResolvedFigmaWriteEvidence | undefined {
  if (!outputKeys(request).includes("figma-handoff")) return undefined;
  const target = request.figmaTarget;
  if (!target) {
    throw new AppError("Figma 产物缺少已验证的写入目标", 500, "FIGMA_TARGET_MISSING");
  }
  const successfulCalls = calls.filter((call) => call.successful);
  let targetFileKey: string;
  let createCallMatched = false;
  if (target.mode === "new_private_draft") {
    const createCall = successfulCalls.find((call) =>
      call.operation === "create_file"
      && call.argumentPlanKeys.length === 1
      && call.argumentPlanKeys[0] === target.planKey
      && call.argumentFileNames.length === 1
      && call.argumentFileNames[0] === target.fileName
      && call.argumentEditorTypes.length === 1
      && call.argumentEditorTypes[0] === "design"
      && !call.hasArgumentProjectId
      && call.resultFileKeys.length === 1
    );
    const createdFileKey = createCall?.resultFileKeys[0];
    if (!createdFileKey) {
      throw new AppError(
        "Figma 私人 Draft 没有按人工选择的 plan 和文件名成功创建，执行结果不会进入审核",
        422,
        "FIGMA_TARGET_MISMATCH",
        { targetMode: target.mode, createCallMatched: false },
      );
    }
    targetFileKey = createdFileKey;
    createCallMatched = true;
  } else {
    targetFileKey = target.fileKey;
    createCallMatched = true;
  }

  const successfulMutations = successfulCalls.filter(
    (call) => call.operation === "design_mutation",
  );
  const mutationCall = successfulMutations.find((call) =>
    call.argumentFileKeys.length === 1
    && call.argumentFileKeys[0] === targetFileKey
    && (call.resultFileKeys.length === 0
      || (call.resultFileKeys.length === 1 && call.resultFileKeys[0] === targetFileKey))
    && call.resultNodeIds.length > 0
  );
  if (mutationCall) return { targetFileKey, mutationCall, createCallMatched };

  if (successfulMutations.length > 0) {
    throw new AppError(
      "Figma 设计写入没有命中人工选定的 exact 文件，执行结果不会进入审核",
      422,
      "FIGMA_TARGET_MISMATCH",
      {
        targetMode: target.mode,
        successfulWriteTools: successfulMutations.map((call) => call.tool),
      },
    );
  }
  if (calls.some((call) => call.operation === "design_mutation" && !call.successful)) {
    const rateLimited = calls.some(
      (call) => call.operation === "design_mutation" && call.failureReason === "rate_limit",
    );
    if (rateLimited) {
      throw new AppError(
        "Figma MCP 写入额度已耗尽，实际设计写入未完成；请等待额度恢复或升级 Figma 计划后重试",
        429,
        "FIGMA_RATE_LIMITED",
        { targetMode: target.mode },
      );
    }
    throw new AppError(
      "Figma 设计写调用已发起但没有成功完成，请检查目标文件编辑权限后重试",
      422,
      "FIGMA_WRITE_FAILED",
      { targetMode: target.mode },
    );
  }
  throw new AppError(
    "Figma 目标已准备，但 Codex 没有完成实际设计写入；仅创建空白 Draft 不会被当作成功",
    422,
    "FIGMA_DESIGN_WRITE_NOT_COMPLETED",
    { targetMode: target.mode, createCallMatched },
  );
}

function assertFigmaWriteAttempted(
  request: CodexRunRequest,
  calls: FigmaToolCallEvidence[]
): void {
  if (!outputKeys(request).includes("figma-handoff")) return;
  if (calls.some((call) => call.successful)) return;
  const attemptedTools = calls.map((call) => call.tool);
  if (attemptedTools.length > 0) {
    if (calls.some((call) => call.failureReason === "rate_limit")) {
      throw new AppError(
        "Figma MCP 写入额度已耗尽，实际设计写入未完成；请等待额度恢复或升级 Figma 计划后重试",
        429,
        "FIGMA_RATE_LIMITED",
        {
          targetMode: request.figmaTarget?.mode ?? null,
          attemptedWriteTools: attemptedTools,
        },
      );
    }
    throw new AppError(
      "Figma 写调用已发起但没有成功完成，因此不会生成或接受 figma-handoff；请检查目标文件权限后重试",
      422,
      "FIGMA_WRITE_FAILED",
      {
        targetMode: request.figmaTarget?.mode ?? null,
        attemptedWriteTools: attemptedTools,
        successfulWriteTools: [],
      }
    );
  }
  throw new AppError(
    "Codex 本次没有发起 Figma 写调用，因此不会生成或伪造 figma-handoff；请确认已选择可写目标后重试",
    422,
    "FIGMA_WRITE_NOT_ATTEMPTED",
    {
      reason: "NO_FIGMA_WRITE_CALL",
      targetMode: request.figmaTarget?.mode ?? null,
      selectedOutput: "figma-handoff",
      successfulWriteTools: []
    }
  );
}

function figmaUrls(content: string): string[] {
  const matches = content.match(/https:\/\/(?:www\.)?figma\.com\/[^\s<>"')\]]+/giu) ?? [];
  return [...new Set(matches.map((value) => value.replace(/[.,;:!?]+$/u, "")))];
}

function figmaFileKeys(content: string): string[] {
  return uniqueStrings(figmaUrls(content).flatMap((value) => {
    try {
      const parsed = new URL(value);
      if (!["figma.com", "www.figma.com"].includes(parsed.hostname)) return [];
      const segments = parsed.pathname.split("/").filter(Boolean);
      return ["design", "file"].includes(segments[0] ?? "") && segments[1]
        ? [segments[1]]
        : [];
    } catch {
      return [];
    }
  }));
}

function figmaHandoffUrls(content: string): string[] {
  const values: string[] = [];
  const pattern = /(?:^|\n)\s*(?:[-*]\s*)?(?:(?:figma\s*)?(?:file\s*)?url|figma\s*文件(?:地址|链接)?|文件链接)\s*[:：]\s*(https:\/\/[^\s<>"')\]]+)/gimu;
  for (const match of content.matchAll(pattern)) {
    if (match[1]) values.push(match[1].replace(/[.,;:!?]+$/u, ""));
  }
  return uniqueStrings(values);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function figmaHandoffNodeIds(content: string, urls: string[]): string[] {
  const values = figmaNodeIdsFromUrls(urls);
  const pattern = /(?:^|\n)[^\n]*(?:node[-_\s]?id|节点\s*(?:id|标识))\s*[:：]\s*`?(\d+(?::|-)\d+)`?/gimu;
  for (const match of content.matchAll(pattern)) {
    const normalized = normalizeFigmaNodeId(match[1]);
    if (normalized) values.push(normalized);
  }
  return uniqueStrings(values);
}

function figmaResultEvidenceText(value: unknown): string {
  const values = [
    ...namedStringValues(value, new Set(["url", "fileurl"])),
    ...textContentValues(value),
  ];
  return values.join("\n").slice(0, 200_000);
}

function figmaEvidenceNodeIds(value: unknown, evidenceText: string): string[] {
  return uniqueStrings([
    ...namedStringValues(value, new Set(["nodeid", "nodeids"]))
      .flatMap((nodeId) => normalizeFigmaNodeId(nodeId) ?? []),
    ...figmaNodeIdsFromUrls(figmaUrls(evidenceText)),
    ...explicitFigmaNodeIds(evidenceText),
  ]);
}

function figmaNodeIdsFromUrls(urls: string[]): string[] {
  const values: string[] = [];
  for (const value of urls) {
    try {
      const parsed = new URL(value);
      for (const nodeId of parsed.searchParams.getAll("node-id")) {
        const normalized = normalizeFigmaNodeId(nodeId);
        if (normalized) values.push(normalized);
      }
    } catch {
      // Ignore malformed tool result URLs; evidence validation will fail closed.
    }
  }
  return uniqueStrings(values);
}

function explicitFigmaNodeIds(content: string): string[] {
  const values: string[] = [];
  const pattern = /(?:node[-_\s]?id|节点\s*(?:id|标识))\s*[:：]\s*`?(\d+(?::|-)\d+)`?/gimu;
  for (const match of content.matchAll(pattern)) {
    const normalized = normalizeFigmaNodeId(match[1]);
    if (normalized) values.push(normalized);
  }
  return uniqueStrings(values);
}

function normalizeFigmaNodeId(value: string | undefined): string | undefined {
  if (!value || !/^\d+(?::|-)\d+$/u.test(value)) return undefined;
  return value.replace("-", ":");
}

function textContentValues(value: unknown): string[] {
  const values: string[] = [];
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (pending.length > 0 && visited < 2_000) {
    const current = pending.pop();
    if (!current || current.depth > 8) continue;
    visited += 1;
    if (Array.isArray(current.value)) {
      for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 });
      continue;
    }
    if (!isRecord(current.value)) continue;
    if (current.value.type === "text" && typeof current.value.text === "string") {
      values.push(current.value.text.slice(0, 50_000));
    }
    for (const child of Object.values(current.value)) {
      if (typeof child === "object" && child !== null) {
        pending.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return uniqueStrings(values);
}

function namedStringValues(value: unknown, names: Set<string>): string[] {
  const found: string[] = [];
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (pending.length > 0 && visited < 2_000) {
    const current = pending.pop();
    if (!current || current.depth > 8) continue;
    visited += 1;
    if (Array.isArray(current.value)) {
      for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 });
      continue;
    }
    if (!isRecord(current.value)) continue;
    for (const [key, child] of Object.entries(current.value)) {
      const normalizedKey = key.replace(/[^a-z0-9]/giu, "").toLocaleLowerCase("en-US");
      if (names.has(normalizedKey)) {
        if (typeof child === "string" && child.length <= 2_048) found.push(child);
        if (Array.isArray(child)) {
          for (const item of child) {
            if (typeof item === "string" && item.length <= 2_048) found.push(item);
          }
        }
      }
      if (typeof child === "object" && child !== null) {
        pending.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return uniqueStrings(found);
}

function hasNamedProperty(value: unknown, name: string): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (pending.length > 0 && visited < 2_000) {
    const current = pending.pop();
    if (!current || current.depth > 8) continue;
    visited += 1;
    if (Array.isArray(current.value)) {
      for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 });
      continue;
    }
    if (!isRecord(current.value)) continue;
    for (const [key, child] of Object.entries(current.value)) {
      const normalizedKey = key.replace(/[^a-z0-9]/giu, "").toLocaleLowerCase("en-US");
      if (normalizedKey === name) return true;
      if (typeof child === "object" && child !== null) {
        pending.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return false;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function assertOutputsUpdated(
  baseline: Map<string, string>,
  artifacts: ArtifactRecordInput[],
  selectedOutputKeys: string[],
  requiredUpdatedKeys: string[],
): void {
  const currentHashes = new Map(
    artifacts.map((artifact) => [artifact.artifactKey, artifact.contentHash]),
  );
  const unchangedOptional = ["design-prototype", "figma-handoff"].filter(
    (key) => selectedOutputKeys.includes(key) && baseline.get(key) === currentHashes.get(key),
  );
  if (unchangedOptional.length > 0) {
    throw new AppError(
      `本次选择的可选设计产物没有更新：${unchangedOptional.join(", ")}；若内容仍可复用，也必须写入本次 execution marker 并重新校验`,
      422,
      "SELECTED_OPTIONAL_OUTPUTS_UNCHANGED",
      { unchanged: unchangedOptional }
    );
  }
  const unchangedRequired = requiredUpdatedKeys.filter(
    (key) => baseline.get(key) === currentHashes.get(key),
  );
  if (unchangedRequired.length > 0) {
    throw new AppError(
      `本次执行必须实际更新这些已选择产物：${unchangedRequired.join(", ")}`,
      422,
      "SELECTED_OUTPUTS_UNCHANGED",
      { unchanged: unchangedRequired },
    );
  }
  if (artifacts.some((artifact) => baseline.get(artifact.artifactKey) !== artifact.contentHash)) return;
  throw new AppError(
    "本次执行没有更新任何注册产物，旧文件不会被冒充为新 revision",
    422,
    "OUTPUT_ARTIFACTS_UNCHANGED"
  );
}

function requiredUpdatedOutputKeys(
  request: CodexRunRequest,
  baseline: Map<string, string>,
): string[] {
  const selected = outputKeys(request);
  if (request.requireEverySelectedOutputUpdated) return selected;
  const currentOutputKeys = new Set(
    (request.currentArtifacts ?? []).map((artifact) => artifact.artifactKey),
  );
  return selected.filter(
    (key) => baseline.has(key) && !currentOutputKeys.has(key),
  );
}

export function buildTaskEnvelope(request: CodexRunRequest): string {
  const roleFile = resolveRoleFile(request.project.rootPath, request.definition, request.phase.owner);
  const selectedOutputKeySet = new Set(outputKeys(request));
  const outputs = configuredOutputs(request)
    .map((artifact) => `- ${artifact.id}: ${artifact.relativePath}`)
    .join("\n");
  const protectedOutputs = request.definition.artifacts
    .filter((artifact) => !selectedOutputKeySet.has(artifact.id))
    .map((artifact) => `- ${artifact.id}: ${artifact.relativePath}`)
    .join("\n");
  const outputMaterializationContract = buildOutputMaterializationContract(request);
  const selectedOutputKeys = outputKeys(request);
  const architectureSelectionContract = request.architectureSelection
    ? [
        `- Selected option: ${request.architectureSelection.optionId}`,
        `- Selection review id: ${request.architectureSelection.reviewId}`,
        `- Reviewed options artifact id: ${request.architectureSelection.optionsArtifactId}`,
        `- Selected at: ${request.architectureSelection.selectedAt}`,
        "- 这是本次执行唯一有效的架构选型。若普通反馈中出现其他 Option、旧选择或建议，以本区块为准。",
      ].join("\n")
    : "- 无经过平台验证的架构选型；不得自行激活任何选型后架构。";
  const protectedArchitectureCheckpoints = request.architectureSelection
    ? request.definition.artifacts.filter(
        (artifact) => ["architecture-discovery-context", "architecture-options"].includes(artifact.id)
          && !selectedOutputKeySet.has(artifact.id),
      )
    : [];
  const architectureCheckpointContract = protectedArchitectureCheckpoints.length > 0
    ? [
        "以下 Discovery / Options 是已评审的人类选型 checkpoint，本次只读：",
        ...protectedArchitectureCheckpoints.map(
          (artifact) => `- ${artifact.id}: ${artifact.relativePath}`,
        ),
        "- 其中仍显示 Awaiting selection、Not selected 或旧状态是评审快照的正常内容，不得为了记录本次 selection 而修正、刷新或补写。",
        "- 平台选型证据只能复制到本次已选中的 selected-state 产物（Architecture、C4、ADR selection marker、Patterns、NFR、Premortem 等实际被选路径）。不得写回上述 checkpoint。",
        "- 即使角色工作流、模板一致性检查或现有索引暗示应刷新它们，本执行合同的只读边界优先；若 checkpoint 确实已失效，应把阻塞写进已选产物并停止，而不是编辑 checkpoint。",
      ].join("\n")
    : "- 本次没有额外的只读 Architecture checkpoint 约束。";
  const changeContract = request.run.changeContract
    ? [
        "```json",
        JSON.stringify(request.run.changeContract, null, 2),
        "```",
        "- 这是本 Run 不可变的任务边界与验收合同；不得在阶段产物中暗自扩大范围。",
      ].join("\n")
    : "- 旧 Run 没有结构化 Change Contract；以任务目标和已批准输入为边界，不得自行补造范围。";
  const phaseResolutionContract = request.phaseResolution
    ? [
        "```json",
        JSON.stringify(request.phaseResolution, null, 2),
        "```",
        "- 这是平台已确认的阶段处置。partial 时只能修改 affectedOutputKeys；其他继承产物必须保持不变。",
      ].join("\n")
    : "- 无额外阶段处置；按本次人工选定的输入与输出合同执行。";
  const figmaTargetContract = selectedOutputKeys.includes("figma-handoff")
    ? buildFigmaTargetContract(request.figmaTarget)
    : "";
  const designRequirements = [
    selectedOutputKeys.includes("design-prototype")
      ? [
          "- design-prototype 必须是一个可独立打开的单文件 HTML 快速原型；内联必要的 CSS，不包含脚本或远程资源，可用 details/checkbox/CSS 表达状态，不冒充生产实现。",
          `- design-prototype 是本次明确选择的交付物，必须由本次执行实际写入。即使现有 HTML 经核对后仍完全适用，也必须在 \`<head>\` 中新增或更新且只保留一个本次标记：\`<!-- ai-sdlc:execution:${request.executionId} -->\`，然后重新运行静态校验。不得仅检查旧文件后原样保留。`,
        ].join("\n")
      : null,
    selectedOutputKeys.includes("figma-handoff")
      ? "- figma-handoff 只有在真实调用已授权的 Figma MCP 或 Desktop App connector 写工具并验证结果后才能写入；必须用独立字段 `Figma File URL: <真实 URL>` 和 `Node ID: <真实 node ID>` 原样记录该成功工具结果，并补充工具名和本次操作证据，严禁编造链接或 ID。Figma 写工具必须由本次 root execution 直接调用，不得委派给子 agent，以便平台在顶层 JSONL 中验证真实写入证据。"
      : null
  ].filter(Boolean).join("\n");
  const selected = request.selectedArtifacts.length === 0
    ? "- 无（这是第一个阶段）"
    : request.selectedArtifacts.map((artifact) => {
      const snapshot = artifact.content.slice(0, 50_000);
      return [
        `### ${artifact.artifactKey}`,
        `Approved artifact id: ${artifact.id}`,
        `Original path: ${artifact.filePath}`,
        `SHA-256: ${artifact.contentHash}`,
        "```markdown",
        snapshot,
        "```"
      ].join("\n");
    }).join("\n\n").slice(0, 180_000);
  const currentArtifacts = (request.currentArtifacts ?? []).length === 0
    ? "- 无（本阶段尚未产生过产物）"
    : (request.currentArtifacts ?? []).map((artifact) => [
        `### ${artifact.artifactKey} · revision ${artifact.revision}`,
        `Current artifact id: ${artifact.id}`,
        `Current path: ${artifact.filePath}`,
        `Revision source: ${artifact.revisionSource}`,
        `SHA-256: ${artifact.contentHash}`,
        "```",
        artifact.content.slice(0, 50_000),
        "```",
      ].join("\n")).join("\n\n").slice(0, 180_000);
  const revisionFeedback = (request.revisionFeedback ?? []).length === 0
    ? "- 无"
    : (request.revisionFeedback ?? []).map((comment) => `- ${comment}`).join("\n").slice(0, 20_000);

  return `你正在执行 AI SDLC 平台中的一个受控阶段。

## 执行合同

- Run: ${request.run.id}
- 任务: ${request.run.title}
- 目标: ${request.run.objective}
- 当前阶段: ${request.phase.id}
- 当前角色: ${request.phase.owner}
- Codex model: ${request.model}
- Reasoning effort: ${request.reasoningEffort}
- Gate: ${request.phase.gate}
- 唯一可写的注册输出：${selectedOutputKeys.join(", ") || "无"}
- 未出现在上一行的所有注册产物均为只读；不得因选型、状态或一致性需要而刷新它们。

先读取并遵守项目内的 ai-native.yaml 和角色文件 ${roleFile}。只执行当前阶段，不要推进、批准或执行其他角色。

## 不可变 Change Contract

${changeContract}

## 当前阶段 Impact / Route 决议

${phaseResolutionContract}

## 已由人工批准并明确选择的输入

以下快照是本次执行的权威输入。不要自行选择未列出的其他阶段产物：

${selected}

## 当前阶段已有的最新产物版本

这些快照包含人工调整后的当前版本。把被选中的输出当作修改基线；未被选中的输出必须保持原样，不得刷新、格式化或顺手改写。其他阶段的注册产物同样不在本次写入范围内。

${currentArtifacts}

## 本次修改反馈

${revisionFeedback}

## 平台验证的架构选型

${architectureSelectionContract}

${architectureCheckpointContract}

## 本次由人工选择的预期输出

在项目内生成或更新以下注册路径：

${outputs}

上面的输出列表是平台解析并经人工选择后的本次权威合同；即使旧项目的 ai-native.yaml 尚未列出平台兼容补齐的输出，本次执行也必须以该列表和明确路径为准。

## 受保护的未选中输出（只读）

${protectedOutputs || "- 无"}

这些路径可以读取作为上下文，但绝不能通过 apply_patch、重写、格式化、生成器或任何其他方式修改。此只读清单优先于角色文件、旧模板、索引一致性或“顺手刷新”要求；只要其中任一文件发生字节变化，平台就会还原并拒绝整次执行。需要表达的新状态只能写入上面明确选择的输出。

## 输出落盘与暂停语义

${outputMaterializationContract}

这是一次严格限定输出范围的执行。只能写上面列出的注册输出；任何未选中的注册产物（包括上游输入和其他阶段产物）都必须保持字节不变，平台会在所有退出路径校验并还原越界修改。

${designRequirements ? `## 设计产物特别约束\n\n${designRequirements}\n` : ""}
${figmaTargetContract ? `## 已由人工选定的 Figma 目标\n\n${figmaTargetContract}\n` : ""}

路径必须保持在项目目录内。不得提交、推送、发布、删除项目数据或修改工作流状态。完成产物后停止；平台会独立采集产物并进入人工审核。
`;
}

function buildOutputMaterializationContract(request: CodexRunRequest): string {
  const currentOutputKeys = new Set(
    (request.currentArtifacts ?? []).map((artifact) => artifact.artifactKey),
  );
  const uncommittedWorkspaceOutputs = configuredOutputs(request)
    .filter((artifact) => !currentOutputKeys.has(artifact.id) && existsSync(artifact.absolutePath))
    .map((artifact) => artifact.id);
  const rules = [
    "- 成功退出前，上面列出的每一个输出路径都必须存在且包含非空白内容；目录型产物必须至少包含一个非空的普通文件。平台会逐项校验，缺失或空产物会让本次执行失败。",
    "- 角色工作流中的 stop、pause、等待人工决定或类似控制点，只表示停止依赖该决定的实质工作；它们不允许省略本次已选择的输出路径。",
    "- 如果缺少证据或人工决定，不能编造结论。应在仍被选中的输出路径写入真实的 Pending/Blocked 状态、阻塞原因、决策 owner 和下一步，再停止。若某输出的专门证据合同明确禁止在证据缺失时创建（例如 figma-handoff），则遵守该专门合同，绝不能用占位内容伪造证据。",
  ];
  if (request.phase.owner === "architect") {
    rules.push(
      "- Architect 特例：没有人类选项选择证据时，仍须完成被选中的 architecture、discovery context 和 options；并为本次列出的其余架构产物落盘非空的 pending scaffold，然后才可停止。",
      "- 被选中的 C4 `.mmd` 在等待选择时只写可渲染的 Mermaid pending notice，不得画成已选架构；被选中的 ADR 目录至少写入 `README.md`，明确它只是等待选择的状态文件而不是 ADR；被选中的 patterns、NFR 和 adversarial Markdown 写明 Pending、阻塞原因、owner 与下一步。",
      "- architecture 索引必须链接这些 scaffold 并把它们标为 Pending。Pending scaffold 不是有效的 C4、ADR、pattern、NFR 或对抗审查，不得把架构阶段标为可实施或已接受。",
    );
  }
  if (request.requireEverySelectedOutputUpdated) {
    rules.push(
      "- 本次执行发生在有效人工选型之后。每一个 selected 输出都必须基于该选型实际更新；任一文件或目录聚合内容与执行前完全相同，平台都会拒绝整次执行并回滚。",
    );
  }
  if (uncommittedWorkspaceOutputs.length > 0) {
    rules.push(
      `- 以下 selected 路径已存在于工作区，但平台没有对应的当前 artifact revision，可能是上次失败留下的未提交内容：${uncommittedWorkspaceOutputs.join(", ")}。必须基于本次权威输入重新核对并实际重写，不能原样保留后冒充本次结果。`,
    );
  }
  return rules.join("\n");
}

function buildFigmaTargetContract(target: ResolvedFigmaTarget | undefined): string {
  if (!target) {
    throw new AppError("Figma 产物缺少已验证的写入目标", 500, "FIGMA_TARGET_MISSING");
  }
  if (target.mode === "new_private_draft") {
    return [
      "目标类型：新建私人 Draft。",
      "必须先在 root execution 中调用 Figma create_new_file，editorType 必须为 design，并且原样使用以下 JSON 中的 planKey 和 fileName；不得改选其他 plan：",
      "```json",
      JSON.stringify({
        planKey: target.planKey,
        fileName: target.fileName,
        editorType: "design",
      }, null, 2),
      "```",
      "create_new_file 调用必须省略 projectId，以便文件进入该计划的私人 Draft。新建成功后，继续在该工具返回的 exact fileKey 中完成设计写入与写后验证。",
      "新建文件是空白 Draft；首次设计写入前不要对它调用 search_design_system、get_design_context 或其他发现类 Figma 工具。这些调用不会发现可复用资产且会消耗 Starter 计划额度。请直接基于仓库与已批准输入调用 use_figma 完成设计，再做最少量写后验证。",
    ].join("\n");
  }
  return [
    "目标类型：更新已有 Figma Design 文件。",
    "必须在 root execution 中将设计写入以下已验证的 exact fileKey；不得创建其他文件：",
    "```json",
    JSON.stringify({
      mode: target.mode,
      fileUrl: target.fileUrl,
      fileKey: target.fileKey,
      ...(target.nodeId ? { nodeId: target.nodeId } : {}),
    }, null, 2),
    "```",
    "完成写入后必须对该文件进行写后验证。",
  ].join("\n");
}

function outputKeys(request: CodexRunRequest): string[] {
  return request.selectedOutputKeys ?? request.phase.outputs;
}

function configuredOutputs(request: CodexRunRequest): LoadedDefinition["artifacts"] {
  const selected = new Set(outputKeys(request));
  return request.definition.artifacts.filter((artifact) => selected.has(artifact.id));
}

function assertNonOverlappingOutputPaths(artifacts: LoadedDefinition["artifacts"]): void {
  for (const [index, left] of artifacts.entries()) {
    for (const right of artifacts.slice(index + 1)) {
      if (
        isWithin(left.absolutePath, right.absolutePath)
        || isWithin(right.absolutePath, left.absolutePath)
      ) {
        throw new AppError(
          `阶段产物路径不能相同或互相嵌套：${left.id}, ${right.id}`,
          422,
          "OVERLAPPING_ARTIFACT_PATHS",
        );
      }
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function resolveRoleFile(projectRoot: string, definition: LoadedDefinition, roleId: string): string {
  const extensions = definition.agentClient === "codex" ? [".toml"] : [".md", ".agent.md"];
  for (const extension of extensions) {
    const candidate = path.posix.join(definition.agentDirectory, `${roleId}${extension}`);
    if (existsSync(path.join(projectRoot, candidate))) return candidate;
  }
  return path.posix.join(definition.agentDirectory, roleId);
}

function codexEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TEMP", "TMP",
    "LANG", "LC_ALL", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR",
    "CODEX_HOME", "CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "SSL_CERT_FILE", "SSL_CERT_DIR"
  ];
  return Object.fromEntries(allowed.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]])) as NodeJS.ProcessEnv;
}
