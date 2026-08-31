import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Source-level browser acceptance checks derived from CHAT-AC-01..20.
 *
 * These checks intentionally avoid component/CSS names. They locate the
 * Chat-first workspace by its user-visible and API semantics, then guard the
 * default journey against regressing into the old Project -> Create Run form.
 * Runtime browser coverage should complement, not replace, these checks.
 */

const srcRoot = fileURLToPath(new URL("../src", import.meta.url));
const productSpecPath = fileURLToPath(new URL("../../../docs/chat-first-cloud-agent-spec.md", import.meta.url));

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(srcRoot, relativePath), "utf8");
}

async function sourceFiles(directory = srcRoot): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(absolute));
    if (entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name)) files.push(absolute);
  }
  return files;
}

async function readWorkspace(): Promise<{ paths: string[]; text: string }> {
  const files = await sourceFiles();
  const candidates: Array<{ path: string; text: string }> = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    if (
      /@repo|@仓库/u.test(text)
      && /agent[- ]?session|Agent Session|Agent 会话|sendAgentMessage/u.test(text)
      && /textarea|contentEditable|消息输入框|发送消息/u.test(text)
    ) {
      candidates.push({ path: file, text });
    }
  }
  assert.ok(candidates.length > 0, "a Chat-first Agent Session workspace must exist");
  return {
    paths: candidates.map(({ path: file }) => file),
    text: candidates.map(({ text }) => text).join("\n"),
  };
}

test("CHAT-AC-03/18: the default route opens one Chat-first workspace instead of the Project/Run intake funnel", async () => {
  const [app, workspace] = await Promise.all([source("App.tsx"), readWorkspace()]);

  assert.match(app, /WorkspacePage|AgentWorkspace|ChatWorkspace/u);
  assert.match(app, /<\s*(?:Agent)?WorkspacePage|<\s*ChatWorkspace/u);
  assert.match(workspace.text, /@repo|@仓库/u);
  assert.match(workspace.text, /textarea|contentEditable/u);

  assert.doesNotMatch(workspace.text, /CreateRunDialog/u);
  assert.doesNotMatch(workspace.text, /api\.createRun/u);
  assert.doesNotMatch(workspace.text, /EMPTY_CHANGE_CONTRACT_DRAFT|changeContractMissingFields/u);
  assert.doesNotMatch(workspace.text, /先创建工作流|确认并创建交付任务/u);
});

test("CHAT-AC-01/02/03: binding asks for remote repository authorization, then enters chat without waiting for LLM DeepWiki", async () => {
  const workspace = await readWorkspace();
  const allFiles = await sourceFiles();
  const bindingParts: string[] = [];
  for (const file of allFiles) {
    const text = await readFile(file, "utf8");
    if (/bindRemoteRepository|绑定(?:远端|Git )?仓库/u.test(text)) bindingParts.push(text);
  }
  const binding = bindingParts.join("\n");
  assert.ok(binding.length > 0, "the workspace must offer repository binding");
  assert.match(binding, /repositoryUrl|仓库地址/u);
  assert.match(binding, /credentialProfileId|授权|凭据/u);
  assert.doesNotMatch(binding, /required[^\n]{0,120}(?:项目名称|项目摘要)|(?:项目名称|项目摘要)[^\n]{0,120}required/u);

  assert.match(`${binding}\n${workspace.text}`, /agent[- ]?session|Agent Session|Agent 会话/u);
  assert.doesNotMatch(binding, /(?:onSuccess|onBound|bindRemoteRepository)[\s\S]{0,240}generateDeepWiki/u);
  assert.doesNotMatch(workspace.text, /knowledge\?\.status\s*===\s*["']ready["'][^\n]{0,220}(?:disabled|canSend)/u);
});

test("CHAT-AC-04/10: @repo resolution and the lazy Sandbox are first-class conversation context", async () => {
  const workspace = await readWorkspace();

  assert.match(workspace.text, /@repo|repoAlias|repositoryMentions/u);
  assert.match(workspace.text, /Sandbox|沙盒/u);
  assert.match(workspace.text, /starting|启动中/u);
  assert.match(workspace.text, /ready|已就绪/u);
  assert.match(workspace.text, /blueprint|蓝图/u);
  assert.match(workspace.text, /revision|版本/u);
  assert.match(workspace.text, /read(?:only)?|只读/u);
  assert.match(workspace.text, /write|可写/u);

  assert.doesNotMatch(workspace.text, /rootPath|hostPath|hostMount|dockerImage/u);
  assert.doesNotMatch(workspace.text, /--privileged|docker\.sock/u);
});

test("CHAT-AC-05/06/07: Provider is configured as a capability and can change for the next message without clearing the Session", async () => {
  const workspace = await readWorkspace();

  assert.match(workspace.text, /providerId|Provider|模型/u);
  assert.match(workspace.text, /select|combobox|切换/u);
  assert.match(workspace.text, /sendAgentMessage|agentSession/u);
  assert.match(workspace.text, /toolCalling|工具调用|只能对话|不能启动/u);
  assert.match(workspace.text, /当前会话所选 Provider[\s\S]{0,160}API 的配置与内存边界/u);
  assert.match(workspace.text, /Sandbox[\s\S]{0,100}受限工具定义与结果[\s\S]{0,80}不接收 Provider 凭据/u);
  assert.doesNotMatch(workspace.text, /阶段 Codex Worker|阶段 Worker 使用独立/u);
  assert.doesNotMatch(workspace.text, /onChange[^\n]{0,300}(?:createAgentSession|clearConversation|clearSession)/u);
  assert.doesNotMatch(workspace.text, /API_KEY|apiKey|type=["']password["']/u);
});

test("CHAT-AC-08/13/17: only read-only Work Item MCP is exposed and the real inline gate is Artifact review", async () => {
  const workspace = await readWorkspace();

  assert.match(workspace.text, /MCP/u);
  assert.match(workspace.text, /已启用|已激活|active|enabled/u);
  assert.match(workspace.text, /只读 Work Item/u);
  assert.match(workspace.text, /非只读 MCP[\s\S]{0,100}尚未开放|尚未开放[^\n]{0,80}非只读/u);
  assert.match(workspace.text, /角色产物审阅|查看产物并决定/u);
  assert.match(workspace.text, /const readOnly[\s\S]{0,300}const available\s*=\s*readOnly/u);
  assert.match(workspace.text, /disabled=\{!available \|\| busy\}/u);

  assert.doesNotMatch(workspace.text, /listWorkItemAdapters|resolveWorkItem/u);
  assert.doesNotMatch(workspace.text, /选择(?: Jira| Linear|任务来源)|任务来源[^\n]{0,100}<select/u);
  assert.doesNotMatch(workspace.text, /mcpCommand|secretEnv|toolName\s*:|command\s*:/u);
  assert.doesNotMatch(workspace.text, /外部写入、DDL、Secret、部署与发布会以内联 Human Gate/u);
  assert.doesNotMatch(workspace.text, /外部写入和其他副作用必须 approval/u);
  assert.doesNotMatch(workspace.text, /含外部写入/u);
  assert.doesNotMatch(workspace.text, /gate\.choices\.map/u);
});

test("CHAT-AC-17/ARCHITECT: inline Session review exposes revision-bound selection and repairs legacy checkpoints", async () => {
  const workspace = await readWorkspace();

  assert.match(workspace.text, /architectureOptionSummaries\(currentOptionsContent\)/u);
  assert.match(workspace.text, /architectureSelectionFromReviews/u);
  assert.match(workspace.text, /updateArchitectureSelectionMarker\(current, option\.id\)/u);
  assert.match(workspace.text, /让 Architect 结构化补做并重跑/u);
  assert.match(workspace.text, /通过当前规则簿语义校验/u);
  assert.match(workspace.text, /记录 Option \{architectureSelectionId\} 并让 Architect 继续/u);
  assert.match(workspace.text, /continueAfter: Boolean\(isArchitectureSelectionCheckpoint && hasValidArchitectureSelection\)/u);
  assert.match(
    workspace.text,
    /\{!isArchitectureSelectionCheckpoint \? \([\s\S]{0,500}批准并继续/u,
    "the ordinary approval action must be hidden at the architecture selection checkpoint",
  );
  assert.match(workspace.text, /这是轻量内容\/布局变更，不需要完整架构包/u);
  assert.match(workspace.text, /记录无需架构并进入工程/u);
  assert.match(workspace.text, /api\.waiveArchitecture/u);
  assert.match(workspace.text, /不依赖 Provider 工具调用/u);
});

test("CHAT-AC-09: composer sends the client idempotency key and expected sequence and can resume persisted history", async () => {
  const workspace = await readWorkspace();

  assert.match(workspace.text, /clientMessageId/u);
  assert.match(workspace.text, /expectedSequence/u);
  assert.match(workspace.text, /listAgentSessions|getAgentSession|agentSession/u);
  assert.match(workspace.text, /消息|message/u);
  assert.match(workspace.text, /事件|event|timeline/u);
  assert.doesNotMatch(workspace.text, /maxToolRounds\s*:|timeoutMs\s*:|maxToolOutputBytes\s*:/u);
});

test("Agent Sessions are archived from independent row/header actions and current routes recover safely", async () => {
  const [workspace, app, api] = await Promise.all([
    readWorkspace(),
    source("App.tsx"),
    source("lib/api.ts"),
  ]);
  const implementation = `${workspace.text}\n${app}\n${api}`;

  assert.match(api, /archiveAgentSession[\s\S]{0,500}method:\s*["']DELETE["']/u);
  assert.doesNotMatch(implementation, /deleteAgentSession/u, "browser deletion must remain server-side archival, not physical deletion");
  assert.match(workspace.text, /activeSessions\.map[\s\S]{0,1600}onSessionChange[\s\S]{0,1600}requestArchive/u);
  assert.match(workspace.text, /aria-label=[^\n]*删除当前 Agent Session/u);
  assert.equal(
    workspace.text.match(/title=["']删除 Agent Session？["']/gu)?.length,
    1,
    "Session deletion uses one confirmation layer",
  );
  assert.match(workspace.text, /target\.turnState !== ["']idle["']/u);
  assert.match(workspace.text, /sendMutation\.isPending/u);
  assert.match(workspace.text, /inlineReviewBusy/u);
  assert.match(workspace.text, /refetchInterval:[\s\S]{0,180}turnState[\s\S]{0,80}!== ["']idle["'][\s\S]{0,80}1_500/u);
  assert.match(workspace.text, /synchronizeAgentSessionSummary\(current, session\)/u);
  assert.match(workspace.text, /queryClient\.removeQueries\(\{ queryKey: \[["']agent-session["'], archived\.id\], exact: true \}\)/u);
  assert.match(workspace.text, /current\.filter\(\(\{ id \}\) => id !== archived\.id\)/u);
  assert.match(workspace.text, /session\?\.status !== ["']active["']/u);
  assert.match(workspace.text, /disabled=\{!sessionActive/u);
  assert.match(workspace.text, /aria-label=["']管理 Agent Sessions["'][\s\S]{0,100}setSessionMenuOpen\(true\)/u);
  assert.match(workspace.text, /open=\{sessionMenuOpen\}[\s\S]{0,2200}新建 Agent Session[\s\S]{0,2200}requestArchive/u);

  assert.match(app, /window\.history\.replaceState/u);
  assert.match(app, /onSessionReplace[\s\S]{0,300}replace:\s*true/u);
  assert.match(app, /<AgentWorkspacePage[\s\S]{0,100}key=\{route\.projectId\}/u);
  assert.match(workspace.text, /remainingSessionIds\[archivedIndex\]\s*\?\?\s*remainingSessionIds\[archivedIndex - 1\]/u);
  assert.match(workspace.text, /replacementId[\s\S]{0,400}requestCreateSession\(["']replace["']\)/u);
  assert.match(workspace.text, /最后一个可用 Session[\s\S]{0,100}自动创建/u);
  assert.match(workspace.text, /onSuccess:[\s\S]{0,400}creationRequestedRef\.current = false/u);
  assert.match(workspace.text, /createInFlightRef\.current[\s\S]{0,300}requestCreateSession/u);
  assert.match(workspace.text, /createSessionIntentRef[\s\S]{0,300}clientRequestId:\s*string/u);
  assert.match(workspace.text, /clientRequestId:\s*request\.clientRequestId/u);
  assert.match(workspace.text, /createSessionIntentRef\.current\?\.clientRequestId === request\.clientRequestId/u);
  assert.match(workspace.text, /createSessionMutation\.mutate\(intent\)/u);
  assert.doesNotMatch(
    workspace.text,
    /api\.createAgentSession\([\s\S]{0,240}clientRequestId:\s*crypto\.randomUUID\(\)/u,
    "a retry must reuse one Session creation intent instead of minting an id in mutationFn",
  );
  assert.match(workspace.text, /archiveInFlightRef\.current[\s\S]{0,300}archiveMutation\.mutate/u);
  assert.match(workspace.text, /routeSessionIdRef\.current !== routeSessionId/u);
});

test("CHAT-AC-11/12/14: SDLC runs behind the conversation and exposes a compact timeline, evidence, and advanced audit", async () => {
  const workspace = await readWorkspace();

  assert.match(workspace.text, /角色进度|SDLC|phase|阶段/u);
  for (const evidence of ["Diff", "测试", "风险"]) assert.match(workspace.text, new RegExp(evidence, "u"));
  assert.match(workspace.text, /产物|artifact/u);
  assert.match(workspace.text, /高级审计|审计详情|advanced audit/u);
  assert.match(workspace.text, /discovery|需求确认|PM \/ BA/u);
  assert.match(workspace.text, /release|发布准备|DevOps/u);

  assert.doesNotMatch(workspace.text, /selectedOutputKeys|selectedArtifactIds/u);
  assert.doesNotMatch(workspace.text, /每阶段.*审核|逐项审核/u);
});

test("CHAT-AC-11/12/14: awaiting review is handled inline without bypassing Artifact or human-decision gates", async () => {
  const workspace = await readWorkspace();

  assert.match(workspace.text, /awaiting_review/u);
  assert.match(workspace.text, /查看产物并决定/u);
  assert.match(workspace.text, /getArtifact/u);
  assert.match(workspace.text, /reviewStatus\s*!==\s*["']superseded["']|currentArtifactHeadIds/u);
  assert.match(workspace.text, /已查看[^\n]{0,80}(?:heads\.length|产物)|allViewed/u);
  assert.match(workspace.text, /批准并继续/u);
  assert.match(workspace.text, /要求修改/u);
  assert.match(workspace.text, /expectedArtifactIds/u);
  assert.match(workspace.text, /api\.reviewPhase/u);
  assert.match(workspace.text, /api\.reviewPhase[\s\S]{0,1200}onContinue/u);
  assert.match(workspace.text, /api\.advanceAgentRun/u);
  assert.match(workspace.text, /api\.getHumanDecisions/u);
  assert.match(workspace.text, /expectedPhaseId/u);
  assert.match(workspace.text, /result\.state === ["']failed["'][\s\S]{0,120}result\.state === ["']blocked["']/u);
  assert.match(workspace.text, /throw new Error\(result\.reason/u);
  assert.match(workspace.text, /仅批准产物/u);
  assert.match(workspace.text, /不影响本次审核[\s\S]{0,120}切换 Provider/u);
  assert.match(workspace.text, /后端门禁没有被绕过/u);
  assert.match(workspace.text, /decisionGate\.blockingCount > 0/u);
  assert.match(workspace.text, /选择架构方案/u);
  assert.match(workspace.text, /approvalBlocked/u);
  assert.match(workspace.text, /决定与待办状态暂时无法载入[\s\S]{0,120}批准会保持关闭/u);
  assert.match(workspace.text, /当前 Session Provider 尚未接入隔离检查 Runner/u);
  assert.match(workspace.text, /Verification 会保持 Blocked，不能批准/u);
  assert.match(workspace.text, /高级审计/u);

  assert.doesNotMatch(workspace.text, /sendAgentMessage\(latestSession/u);
  assert.doesNotMatch(workspace.text, /content:\s*`继续当前 Run/u);
  assert.doesNotMatch(workspace.text, /reviewPhase\([^)]*["']approve["'][^)]*\)\s*;?\s*(?:void\s+)?onOpenRun/u);
  assert.doesNotMatch(workspace.text, /(?:autoApprove|bypassHumanDecision|skipArtifactReview)/u);
});

test("Session keeps Run status, audit and review controls visible at every viewport width", async () => {
  const [workspace, visibility] = await Promise.all([
    readWorkspace(),
    source("lib/agent-failure-visibility.ts"),
  ]);
  const implementation = `${workspace.text}\n${visibility}`;

  assert.match(implementation, /latestAgentSessionRunPointer\(session\)/u);
  assert.match(visibility, /latestDurableRun[\s\S]{0,500}fallbackEvent/u);
  assert.match(workspace.text, /<SessionRunStatusCard/u);
  assert.match(workspace.text, /<RoleTimeline[\s\S]{0,80}compact/u);
  assert.match(workspace.text, /六角色进度 · 查看每阶段状态与产物/u);
  assert.match(workspace.text, /xl:hidden/u);
  assert.match(workspace.text, /aria-label=["']当前 Run 状态["']/u);
  assert.match(workspace.text, /Run ID/u);
  assert.match(workspace.text, /重试读取/u);
  for (const status of [
    "loading",
    "error",
    "pending",
    "locked",
    "running",
    "ready",
    "awaiting_review",
    "changes_requested",
    "rejected",
    "failed",
    "approved",
    "completed",
  ]) assert.match(workspace.text, new RegExp(`${status}:`, "u"));
  assert.match(workspace.text, /aria-live=["']assertive["']/u);
  assert.match(
    workspace.text,
    /awaitingReviewKey \? reviewAnnouncement : ["']["'][\s\S]{0,180}failedExecutionKey \? failureAnnouncement : ["']["']/u,
    "resolved review/running states must not retain an older failure announcement",
  );
  assert.match(workspace.text, /awaitingReviewKey[\s\S]{0,800}scrollIntoView/u);
  assert.match(workspace.text, /failedExecutionKey[\s\S]{0,900}setFailureAnnouncement[\s\S]{0,500}scrollIntoView/u);
  assert.match(workspace.text, /执行失败；Run、此前产物与审计记录仍保留/u);
  assert.match(
    workspace.text,
    /runStatusSignature[\s\S]{0,900}sessionQuery\.refetch\(\)/u,
    "CHAT-AC-29: an async Run state change refreshes the Session timeline projection",
  );
  assert.match(workspace.text, /phaseStatus:\s*PhaseRun\["status"\]\s*=\s*phase\?\.status/u);
  assert.match(workspace.text, /awaitingReview \? <Eye/u);
  assert.match(workspace.text, /artifactQuery\.refetch\(\)/u);
  assert.match(workspace.text, /重新读取/u);
  assert.match(workspace.text, /canStartCurrentPhase\s*=\s*Boolean\(!completed/u);
  assert.match(
    workspace.text,
    /phase\.status === ["']failed["'] && currentArtifactHeads\(phase\.artifacts\)\.length > 0[\s\S]{0,180}<FailedPhaseArtifactsCard/u,
    "CHAT-AC-29: failed Run artifacts remain inspectable inside the inherited Session",
  );
  assert.match(workspace.text, /查看失败后保留的产物/u);
  assert.match(workspace.text, /只读 · 不能批准/u);
  assert.match(workspace.text, /所选产物路径上未完成或未通过门禁的写入已回滚/u);
  assert.match(
    workspace.text,
    /const decisionAwarePhase = Boolean\([\s\S]{0,180}\[["']awaiting_review["'], ["']failed["']\]\.includes\(phase\.status\)[\s\S]{0,180}\[["']discovery["'], ["']design["'], ["']architecture["']\]\.includes\(phase\.phaseId\)/u,
    "CHAT-AC-29: failed product phases keep their decision/work/dependency gate visible",
  );
  assert.match(workspace.text, /const decisionsBlocking = Boolean\(decisionAwarePhase && decisionGate && decisionGate\.blockingCount > 0\)/u);
  assert.match(workspace.text, /本次不能批准；仍有 \$\{decisionGate\.blockingCount\} 项结构化决定或待办/u);
  assert.match(workspace.text, /decisionGate\.items\.filter\(\(\{ blocking \}\) => blocking\)\.slice\(0, 5\)/u);
  assert.match(workspace.text, /humanDecisionKindLabel\(item\)/u);
  assert.match(workspace.text, /decisionGate\.decisionCount[\s\S]{0,100}decisionGate\.workCount[\s\S]{0,100}decisionGate\.dependencyCount/u);
  assert.match(workspace.text, /在高级审计查看/u);
  assert.doesNotMatch(workspace.text, /<SessionRunStatusCard[^>]*className=["'][^"']*hidden/u);
});

test("CHAT-AC-15/16: DeepWiki generation is an explicit post-bind action with Provider and revision context", async () => {
  const [workspace, api] = await Promise.all([readWorkspace(), source("lib/api.ts")]);

  assert.match(workspace.text, /生成 DeepWiki|generateDeepWiki/u);
  assert.match(workspace.text, /providerId|Provider|模型/u);
  assert.match(workspace.text, /revision|版本/u);
  assert.match(workspace.text, /stale|已过期|需要重新生成/u);
  assert.match(workspace.text, /手动|按需|生成/u);
  assert.match(workspace.text, /设置弹窗通过 Project API 手动生成/u);
  assert.match(workspace.text, /会话命令和 @repo 菜单暂未提供/u);
  assert.match(workspace.text, /DEEP_WIKI_ACTIVE_STATUSES[\s\S]{0,200}["']queued["'][\s\S]{0,80}["']scanning["'][\s\S]{0,80}["']generating["'][\s\S]{0,80}["']validating["']/u);
  assert.match(workspace.text, /refetchInterval:[^\n]*deepWikiGenerationActive[^\n]*1_500/u);
  assert.match(workspace.text, /const busy = pending \|\| active/u, "queued server work must outlive the short POST mutation");
  assert.match(workspace.text, /等待服务端开始|正在扫描仓库|正在生成项目知识|正在校验生成结果/u);
  assert.match(workspace.text, /generation\.errorMessage/u);
  assert.match(workspace.text, /DeepWiki 生成失败/u);
  assert.match(workspace.text, /重试生成/u);
  assert.match(workspace.text, /关闭这个设置弹窗不会中止生成/u);
  assert.match(api, /getLatestPublishedDeepWiki[\s\S]{0,400}deepwiki\/generations\/published/u);
  assert.match(workspace.text, /deepWikiGenerationPublished[\s\S]{0,400}setQueryData\(\[["']deepwiki-published["']/u);
  assert.match(workspace.text, /function deepWikiGenerationPublished[\s\S]{0,180}generation\.status === ["']ready["']/u);
  assert.doesNotMatch(workspace.text, /function deepWikiGenerationPublished[\s\S]{0,180}generation\.status === ["']stale["']/u);
  assert.match(workspace.text, /invalidateQueries\(\{ queryKey: \[["']deepwiki-published["']/u);
  assert.match(workspace.text, /deepWikiInFlightRef\.current[\s\S]{0,500}deepWikiMutation\.mutate/u);
  assert.match(workspace.text, /deepWikiGenerationIntentRef[\s\S]{0,500}clientRequestId:\s*string[\s\S]{0,300}baselineGenerationId/u);
  assert.match(workspace.text, /clientRequestId:\s*intent\.clientRequestId/u);
  assert.match(workspace.text, /deepWikiGenerationIntentRef\.current\?\.clientRequestId === intent\.clientRequestId[\s\S]{0,160}deepWikiGenerationIntentRef\.current = undefined/u);
  assert.match(workspace.text, /latest\.id === intent\.baselineGenerationId[\s\S]{0,160}deepWikiGenerationIntentRef\.current = undefined/u);
  assert.match(workspace.text, /intent\.expectedRevision !== expectedRevision/u);
  assert.match(workspace.text, /intent\.providerId !== targetProvider\.id/u);
  assert.match(workspace.text, /onError:[\s\S]{0,600}queryKey:\s*\[["']deepwiki["'], intent\.projectId\][\s\S]{0,300}deepWikiQuery\.refetch\(\)/u);
  assert.doesNotMatch(workspace.text, /generateDeepWiki\([\s\S]{0,300}clientRequestId:\s*crypto\.randomUUID\(\)/u);
  assert.match(workspace.text, /latestStatusError[\s\S]{0,1500}publishedStatusError/u);
  assert.match(workspace.text, /查看上一个可用版本/u);
  assert.match(workspace.text, /查看已发布版本/u);
  assert.match(workspace.text, /旧 DeepWiki 仍可阅读，不会被失败任务覆盖/u);
  assert.doesNotMatch(workspace.text, /useEffect\([^)]*generateDeepWiki|onBound[^\n]{0,500}generateDeepWiki/u);
  assert.doesNotMatch(workspace.text, /用户可在仓库设置、会话命令或[^\n]*@repo[^\n]*菜单中[^\n]*生成/u);
});

test("a failed manual Session create remains visible in the desktop conversation without leaking across routes", async () => {
  const workspace = await readWorkspace();

  assert.match(workspace.text, /createSessionFailureIsCurrent[\s\S]{0,250}routeProjectId === projectId[\s\S]{0,160}routeSessionId === sessionId/u);
  assert.match(workspace.text, /sessionActive && createSessionFailureIsCurrent[\s\S]{0,500}新会话创建失败[\s\S]{0,500}failedCreateNavigation \?\? ["']push["']/u);
});

test("CHAT-AC-19/20: the default workspace offers Patch/audit, not privilege elevation or automatic external delivery", async () => {
  const workspace = await readWorkspace();

  assert.match(workspace.text, /Patch|补丁|Diff/u);
  assert.match(workspace.text, /高级审计|审计详情|Run/u);
  assert.doesNotMatch(workspace.text, /bypassSandbox|trustRepositoryInstructions|allowAllMcp/u);
  assert.doesNotMatch(workspace.text, /autoPush|autoMerge|autoDeploy|autoRelease/u);
  assert.doesNotMatch(workspace.text, /自动(?: push|创建 PR|合并|部署|发布)/u);
});

test("failed event noise can be cleared without deleting Session or SDLC audit state", async () => {
  const [workspace, visibility] = await Promise.all([
    readWorkspace(),
    source("lib/agent-failure-visibility.ts"),
  ]);
  const implementation = `${workspace.text}\n${visibility}`;

  assert.match(implementation, /此浏览器清理失败提示/u);
  assert.match(implementation, /恢复失败提示/u);
  assert.match(implementation, /localStorage/u);
  assert.match(implementation, /服务端审计记录仍保留/u);
  assert.match(implementation, /turn\.failed/u);
  assert.match(implementation, /tool\.failed/u);
  assert.match(implementation, /sandbox\.failed/u);
  assert.match(implementation, /key=\{session\.id\}/u);
  assert.match(implementation, /latestAgentSessionRunPointer\(session\)/u);
  assert.match(implementation, /<RoleTimeline[\s\S]{0,120}session=\{session\}/u);
  assert.doesNotMatch(implementation, /deleteAgentSession|deleteWorkflowRun|deleteArtifact/u);
});

test("the Chat-first product spec names only implemented entry points and security gates", async () => {
  const spec = await readFile(productSpecPath, "utf8");

  assert.match(spec, /当前已实现的入口只有仓库设置弹窗[^\n]*Project API/u);
  assert.match(spec, /会话命令和 `@repo` 菜单入口尚未实现/u);
  assert.match(spec, /外部写入、DDL、Secret 操作、部署和发布工具在当前 MVP 尚未开放/u);
  assert.match(spec, /当前内联门禁只用于角色阶段产物审阅，而且不得自动批准/u);
  assert.match(
    spec,
    /项目 Provider 的凭据[^\n]*不进入[^\n]*Provider-native 文件工具[^\n]*独立 Codex Run[^\n]*低权限运行密钥/u,
  );
  assert.match(spec, /Chat-first 六阶段复用当前会话选中的 Provider 和有界历史/u);
  assert.match(spec, /不向模型提供任意 Shell、命令、网络工具或外部副作用/u);

  assert.doesNotMatch(spec, /用户可在仓库设置、会话命令或[^\n]*@repo[^\n]*菜单中[^\n]*生成/u);
  assert.doesNotMatch(spec, /外部副作用产生 Human Gate/u);
  assert.doesNotMatch(spec, /外部写入、删除、push、PR、部署和发布必须等待人类确认/u);
});
