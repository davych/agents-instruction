export const ENGINEERING_FLOW_STEPS = [
  {
    number: 1,
    title: "确认验收标准",
    description: "先确认 Change Contract 或已批准 User Stories 中有可观察、可测试的 AC；没有 AC 就先回到产品阶段补齐。",
  },
  {
    number: 2,
    title: "开始实施并写代码",
    description: "点击 Software Engineer 后，Codex 才会修改源码、补测试、运行检查，并自动生成工程证据。",
  },
  {
    number: 3,
    title: "查看质量证据",
    description: "先看实现结果，再核对独立测试、七镜审查和风险；七份文档是同一次实施的分工记录，不是七次手工任务。",
  },
  {
    number: 4,
    title: "通过并解锁 Tester",
    description: "只有 AC 全覆盖、阻塞已解除且证据完整时才通过；否则按页面建议修复并重新实施。",
  },
] as const;

export const ENGINEERING_ARTIFACT_GUIDES = [
  {
    key: "implementation-plan",
    stage: "开工准备",
    timing: "写代码前",
    purpose: "说明这次改什么、不改什么、按什么顺序实现，以及每条 AC 如何覆盖。",
    humanCheck: "范围是否正确，上游产品、设计和架构决定是否已经明确。",
    required: false,
  },
  {
    key: "implementation-tasks",
    stage: "开工准备",
    timing: "写代码前并持续更新",
    purpose: "把计划拆成可执行任务，记录依赖、文件范围、进度和 AC 映射。",
    humanCheck: "有没有漏项、越界任务或仍未完成的任务。",
    required: false,
  },
  {
    key: "implementation-notes",
    stage: "实现记录",
    timing: "写代码后",
    purpose: "实现结果总览：改了哪些代码、验证结果、风险，以及其余六份证据的索引。",
    humanCheck: "是否真的完成代码改动；若写着 Failed/Blocked，就不能通过。",
    required: true,
  },
  {
    key: "engineering-session-log",
    stage: "实现记录",
    timing: "写代码过程中自动记录",
    purpose: "按顺序记录读取的上下文、执行命令、关键决定、变更清单和最终结果。",
    humanCheck: "文档声称执行的命令和决定是否有真实证据。",
    required: false,
  },
  {
    key: "engineering-test-evidence",
    stage: "质量与交付",
    timing: "代码完成后",
    purpose: "记录独立测试隔离等级、每条 AC 的测试覆盖、真实命令和结果。",
    humanCheck: "每条 AC 是否有可执行测试且最终通过，独立性声明是否可信。",
    required: true,
  },
  {
    key: "engineering-review",
    stage: "质量与交付",
    timing: "测试完成后",
    purpose: "用工程七镜和对抗检查寻找行为回归、隐藏假设、安全问题与边界缺陷。",
    humanCheck: "是否还有 open/blocked finding，尤其是安全与高严重度问题。",
    required: true,
  },
  {
    key: "engineering-provenance",
    stage: "质量与交付",
    timing: "准备交给 Tester/PR 时",
    purpose: "PR 证据链，连接规格、会话、测试、审查、工具和已知限制；不会替你发布或合并。",
    humanCheck: "链接和声明是否真实，PR、合并、发布仍由人决定。",
    required: false,
  },
] as const;

export type EngineeringArtifactKey = (typeof ENGINEERING_ARTIFACT_GUIDES)[number]["key"];

export const ENGINEERING_OUTPUT_KEYS = [
  "implementation-notes",
  "implementation-plan",
  "implementation-tasks",
  "engineering-session-log",
  "engineering-test-evidence",
  "engineering-review",
  "engineering-provenance",
] as const satisfies ReadonlyArray<EngineeringArtifactKey>;

export type EngineeringGateRecommendationKind =
  | "repair-upstream"
  | "rerun-implementation"
  | "repair-evidence";

export interface EngineeringGateAction {
  id: string;
  title: string;
  description: string;
  artifactKey?: EngineeringArtifactKey;
  issueCount: number;
  reasons: string[];
}

export interface EngineeringGateRecommendation {
  kind: EngineeringGateRecommendationKind;
  title: string;
  description: string;
  outputKeys: EngineeringArtifactKey[];
}

export interface EngineeringGateGuidance {
  title: string;
  summary: string;
  actions: EngineeringGateAction[];
  diagnostics: string[];
  issueCount: number;
  affectedArtifactKeys: EngineeringArtifactKey[];
  recommendation: EngineeringGateRecommendation;
}

export interface ImplementationStartAction {
  code: string;
  role: "pm-ba" | "designer" | "architect";
  roleLabel: string;
  title: string;
  description: string;
  blockerIds: string[];
  blockers: Array<{ id: string; decision: string; owner: string; nextAction: string }>;
}

export interface ImplementationStartGuidance {
  title: string;
  summary: string;
  actions: ImplementationStartAction[];
}

export function implementationReadinessGuidance(error: unknown): ImplementationStartGuidance | null {
  const payload = asRecord(error);
  if (payload?.code !== "IMPLEMENTATION_NOT_READY") return null;
  const details = asRecord(payload.details);
  const issueValues = Array.isArray(details?.issues) ? details.issues : [];
  const actions = issueValues.flatMap((value): ImplementationStartAction[] => {
    const issue = asRecord(value);
    if (!issue || typeof issue.code !== "string" || typeof issue.title !== "string") return [];
    const role = issue.role === "designer" || issue.role === "architect" ? issue.role : "pm-ba";
    const roleLabel = role === "designer" ? "Designer" : role === "architect" ? "Architect" : "PM / BA";
    const blockerIds = Array.isArray(issue.blockerIds)
      ? issue.blockerIds.filter((id): id is string => typeof id === "string")
      : [];
    const blockers = Array.isArray(issue.blockers)
      ? issue.blockers.flatMap((value) => {
        const blocker = asRecord(value);
        if (!blocker) return [];
        return [{
          id: typeof blocker.id === "string" ? blocker.id : "",
          decision: typeof blocker.decision === "string" ? blocker.decision : "",
          owner: typeof blocker.owner === "string" ? blocker.owner : "",
          nextAction: typeof blocker.nextAction === "string" ? blocker.nextAction : "",
        }];
      })
      : [];
    const defaultDescription = role === "designer"
      ? "回到 Design 解决 blocker，重新生成 ready-for-engineering 的设计规格并完成人工审核。"
      : role === "architect"
        ? "回到 Architecture 完成决定、NFR 和人工验收，确保架构包不再是 Blocked。"
        : "回到 Product 补齐产品决定和稳定验收标准，再完成人工审核。";
    return [{
      code: issue.code,
      role,
      roleLabel,
      title: issue.title,
      description: `${typeof issue.detail === "string" ? issue.detail : ""} ${defaultDescription}`.trim(),
      blockerIds,
      blockers,
    }];
  });
  return {
    title: "还不能开始写代码",
    summary: "平台已在创建 Codex 执行前停止，所以不会进入“正在写代码”，也不会再生成一轮 Blocked Markdown。请按角色顺序解决下面的输入问题。",
    actions,
  };
}

export function engineeringEvidenceGateGuidance(error: unknown): EngineeringGateGuidance | null {
  const payload = asRecord(error);
  if (payload?.code !== "ENGINEERING_EVIDENCE_GATE_FAILED") return null;
  const details = asRecord(payload.details);
  const diagnostics = Array.isArray(details?.issues)
    ? details.issues.filter((issue): issue is string => typeof issue === "string")
    : [];
  const actions = new Map<string, EngineeringGateAction>();

  const addAction = (action: Omit<EngineeringGateAction, "issueCount" | "reasons">, reason: string) => {
    const existing = actions.get(action.id);
    if (existing) {
      existing.issueCount += 1;
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      return;
    }
    actions.set(action.id, { ...action, issueCount: 1, reasons: [reason] });
  };

  for (const issue of diagnostics) {
    if (/at least one authoritative acceptance criterion is required/iu.test(issue)) {
      addAction({
        id: "acceptance-criteria",
        title: "先补齐权威验收标准",
        description: "当前 Run 没有可用于审批的 Change Contract AC，也没有从已批准且本次选中的 User Stories 识别到稳定 AC。请回到产品阶段补至少一条可观察、可测试的验收标准，再重新实施；不要在工程文档里自造 AC。",
      }, "产品输入中没有平台可识别的权威验收标准，工程证据不能替产品补写 AC。");
      continue;
    }
    if (/implementation-notes:.*explicit Failed or Blocked/iu.test(issue)) {
      addAction({
        id: "blocked-implementation",
        title: "当前没有完成代码实施",
        description: "实现说明明确记录了 Failed/Blocked。先解决其中列出的产品、设计或架构阻塞，再点击“开始实施并写代码”完整重跑；不要只把状态文字改成 Ready。",
        artifactKey: "implementation-notes",
      }, "实现说明明确记录了 Failed 或 Blocked，不能只修改状态文字后通过。");
      continue;
    }
    if (/implementation-plan:.*(?:<\.\.\.>|\{\{\.\.\.\}\}|placeholder)/iu.test(issue)) {
      addAction({
        id: "plan-placeholder",
        title: "补全实施计划中的占位内容",
        description: "实施计划里还残留 <...>、{{...}}、TBD 或 TODO 占位内容。打开实施计划填写真实决定；如果该决定仍未知，就先回到对应上游阶段解决，而不是强行通过。事实已明确时也可以仅重跑该产物。",
        artifactKey: "implementation-plan",
      }, "实施计划仍含 <...>、{{...}}、TBD 或 TODO 等未解决占位内容。");
      continue;
    }

    const artifactKey = engineeringArtifactKeyFromIssue(issue);
    const guide = ENGINEERING_ARTIFACT_GUIDES.find(({ key }) => key === artifactKey);
    if (guide && artifactKey) {
      addAction({
        id: `artifact-${guide.key}`,
        title: `${engineeringArtifactName(artifactKey)}需要修复`,
        description: isHardImplementationIssue(issue)
          ? `${guide.humanCheck} 这条记录表示实施事实仍未完成，需要解决真实失败后完整重跑 Software Engineer。`
          : "Codex 需要按当前机器模板修复这份记录并保留真实代码、测试和命令事实；你不用手写 Markdown。",
        artifactKey: guide.key,
      }, localizeEngineeringIssue(issue, artifactKey));
    }
  }

  if (actions.size === 0) {
    addAction({
      id: "review-diagnostics",
      title: "按技术详情逐项修复",
      description: "这些是证据内容或状态不一致，不是页面故障。修复对应产物后重新提交；不要删除门禁或伪造通过状态。",
    }, "平台返回了尚未识别的工程证据问题，请查看原始校验信息。");
  }

  const affectedArtifactKeys = [...new Set(
    [...actions.values()].flatMap(({ artifactKey }) => artifactKey ? [artifactKey] : []),
  )];
  const hasUpstreamGap = diagnostics.some((issue) =>
    /at least one authoritative acceptance criterion is required/iu.test(issue)
  );
  const hasHardImplementationFailure = diagnostics.some(isHardImplementationIssue);
  const recommendation: EngineeringGateRecommendation = hasUpstreamGap
    ? {
        kind: "repair-upstream",
        title: "回到 Product 补齐验收标准",
        description: "先让 PM / BA 把可观察、可测试的 AC 写入正式产品产物并通过审核，再完整实施。",
        outputKeys: [],
      }
    : hasHardImplementationFailure
      ? {
          kind: "rerun-implementation",
          title: "完整重跑 Software Engineer",
          description: "校验结果包含未完成任务、失败命令或明确 Blocked 状态。先解决真实失败，再重新执行代码、测试和全部七份证据。",
          outputKeys: [...ENGINEERING_OUTPUT_KEYS],
        }
      : {
          kind: "repair-evidence",
          title: `让 Software Engineer 只修复这 ${affectedArtifactKeys.length} 份证据`,
          description: "本次命中的是证据格式、字段或追溯链接问题。平台会把具体校验反馈交给 Codex，并只预选受影响的证据输出。",
          outputKeys: affectedArtifactKeys,
        };

  const summary = recommendation.kind === "repair-evidence"
    ? `校验器没有发现必须重写代码的硬失败；${affectedArtifactKeys.length} 份证据共有 ${diagnostics.length} 条格式或追溯问题。你不需要手写 Markdown，也不需要先重写源代码。`
    : recommendation.kind === "rerun-implementation"
      ? `共有 ${diagnostics.length} 条问题，其中至少一条表示真实任务、代码或测试尚未完成，不能只修文档。`
      : "当前缺少权威验收标准；先回到 Product 补正式 AC，工程角色不能替你决定产品标准。";

  return {
    title: "工程证据还不能通过",
    summary,
    actions: [...actions.values()],
    diagnostics,
    issueCount: diagnostics.length,
    affectedArtifactKeys,
    recommendation,
  };
}

function engineeringArtifactKeyFromIssue(issue: string): EngineeringArtifactKey | undefined {
  return ENGINEERING_OUTPUT_KEYS.find((key) => issue.startsWith(`${key}:`));
}

function engineeringArtifactName(key: EngineeringArtifactKey): string {
  return {
    "implementation-notes": "实现说明",
    "implementation-plan": "实施计划",
    "implementation-tasks": "实施任务",
    "engineering-session-log": "工程会话日志",
    "engineering-test-evidence": "独立测试证据",
    "engineering-review": "工程七镜审查",
    "engineering-provenance": "PR 证据链",
  }[key];
}

function isHardImplementationIssue(issue: string): boolean {
  return /(?:explicit Failed or Blocked disposition|every task must be complete; unfinished|Commands and results contains a failed, skipped, blocked, or unrun command|contains an unresolved security finding)/iu.test(issue);
}

function localizeEngineeringIssue(issue: string, artifactKey: EngineeringArtifactKey): string {
  const detail = issue.slice(`${artifactKey}:`.length).trim();
  const exactStatus = /^Status must be exactly (.+)$/iu.exec(detail)?.[1];
  if (exactStatus) return `状态字段必须精确写为「${exactStatus}」，当前表述不符合机器合同。`;
  const missingIndex = /^Evidence index does not link (.+)$/iu.exec(detail)?.[1];
  if (missingIndex) {
    const linkedKey = ENGINEERING_OUTPUT_KEYS.find((key) => key === missingIndex);
    return `证据索引缺少「${linkedKey ? engineeringArtifactName(linkedKey) : missingIndex}」的注册链接。`;
  }
  if (/Outcome must record a complete, non-blocked result/iu.test(detail)) {
    return "Outcome 没有用机器可识别的 Complete 终态记录本次实施结果。";
  }
  if (/Verification gates contains an explicit blocked or failed gate result/iu.test(detail)) {
    return "Verification gates 中仍出现非通过结果；Tester 后续验证事项应写入交接/限制，不应冒充 Implementation 阻塞。";
  }
  if (/Tier [AB] requires a concrete test-authoring model\/session/iu.test(detail)) {
    return `${detail.match(/Tier [AB]/iu)?.[0] ?? "独立测试"} 缺少可追溯的测试作者模型或独立会话标识。`;
  }
  if (/requires durable requirements-visible evidence/iu.test(detail)) {
    return "独立测试没有记录测试作者当时可见的需求版本或持久引用。";
  }
  if (/requires Implementation visible while authoring: No/iu.test(detail)) {
    return "Tier A/B 必须明确记录「Implementation visible while authoring: No」。";
  }
  if (/requires a durable frozen test-intent reference/iu.test(detail)) {
    return "独立测试缺少测试意图冻结时间、消息或其他持久引用。";
  }
  if (/contradicts same-session or implementation-visible/iu.test(detail)) {
    return "独立性声明与同会话/已见实现的文字互相矛盾，不能标为 Tier A/B。";
  }
  const uncoveredId = /acceptance criterion ([\w-]+) has no passing automated-test row/iu.exec(detail)?.[1];
  if (uncoveredId) {
    return `${uncoveredId} 缺少包含真实测试路径、测试名、证据引用和 Pass 结果的完整自动化测试行。`;
  }
  const reviewSection = /section "([^"]+)" actionable finding lacks/iu.exec(detail)?.[1];
  if (reviewSection) {
    return `「${reviewSection}」没有使用完整 finding 表格；若无问题，Finding ID 必须精确填写 none found。`;
  }
  const adversarialMethod = /adversarial method "([^"]+)" must contain/iu.exec(detail)?.[1];
  if (adversarialMethod) return `对抗检查「${adversarialMethod}」必须记录完整 finding，或精确写 none found。`;
  if (/section "Adversarial pass" must be non-empty/iu.test(detail)) {
    return "Adversarial pass 缺少平台可识别的 finding/none found 结论。";
  }
  const evidenceField = /evidence field "([^"]+)" must contain/iu.exec(detail)?.[1];
  if (evidenceField) return `证据字段「${evidenceField}」缺少可追溯的 artifact、文件路径或 URL。`;
  if (/Publication boundary must state/iu.test(detail)) {
    return "发布边界没有分别明确：Software Engineer 未发布 PR，也未执行合并或发布。";
  }
  const missingPart = /required section or field "([^"]+)" is missing/iu.exec(detail)?.[1];
  if (missingPart) return `缺少必要章节或字段「${missingPart}」。`;
  if (/unresolved <\.\.\.> or \{\{\.\.\.\}\} placeholder found/iu.test(detail)) {
    return "仍含 <...> 或 {{...}} 等未解决占位内容。";
  }
  return `机器校验：${detail}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}
