import {
  type HumanDecisionItemDto,
  type HumanDecisionPhaseId,
  type HumanDecisionSummaryDto,
  type PhaseHumanDecisionGateDto,
  type PhaseStatus,
  type ReviewDto,
} from "@ai-sdlc/contracts";

import { AppError } from "./errors.js";
import {
  assessDeferredDesignValidations,
  isDeferredDesignVerification,
} from "./design-deferred-validation.js";

export const HUMAN_DECISIONS_MARKER = "ai-sdlc:human-decisions:v1";

interface DecisionArtifact {
  artifactKey: string;
  content: string;
}

export interface PhaseHumanDecisionInput {
  phaseId: HumanDecisionPhaseId;
  phaseStatus: PhaseStatus;
  artifacts: readonly DecisionArtifact[];
  reviews?: readonly ReviewDto[];
  requiredDeferredValidationIds?: readonly string[];
}

const roleByPhase = {
  discovery: "pm-ba",
  design: "designer",
  architecture: "architect",
} as const;

export function assessPhaseHumanDecisionGate(
  input: PhaseHumanDecisionInput,
): PhaseHumanDecisionGateDto {
  const responses = capturedResponses(input.reviews ?? []);
  const extracted = input.phaseId === "discovery"
    ? productDecisionItems(input.artifacts)
    : input.phaseId === "design"
      ? designDecisionItems(input.artifacts, input.requiredDeferredValidationIds ?? [])
      : architectureDecisionItems(input.artifacts);
  const items = dedupeItems(extracted).map((item) => ({
    ...item,
    response: responses.get(item.id) ?? null,
  }));
  const blockingCount = items.filter(({ blocking }) => blocking).length;
  const decisionCount = items.filter(({ kind, blocking }) => kind === "decision" && blocking).length;
  const workCount = items.filter(({ kind, blocking }) => kind === "work" && blocking).length;
  const dependencyCount = items.filter(({ kind, blocking }) => kind === "dependency" && blocking).length;
  const inconsistentApproval = input.phaseStatus === "approved" && blockingCount > 0;
  return {
    phaseId: input.phaseId,
    roleId: roleByPhase[input.phaseId],
    state: inconsistentApproval
      ? "inconsistent_approval"
      : decisionCount > 0
        ? "awaiting_decision"
        : workCount > 0 || dependencyCount > 0
          ? "awaiting_role_work"
          : "clear",
    items,
    blockingCount,
    decisionCount,
    workCount,
    dependencyCount,
    inconsistentApproval,
  };
}

export function humanDecisionSummary(
  gates: readonly PhaseHumanDecisionGateDto[],
): HumanDecisionSummaryDto {
  return {
    totalBlocking: gates.reduce((total, gate) => total + gate.blockingCount, 0),
    totalDecisions: gates.reduce((total, gate) => total + gate.decisionCount, 0),
    totalRoleWork: gates.reduce((total, gate) => total + gate.workCount, 0),
    inconsistentPhaseIds: gates
      .filter(({ inconsistentApproval }) => inconsistentApproval)
      .map(({ phaseId }) => phaseId),
    phases: [...gates],
  };
}

export function assertPhaseHumanDecisionGateReady(
  gate: PhaseHumanDecisionGateDto,
): void {
  if (gate.blockingCount === 0) return;
  throw new AppError(
    `${phaseLabel(gate.phaseId)} 仍有 ${gate.blockingCount} 项未决决定、角色工作或上游依赖，不能通过并解锁`,
    409,
    "PHASE_HUMAN_DECISIONS_REQUIRED",
    { gate },
  );
}

export function serializeHumanDecisionCapture(input: {
  phaseId: HumanDecisionPhaseId;
  responses: ReadonlyArray<{ id: string; response: string }>;
}): string {
  const readable = input.responses
    .map(({ id, response }) => `- ${id}: ${response.trim()}`)
    .join("\n");
  return [
    "Human decisions captured; update the formal phase artifacts and remove only the blockers these answers actually resolve.",
    "",
    readable,
    "",
    `<!-- ${HUMAN_DECISIONS_MARKER} ${Buffer.from(JSON.stringify({
      schemaVersion: 1,
      phaseId: input.phaseId,
      responses: input.responses,
    }), "utf8").toString("base64url")} -->`,
  ].join("\n");
}

export function parseHumanDecisionCapture(
  content: string,
): { phaseId: HumanDecisionPhaseId; responses: Array<{ id: string; response: string }> } | null {
  const encoded = /<!--\s*ai-sdlc:human-decisions:v1\s+([A-Za-z0-9_-]+)\s*-->/u.exec(content)?.[1];
  if (encoded) {
    try {
      return parsedHumanDecisionPayload(
        JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
      );
    } catch {
      return null;
    }
  }
  const marker = content.indexOf(`<!-- ${HUMAN_DECISIONS_MARKER} -->`);
  if (marker < 0) return null;
  const match = /```json\s*([\s\S]*?)```/iu.exec(content.slice(marker));
  if (!match?.[1]) return null;
  try {
    return parsedHumanDecisionPayload(JSON.parse(match[1]));
  } catch {
    return null;
  }
}

function parsedHumanDecisionPayload(
  candidate: unknown,
): { phaseId: HumanDecisionPhaseId; responses: Array<{ id: string; response: string }> } | null {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return null;
  const value = candidate as Record<string, unknown>;
  if (
    value.schemaVersion !== 1
    || !["discovery", "design", "architecture"].includes(String(value.phaseId))
    || !Array.isArray(value.responses)
  ) return null;
  const responses = value.responses.flatMap((responseCandidate) => {
    if (typeof responseCandidate !== "object" || responseCandidate === null) return [];
    const record = responseCandidate as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const response = typeof record.response === "string" ? record.response.trim() : "";
    return id && response ? [{ id, response }] : [];
  });
  return {
    phaseId: value.phaseId as HumanDecisionPhaseId,
    responses,
  };
}

function productDecisionItems(artifacts: readonly DecisionArtifact[]): HumanDecisionItemDto[] {
  const prd = artifacts.find(({ artifactKey }) => artifactKey === "prd")?.content;
  if (!prd) return [];
  const section = markdownSection(prd, ["Open questions for a human", "Open human decisions"]);
  const questions: HumanDecisionItemDto[] = uncheckedItems(section).map((question, index) => ({
    id: explicitItemId(question) ?? `PROD-Q-${String(index + 1).padStart(2, "0")}`,
    phaseId: "discovery" as const,
    actionPhaseId: "discovery" as const,
    artifactKey: "prd",
    kind: "decision" as const,
    title: conciseTitle(question),
    prompt: cleanMarkdown(question),
    owner: "Human product owner",
    nextAction: "回答后让 PM / BA 更新 PRD、业务规则和验收标准。",
    blocking: true,
    response: null,
  }));
  const explicitIncompleteFields = /\|[^\n]*(?:Needs?\s+decision|TBD(?:\s*[—-]\s*human\s+decision)?)[^\n]*\|/iu.test(prd);
  const status = markdownStrongField(prd, "Status") ?? "";
  if (
    questions.length === 0
    && (explicitIncompleteFields || /(?:blocked|pending\s+human|not\s+ready|needs?\s+decision)/iu.test(status))
  ) {
    questions.push({
      id: "PRODUCT-HANDOFF-INCOMPLETE",
      phaseId: "discovery",
      actionPhaseId: "discovery",
      artifactKey: "prd",
      kind: explicitIncompleteFields ? "decision" : "work",
      title: "产品交接仍明确标记为未完成",
      prompt: explicitIncompleteFields
        ? "PRD 仍包含 Needs decision 或 TBD 的业务规则、优先级或成功阈值。"
        : `PRD Status: ${status || "missing"}`,
      owner: explicitIncompleteFields ? "Human product owner" : "PM / BA",
      nextAction: explicitIncompleteFields
        ? "补齐明确答案，再让 PM / BA 更新正式产品合同。"
        : "让 PM / BA 修正交接状态并明确剩余工作。",
      blocking: true,
      response: null,
    });
  }
  return questions;
}

function designDecisionItems(
  artifacts: readonly DecisionArtifact[],
  requiredDeferredValidationIds: readonly string[],
): HumanDecisionItemDto[] {
  const spec = artifacts.find(({ artifactKey }) => artifactKey === "design-spec")?.content;
  if (!spec) return [];
  const envelope = firstJsonObject(spec);
  const items: HumanDecisionItemDto[] = [];
  const blockersFieldValid = Array.isArray(envelope?.blockers);
  const blockers = blockersFieldValid ? envelope!.blockers as unknown[] : [];
  for (const [index, candidate] of blockers.entries()) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const blocker = candidate as Record<string, unknown>;
    const id = String(blocker.id ?? `DES-BLOCKER-${index + 1}`).trim();
    const prompt = String(blocker.decision ?? blocker.description ?? id).trim();
    const owner = String(blocker.owner ?? "Designer").trim();
    const productDependency = /^(?:B-0[1-3]|PROD-)/iu.test(id)
      || /product|content|产品|内容/iu.test(owner);
    const designerWork = /^B-04$/iu.test(id) || /designer|设计/iu.test(owner);
    const nextAction = String(blocker.next_action ?? blocker.nextAction ?? "解决后更新 design-spec。");
    const deferredVerification = !productDependency && designerWork && isDeferredDesignVerification({
      id,
      decision: prompt,
      owner,
      nextAction,
    });
    items.push({
      id,
      phaseId: "design",
      actionPhaseId: productDependency ? "discovery" : "design",
      artifactKey: "design-spec",
      kind: productDependency ? "dependency" : designerWork ? "work" : "decision",
      title: conciseTitle(prompt),
      prompt,
      owner,
      nextAction,
      blocking: !deferredVerification,
      response: null,
    });
  }
  const deferredAssessment = assessDeferredDesignValidations(envelope?.deferred_validations);
  const legacyAllDeferred = blockers.length > 0
    && items.length === blockers.length
    && items.every(({ blocking }) => !blocking);
  for (const validation of deferredAssessment.entries) {
    const prompt = `${validation.checks.join("；")}（${validation.targets.join("、")}）`;
    items.push({
      id: validation.id,
      phaseId: "design",
      actionPhaseId: "design",
      artifactKey: "design-spec",
      kind: "work",
      title: conciseTitle(prompt),
      prompt,
      owner: "Tester",
      nextAction: `${validation.evidenceRequired}；发布影响：${validation.releaseImpact}`,
      blocking: false,
      response: null,
    });
  }
  const missingLedgerOnly = deferredAssessment.errors.length === 1
    && deferredAssessment.errors[0] === "deferred_validations must be an explicit array";
  if (deferredAssessment.errors.length > 0 && !(missingLedgerOnly && legacyAllDeferred)) {
    items.push({
      id: "DESIGN-DEFERRED-VALIDATION-INVALID",
      phaseId: "design",
      actionPhaseId: "design",
      artifactKey: "design-spec",
      kind: "work",
      title: "实现后验证清单格式不完整",
      prompt: deferredAssessment.errors.join("；"),
      owner: "Designer",
      nextAction: "按设计 schema 补齐稳定 ID、Tester / Verification 归属、可运行前置条件、目标、检查、通过标准、证据和发布影响。",
      blocking: true,
      response: null,
    });
  }
  const currentDeferredIds = new Set(deferredAssessment.entries.map(({ id }) => id));
  const lostIds = [...new Set(requiredDeferredValidationIds)]
    .filter((id) => !currentDeferredIds.has(id));
  if (lostIds.length > 0) {
    items.push({
      id: "DESIGN-DEFERRED-VALIDATION-LOST",
      phaseId: "design",
      actionPhaseId: "design",
      artifactKey: "design-spec",
      kind: "work",
      title: "实现后验证义务不能从修订历史中消失",
      prompt: `上一版本已记录但当前 deferred_validations 缺少：${lostIds.join("、")}`,
      owner: "Designer",
      nextAction: "只整理正式交接：恢复这些 stable ID 及完整 Tester / Verification 合同；不要删除义务或在 Design 重跑运行时验证。",
      blocking: true,
      response: null,
    });
  }
  if (envelope && !blockersFieldValid) {
    items.push({
      id: "DESIGN-CONTRACT-INVALID",
      phaseId: "design",
      actionPhaseId: "design",
      artifactKey: "design-spec",
      kind: "work",
      title: "设计合同的 blockers 字段无效",
      prompt: "design-spec JSON 必须包含 blockers 数组；字符串、对象或缺失字段都不能通过。",
      owner: "Designer",
      nextAction: "按 spec-schema 修复 machine-readable JSON，并重新运行 validate-spec.mjs。",
      blocking: true,
      response: null,
    });
  }
  const openQuestions = Array.isArray(envelope?.open_questions) ? envelope.open_questions : [];
  for (const [index, question] of openQuestions.entries()) {
    const prompt = typeof question === "string" ? question.trim() : "";
    if (!prompt) continue;
    const productDependency = /priority|success|threshold|product|content|优先级|成功|阈值|产品|内容/iu.test(prompt);
    items.push({
      id: `DES-Q-${String(index + 1).padStart(2, "0")}`,
      phaseId: "design",
      actionPhaseId: productDependency ? "discovery" : "design",
      artifactKey: "design-spec",
      kind: productDependency ? "dependency" : "decision",
      title: conciseTitle(prompt),
      prompt,
      owner: productDependency ? "Human product owner" : "Human design owner",
      nextAction: productDependency
        ? "回到 Product 记录答案并更新产品合同，再让 Designer 同步设计规格。"
        : "可在后续设计迭代中确认；当前问题不得改变本次已明确的实现合同。",
      blocking: productDependency,
      response: null,
    });
  }
  const status = typeof envelope?.status === "string" ? envelope.status.trim().toLowerCase() : "";
  const formalHandoffReady = status === "ready-for-engineering"
    && blockersFieldValid
    && blockers.length === 0;
  if (!formalHandoffReady && items.every(({ blocking }) => !blocking)) {
    const deferredOnly = items.some(({ blocking }) => !blocking);
    items.push({
      id: "DESIGN-HANDOFF-INCOMPLETE",
      phaseId: "design",
      actionPhaseId: "design",
      artifactKey: "design-spec",
      kind: "work",
      title: deferredOnly ? "需要整理一次正式设计交接" : "设计交接尚未达到 ready-for-engineering",
      prompt: deferredOnly
        ? `Design status: ${status || "missing"}；实现后验证已经识别，但正式合同仍未清空 blockers。`
        : `Design status: ${status || "missing"}`,
      owner: "Designer",
      nextAction: deferredOnly
        ? "只整理一次 design-spec：把实现后验证移入 deferred_validations，设置 blockers=[]、status=ready-for-engineering；不要再次尝试运行该验证。"
        : "完成设计行为、响应式、无障碍和验证证据后更新状态。",
      blocking: true,
      response: null,
    });
  }
  return items;
}

function architectureDecisionItems(artifacts: readonly DecisionArtifact[]): HumanDecisionItemDto[] {
  const items: HumanDecisionItemDto[] = [];
  for (const artifact of artifacts) {
    if (!artifact.artifactKey.startsWith("architecture")) continue;
    const section = markdownSection(artifact.content, [
      "Open Human Decisions",
      "Open decisions",
      "Evidence still missing",
    ]);
    for (const [index, raw] of uncheckedItems(section).entries()) {
      const rawPrompt = cleanMarkdown(raw);
      if (isArchitectureSelectionChecklistItem(rawPrompt)) continue;
      const observabilityRuleId = /\bOBS-002\b/iu.test(rawPrompt);
      const prompt = observabilityRuleId
        ? "当前应用是纯浏览器前端。请选择：采用不远程上传的本地最小诊断，或接入已有监控平台；两者都必须明确字段、脱敏规则和负责人，且不得记录儿童输入、答案、自由文本或凭据。"
        : rawPrompt;
      const id = observabilityRuleId
        ? "ARCH-OBS-002"
        : explicitItemId(raw) ?? `ARCH-Q-${String(index + 1).padStart(2, "0")}`;
      const productDependency = /^(?:PROD-|B-0[1-3])/iu.test(id);
      const designDependency = /^(?:DES-|B-04)/iu.test(id);
      const acceptance = /^ARCH-(?:04|ACCEPT)/iu.test(id);
      items.push({
        id,
        phaseId: "architecture",
        actionPhaseId: productDependency ? "discovery" : designDependency ? "design" : "architecture",
        artifactKey: artifact.artifactKey,
        kind: productDependency || designDependency ? "dependency" : acceptance ? "acceptance" : "decision",
        title: observabilityRuleId ? "浏览器错误信息写到哪里？" : conciseTitle(prompt),
        prompt,
        owner: observabilityRuleId
          ? "Human architecture / operations owner"
          : ownerFromPrompt(prompt, acceptance ? "Human architecture owner" : "Human decision owner"),
        nextAction: acceptance
          ? "其余架构决定关闭后，通过本阶段即记录最终人工接受。"
          : observabilityRuleId
            ? "选定一条诊断政策并保存；随后只重跑一次 Architect，让它关闭 OBS-002 并刷新当前 options 检查点。"
          : productDependency
            ? "回到 Product 记录答案并更新产品合同。"
            : designDependency
              ? "回到 Design 完成验证并更新设计交接。"
              : "记录决定后让 Architect 更新 NFR、ADR 和架构索引。",
        blocking: !acceptance,
        response: null,
      });
    }
  }
  const index = artifacts.find(({ artifactKey }) => artifactKey === "architecture")?.content ?? "";
  const status = markdownStrongField(index, "Status") ?? "";
  const awaitingCurrentSelection = /(?:awaiting|等待)[^\n]*(?:platform[- ]verified\s+)?(?:option\s+)?selection|等待[^\n]*选型/iu
    .test(status);
  if (
    items.every(({ blocking }) => !blocking)
    && /\bblocked\b/iu.test(status)
    && !awaitingCurrentSelection
  ) {
    items.push({
      id: "ARCHITECTURE-HANDOFF-INCOMPLETE",
      phaseId: "architecture",
      actionPhaseId: "architecture",
      artifactKey: "architecture",
      kind: "work",
      title: "架构包仍明确标记为 Blocked",
      prompt: `Architecture Status: ${status}`,
      owner: "Architect",
      nextAction: "关闭具体依赖、决定和验证缺口后重新生成架构包。",
      blocking: true,
      response: null,
    });
  }
  return items;
}

function isArchitectureSelectionChecklistItem(prompt: string): boolean {
  return /platform[- ]verified\s+selection|选型(?:对象|记录|证据)|record[^.。；;]{0,80}(?:option\s+)?selection/iu
    .test(prompt);
}

function capturedResponses(reviews: readonly ReviewDto[]): Map<string, string> {
  const responses = new Map<string, string>();
  for (const review of reviews) {
    const record = parseHumanDecisionCapture(review.comment);
    if (!record) continue;
    for (const response of record.responses) {
      if (!responses.has(response.id)) responses.set(response.id, response.response);
    }
  }
  return responses;
}

function dedupeItems(items: readonly HumanDecisionItemDto[]): HumanDecisionItemDto[] {
  const result = new Map<string, HumanDecisionItemDto>();
  for (const item of items) if (!result.has(item.id)) result.set(item.id, item);
  return [...result.values()];
}

function markdownSection(content: string, headings: readonly string[]): string {
  const wanted = new Set(headings.map(normalizeHeading));
  const lines = content.split(/\r?\n/u);
  let start = -1;
  let level = 0;
  for (const [index, line] of lines.entries()) {
    const match = /^(#{1,6})\s+(.+?)\s*$/u.exec(line);
    if (!match) continue;
    if (start < 0 && wanted.has(normalizeHeading(match[2] ?? ""))) {
      start = index + 1;
      level = match[1]?.length ?? 2;
      continue;
    }
    if (start >= 0 && (match[1]?.length ?? 7) <= level) return lines.slice(start, index).join("\n");
  }
  return start >= 0 ? lines.slice(start).join("\n") : "";
}

function uncheckedItems(content: string): string[] {
  return content.split(/\r?\n/u).flatMap((line) => {
    const match = /^\s*[-*]\s+\[\s\]\s+(.+?)\s*$/u.exec(line);
    return match?.[1] ? [match[1].trim()] : [];
  });
}

function explicitItemId(content: string): string | null {
  return /^(?:\*\*)?([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+)(?:\s*\/\s*[A-Za-z][A-Za-z0-9-]+)?(?:\*\*)?\s*[:：]/u.exec(content)?.[1] ?? null;
}

function cleanMarkdown(content: string): string {
  return content.replace(/\*\*|`/gu, "").trim();
}

function conciseTitle(content: string): string {
  const cleaned = cleanMarkdown(content).replace(/^(?:[A-Za-z][A-Za-z0-9-]+)\s*[:：]\s*/u, "");
  return (cleaned.split(/[。；;？?]/u)[0] ?? cleaned).trim().slice(0, 120);
}

function normalizeHeading(content: string): string {
  return content.trim().toLocaleLowerCase("en-US").replace(/[^\p{Letter}\p{Number}]+/gu, " ").trim();
}

function markdownStrongField(content: string, field: string): string | null {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^\\*\\*${escaped}:\\*\\*[ \\t]*(.+?)[ \\t]*$`, "imu")
    .exec(content)?.[1]?.trim() ?? null;
}

function firstJsonObject(content: string): Record<string, unknown> | null {
  const match = /```json\s*([\s\S]*?)```/iu.exec(content);
  if (!match?.[1]) return null;
  try {
    const value = JSON.parse(match[1]);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function ownerFromPrompt(prompt: string, fallback: string): string {
  const match = /((?:Product|Design|Architecture|Security|Operations|产品|设计|架构|安全|运维)[^。；;]{0,40}(?:owner|负责人))/iu.exec(prompt);
  return match?.[1]?.trim() ?? fallback;
}

function phaseLabel(phaseId: HumanDecisionPhaseId): string {
  return phaseId === "discovery" ? "Product" : phaseId === "design" ? "Design" : "Architecture";
}
