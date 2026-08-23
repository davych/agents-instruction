export interface DesignValidationCandidate {
  id?: string;
  decision?: string;
  owner?: string;
  nextAction?: string;
}

export interface DeferredDesignValidation {
  id: string;
  owner: "tester";
  phase: "verification";
  prerequisite: string;
  targets: string[];
  checks: string[];
  passCriteria: string;
  evidenceRequired: string;
  evidenceTypes: DeferredDesignEvidenceType[];
  status: "deferred";
  releaseImpact: string;
  onFail: "block_verification";
  onMissing: "block_verification";
}

export const deferredDesignEvidenceTypes = [
  "browser-run",
  "screenshot",
  "keyboard-log",
  "accessibility-report",
  "contrast-report",
  "motion-evidence",
] as const;

export type DeferredDesignEvidenceType = typeof deferredDesignEvidenceTypes[number];

export interface DeferredDesignValidationAssessment {
  entries: DeferredDesignValidation[];
  errors: string[];
}

export function assessDeferredDesignValidations(
  candidate: unknown,
): DeferredDesignValidationAssessment {
  // A present Design Spec must state the ledger explicitly, even when empty.
  // A skipped Design phase is represented by the absence of design-spec, not
  // by silently omitting this contract field.
  if (candidate === undefined) {
    return { entries: [], errors: ["deferred_validations must be an explicit array"] };
  }
  if (!Array.isArray(candidate)) {
    return { entries: [], errors: ["deferred_validations must be an array"] };
  }

  const entries: DeferredDesignValidation[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of candidate.entries()) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      errors.push(`deferred_validations[${index}] must be an object`);
      continue;
    }
    const value = raw as Record<string, unknown>;
    const id = String(value.id ?? "").trim().toUpperCase();
    const owner = String(value.owner ?? "").trim().toLowerCase();
    const phase = String(value.phase ?? "").trim().toLowerCase();
    const prerequisite = contractText(value.prerequisite);
    const targets = contractList(value.targets);
    const checks = contractList(value.checks);
    const passCriteria = contractText(value.pass_criteria ?? value.passCriteria);
    const evidenceRequired = contractText(value.evidence_required ?? value.evidenceRequired);
    const evidenceTypes = contractList(value.evidence_types ?? value.evidenceTypes);
    const status = String(value.status ?? "").trim().toLowerCase();
    const releaseImpact = contractText(value.release_impact ?? value.releaseImpact);
    const onFail = String(value.on_fail ?? value.onFail ?? "").trim().toLowerCase();
    const onMissing = String(value.on_missing ?? value.onMissing ?? "").trim().toLowerCase();
    const entryErrors: string[] = [];

    if (!/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/u.test(id)) entryErrors.push("stable id");
    if (id && seen.has(id)) entryErrors.push("unique id");
    if (owner !== "tester") entryErrors.push("owner=tester");
    if (phase !== "verification") entryErrors.push("phase=verification");
    if (!prerequisite || !runnableImplementationPrerequisite(prerequisite)) {
      entryErrors.push("runnable implementation prerequisite");
    }
    if (!targets.length) entryErrors.push("targets");
    if (!checks.length) entryErrors.push("checks");
    if (!passCriteria) entryErrors.push("pass_criteria");
    if (!evidenceRequired) entryErrors.push("evidence_required");
    if (
      evidenceTypes.length === 0
      || new Set(evidenceTypes).size !== evidenceTypes.length
      || evidenceTypes.some((type) => !deferredDesignEvidenceTypes.includes(type as DeferredDesignEvidenceType))
    ) {
      entryErrors.push(`unique evidence_types from ${deferredDesignEvidenceTypes.join(", ")}`);
    }
    if (status !== "deferred") entryErrors.push("status=deferred");
    if (!releaseImpact || !meaningfulReleaseImpact(releaseImpact)) {
      entryErrors.push("release_impact with an explicit Verification or Release consequence");
    }
    if (onFail !== "block_verification") entryErrors.push("on_fail=block_verification");
    if (onMissing !== "block_verification") entryErrors.push("on_missing=block_verification");

    if (entryErrors.length > 0) {
      errors.push(`${id || `deferred_validations[${index}]`}: missing or invalid ${entryErrors.join(", ")}`);
      continue;
    }
    seen.add(id);
    entries.push({
      id,
      owner: "tester",
      phase: "verification",
      prerequisite: prerequisite!,
      targets,
      checks,
      passCriteria: passCriteria!,
      evidenceRequired: evidenceRequired!,
      evidenceTypes: evidenceTypes as DeferredDesignEvidenceType[],
      status: "deferred",
      releaseImpact: releaseImpact!,
      onFail: "block_verification",
      onMissing: "block_verification",
    });
  }
  return { entries, errors };
}

/** Stable obligation IDs already present in a Design artifact must survive a
 * later revision until Verification closes them. This includes the legacy
 * blocker representation used by initialized projects before the ledger was
 * introduced. */
export function deferredDesignValidationIds(content: string): string[] {
  const match = /```json\s*([\s\S]*?)```/iu.exec(content);
  if (!match?.[1]) return [];
  let envelope: Record<string, unknown>;
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    envelope = parsed as Record<string, unknown>;
  } catch {
    return [];
  }

  const ids = new Set<string>();
  if (Array.isArray(envelope.deferred_validations)) {
    for (const candidate of envelope.deferred_validations) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const id = String((candidate as Record<string, unknown>).id ?? "").trim().toUpperCase();
      if (/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/u.test(id)) ids.add(id);
    }
  }
  if (Array.isArray(envelope.blockers)) {
    for (const candidate of envelope.blockers) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const blocker = candidate as Record<string, unknown>;
      const id = String(blocker.id ?? "").trim().toUpperCase();
      if (
        /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/u.test(id)
        && isDeferredDesignVerification({
          id,
          decision: String(blocker.decision ?? blocker.description ?? ""),
          owner: String(blocker.owner ?? ""),
          nextAction: String(blocker.next_action ?? blocker.nextAction ?? ""),
        })
      ) ids.add(id);
    }
  }
  return [...ids];
}

/**
 * A Design blocker may be deferred only when it is an observable verification
 * obligation and the artifact explicitly says that a runnable implementation is
 * a prerequisite. Merely lacking a browser or naming B-04 is not sufficient:
 * checks that can run against the current prototype remain Designer-owned work.
 */
export function isDeferredDesignVerification(
  candidate: DesignValidationCandidate,
): boolean {
  const text = [
    candidate.id,
    candidate.decision,
    candidate.owner,
    candidate.nextAction,
  ].filter(Boolean).join(" ").trim();
  if (!text) return false;

  const explicitlyBeforeImplementation = /(?:实现|代码|开发|implementation|coding|development)[^。；;\n]{0,16}(?:之前|以前|前|before)/iu.test(text)
    || /(?:before|prior\s+to)[^.;\n]{0,24}(?:implementation|coding|development)/iu.test(text);
  if (
    explicitlyBeforeImplementation
    || negatesRunnableImplementationPrerequisite(text)
    || indicatesCurrentVerificationIsAvailable(text)
  ) return false;

  const verificationObligation = /验证|验收|测试|检查|浏览器|响应式|键盘|焦点|对比度|辅助技术|\b(?:evidence|verify|verification|validate|validation|test|testing|check|checking|responsive|accessibility|viewport|keyboard|focus|contrast|reduced[- ]motion|browser)\b/iu.test(text);
  if (!verificationObligation) return false;

  const implementationPrerequisite = /(?:实现|代码|开发|页面|应用|功能|构建)[^。；;\n]{0,32}(?:完成(?:后)?|落地(?:后)?|可运行(?:后)?|可用(?:后)?|就绪(?:后)?|部署(?:后)?)/iu.test(text)
    || /(?:完成|落地|部署)[^。；;\n]{0,16}(?:实现|代码|开发|页面|应用|功能)(?:后)?/iu.test(text)
    || /(?:after|once|when)\s+(?:the\s+)?(?:implementation|code|application|app|page|feature|build)\b[^.;\n]{0,32}\b(?:complete|implemented|runnable|running|available|ready|deployed)\b/iu.test(text)
    || /\b(?:implementation|code|application|app|page|feature|build)\b[^.;\n]{0,24}(?:is\s+|becomes?\s+)?\b(?:complete|implemented|runnable|running|available|ready|deployed)\b/iu.test(text)
    || /post[- ]implementation/iu.test(text);

  return implementationPrerequisite;
}

function runnableImplementationPrerequisite(value: string): boolean {
  if (
    negatesRunnableImplementationPrerequisite(value)
    || indicatesCurrentVerificationIsAvailable(value)
  ) return false;
  return /(?:实现|代码|开发|页面|应用|功能|构建)[^。；;\n]{0,32}(?:完成|落地|可运行|可用|就绪|部署)/iu.test(value)
    || /\b(?:runnable|running|completed?|implemented|deployed|available|ready)\b[- ]?(?:implementation|code|application|app|page|feature|build)\b/iu.test(value)
    || /\b(?:implementation|code|application|app|page|feature|build)\b[^.;\n]{0,24}\b(?:runnable|running|completed?|implemented|deployed|available|ready)\b/iu.test(value)
    || /post[- ]implementation/iu.test(value);
}

function negatesRunnableImplementationPrerequisite(value: string): boolean {
  return /(?:do\s+not|don['’]?t|does\s+not|doesn['’]?t|need\s+not|no\s+need\s+to|without)\b[^.;\n]{0,48}\b(?:wait|implementation|code|application|app|page|feature|build|ready|runnable|complete)/iu.test(value)
    || /\b(?:implementation|code|application|app|page|feature|build)\b[^.;\n]{0,24}\b(?:unavailable|not\s+(?:ready|runnable|running|complete|completed|available)|never\s+(?:ready|runnable|running|complete|completed|available)|incomplete)\b/iu.test(value)
    || /\b(?:ready|runnable|running|complete|completed|available)\b[^.;\n]{0,16}\b(?:is|are)\s+(?:not\s+required|optional)\b/iu.test(value)
    || /(?:无需|不必|不要|不用)[^。；;\n]{0,24}(?:等待)?[^。；;\n]{0,16}(?:实现|代码|开发|页面|应用|功能|构建)[^。；;\n]{0,16}(?:完成|可运行|可用|就绪)?/iu.test(value)
    || /(?:实现|代码|开发|页面|应用|功能|构建)[^。；;\n]{0,12}(?:尚未|未|不|无需|不必)[^。；;\n]{0,8}(?:完成|可运行|可用|就绪)/iu.test(value);
}

function contractText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (
    text.length < 3
    || !/[\p{L}\p{N}]/u.test(text)
    || /^(?:n\/?a|none|tbd|todo|unknown|<.*>|\{\{.*\}\})[.!]?$/iu.test(text)
    || /\b(?:tbd|todo|placeholder|fill\s+in\s+later|evidence\s+pending)\b|(?:待补|占位|稍后补)/iu.test(text)
    || /^(?:not\s+applicable|none\s+needed|no\s+(?:target|check|pass\s+criteri(?:on|a)|evidence|result)s?\s+(?:is\s+|are\s+)?required|不适用|(?:无需|不需要)(?:目标|检查|通过标准|证据|结果)(?:要求)?)[.!。]?$/iu.test(text)
  ) return null;
  return text;
}

function indicatesCurrentVerificationIsAvailable(value: string): boolean {
  const explicitCurrentPrototypeNow = [
    /(?:现在|当下)[^。；;\n]{0,48}(?:现有|当前|已有)(?:的)?(?:原型|设计稿|产品|页面|应用)/iu,
    /(?:现有|当前|已有)(?:的)?(?:原型|设计稿|产品|页面|应用)[^。；;\n]{0,48}(?:现在|当下)/iu,
    /\b(?:now|currently)\b[^.;\n]{0,64}\b(?:current|existing|available)\s+(?:prototype|design|product|page|application|app)\b/iu,
    /\b(?:current|existing|available)\s+(?:prototype|design|product|page|application|app)\b[^.;\n]{0,64}\b(?:now|currently)\b/iu,
  ].some((pattern) => pattern.test(value));
  if (explicitCurrentPrototypeNow) return true;

  const currentIndex = firstMatchIndex(value, [
    /(?:现在|立即|当下)[^。；;\n]{0,32}(?:验证|测试|检查|使用)/iu,
    /(?:现有|当前|已有)(?:的)?(?:原型|设计稿|产品|页面|应用)[^。；;\n]{0,32}(?:可|能够|用于|验证|测试|检查)/iu,
    /\b(?:now|immediately|currently)\b[^.;\n]{0,40}\b(?:verify|validate|test|check|use)\b/iu,
    /\b(?:current|existing|available)\s+(?:prototype|design|product|page|application|app)\b[^.;\n]{0,40}\b(?:verify|validate|test|check|available|usable)\b/iu,
    /\b(?:verify|validate|test|check|use)\b[^.;\n]{0,48}\b(?:current|existing|available)\s+(?:prototype|design|product|page|application|app)\b[^.;\n]{0,24}\b(?:now|immediately|currently)\b/iu,
  ]);
  if (currentIndex < 0) return false;
  const futurePrerequisiteIndex = firstMatchIndex(value, [
    /(?:实现|代码|开发|页面|应用|功能|构建)[^。；;\n]{0,32}(?:完成(?:后)?|落地(?:后)?|可运行(?:后)?|可用(?:后)?|就绪(?:后)?|部署(?:后)?)/iu,
    /(?:after|once|when)\s+(?:the\s+)?(?:implementation|code|application|app|page|feature|build)\b[^.;\n]{0,32}\b(?:complete|implemented|runnable|running|available|ready|deployed)\b/iu,
    /post[- ]implementation/iu,
  ]);
  return futurePrerequisiteIndex < 0 || currentIndex < futurePrerequisiteIndex;
}

function firstMatchIndex(value: string, patterns: readonly RegExp[]): number {
  const indexes = patterns
    .map((pattern) => pattern.exec(value)?.index ?? -1)
    .filter((index) => index >= 0);
  return indexes.length > 0 ? Math.min(...indexes) : -1;
}

function meaningfulReleaseImpact(value: string): boolean {
  if (
    /\b(?:(?:does?|will|would|must|should)\s+not|doesn['’]?t|won['’]?t)\s+(?:block|prevent|affect)\b|\bunaffected\b|\b(?:informational|advisory)\s+only\b|(?:不会|不影响|不阻止|无需阻止|仅供参考)/iu.test(value)
  ) return false;
  const failure = /\b(?:fail(?:ure|ed)?|missing|absent|blocked|untested|incomplete)\b|(?:失败|缺失|未通过|未验证|阻塞)/iu.test(value);
  const consequence = /\b(?:block(?:s|ed|ing)?|prevent(?:s|ed|ing)?|cannot|must\s+not|not\s+eligible)\b|(?:阻止|不能通过|不得|不可|不予)/iu.test(value);
  const gate = /\b(?:verification|release|approval|ship(?:ping)?|launch)\b|(?:验证|发布|放行|上线|批准)/iu.test(value);
  return failure && consequence && gate;
}

function contractList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) return [];
  const entries = value.map(contractText);
  return entries.every((entry): entry is string => Boolean(entry)) ? entries : [];
}
