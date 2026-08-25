import { existsSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import {
  PHASE_IDS,
  phaseIdSchema,
  type PhaseDefinition,
  type WorkflowDefinition
} from "@ai-sdlc/contracts";
import YAML from "yaml";
import { z } from "zod";

import { AppError } from "../domain/errors.js";
import { isWithin } from "./project-paths.js";

const identifierSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const definitionAgentClientSchema = z.enum(["github-copilot", "claude-code", "codex"]);
const expectedRoleIds = [
  "pm-ba",
  "designer",
  "architect",
  "software-engineer",
  "tester",
  "devops",
] as const;
const nativeAgentContracts = {
  "github-copilot": {
    directory: ".github/agents",
    fileName: (roleId: string) => `${roleId}.agent.md`,
  },
  "claude-code": {
    directory: ".claude/agents",
    fileName: (roleId: string) => `${roleId}.md`,
  },
  codex: {
    directory: ".codex/agents",
    fileName: (roleId: string) => `${roleId}.toml`,
  },
} as const;
const canonicalOwnerNamespaces: Record<(typeof expectedRoleIds)[number], string> = {
  "pm-ba": "product",
  designer: "design",
  architect: "architecture",
  "software-engineer": "engineering",
  tester: "testing",
  devops: "operations",
};

const configSchema = z.object({
  version: z.number().int().positive(),
  capabilities: z.object({
    release_evidence: z.literal("v1").optional(),
  }).optional(),
  project: z.object({
    name: z.string(),
    summary: z.string(),
    locale: z.string().optional()
  }),
  agent: z.object({ client: definitionAgentClientSchema }),
  paths: z.object({ agents: z.string(), outputs: z.string() }),
  roles: z.array(z.object({
    id: identifierSchema,
    name: z.string(),
    mission: z.string(),
    responsibilities: z.array(z.string())
  })),
  workflow: z.object({
    phases: z.array(z.object({
      id: phaseIdSchema,
      owner: z.string(),
      inputs: z.array(z.string()),
      outputs: z.array(z.string()),
      gate: z.string()
    }))
  }),
  artifacts: z.array(z.object({
    id: identifierSchema,
    owner: identifierSchema,
    path: z.string()
  }))
});

type RawConfig = z.infer<typeof configSchema>;

export interface LoadedDefinition extends WorkflowDefinition {
  agentClient: string;
  agentDirectory: string;
  outputRoot: string;
  releaseEvidenceValidationRequired: boolean;
  artifacts: LoadedArtifactDefinition[];
  configPath: string;
}

export interface LoadedArtifactDefinition {
  id: string;
  owner: string;
  relativePath: string;
  absolutePath: string;
  /** Optional output injected in memory for an older project definition. */
  platformInjected?: boolean;
}

export async function loadDefinition(projectRoot: string): Promise<LoadedDefinition> {
  const configPath = path.join(projectRoot, "ai-native.yaml");
  if (!existsSync(configPath)) {
    throw new AppError("目录中未找到 ai-native.yaml；请先初始化或将 initialize 设为 true", 400, "CONFIG_MISSING");
  }
  if ((await lstat(configPath)).isSymbolicLink()) {
    throw new AppError("ai-native.yaml 不能是符号链接", 400, "UNSAFE_CONFIG_PATH");
  }
  let config: RawConfig;
  try {
    config = configSchema.parse(YAML.parse(await readFile(configPath, "utf8")));
  } catch (error) {
    throw new AppError("ai-native.yaml 格式无效", 400, "CONFIG_INVALID", error);
  }
  const platformInjectedArtifactIds = new Set<string>();
  registerPlatformChangeContract(config, platformInjectedArtifactIds);
  registerPlatformDesignOutputs(config, platformInjectedArtifactIds);
  registerPlatformVerificationDesignInput(config);
  registerPlatformArchitectureOutputs(config, platformInjectedArtifactIds);

  const phaseIds = config.workflow.phases.map((phase) => phase.id);
  if (phaseIds.length !== PHASE_IDS.length || phaseIds.some((id, index) => id !== PHASE_IDS[index])) {
    throw new AppError(
      `MVP 仅支持固定阶段顺序：${PHASE_IDS.join(" -> ")}`,
      400,
      "UNSUPPORTED_WORKFLOW"
    );
  }
  const expectedOwners = expectedRoleIds;
  const roleIds = new Set(config.roles.map((role) => role.id));
  if (roleIds.size !== config.roles.length) {
    throw new AppError("roles 包含重复 id", 400, "CONFIG_INVALID");
  }
  for (const [position, phase] of config.workflow.phases.entries()) {
    if (!roleIds.has(phase.owner)) {
      throw new AppError(`阶段 ${phase.id} 的角色 ${phase.owner} 未定义`, 400, "CONFIG_INVALID");
    }
    if (phase.owner !== expectedOwners[position]) {
      throw new AppError(`阶段 ${phase.id} 必须由固定角色 ${expectedOwners[position]} 执行`, 400, "UNSUPPORTED_WORKFLOW");
    }
  }

  const agentContract = nativeAgentContracts[config.agent.client];
  if (config.paths.agents !== agentContract.directory) {
    throw new AppError(
      `agent.client ${config.agent.client} 必须使用标准 Agent 目录 ${agentContract.directory}`,
      400,
      "CONFIG_INVALID",
    );
  }
  const agentRoot = safeProjectPath(projectRoot, config.paths.agents);
  const outputRoot = safeProjectPath(projectRoot, config.paths.outputs);
  await validateConfiguredOutputRoot(projectRoot, outputRoot);
  await validateNativeAgentFiles(
    projectRoot,
    config.agent.client,
    agentRoot,
    false,
  );
  const subdirectories = await readRoleSubdirectories(projectRoot, outputRoot, roleIds);
  registerPlatformEngineeringOutputs(
    config,
    subdirectories.has("software-engineer"),
    platformInjectedArtifactIds,
  );
  registerPlatformReleaseInputs(config, subdirectories.has("devops"));
  const artifactIds = new Set(config.artifacts.map((artifact) => artifact.id));
  if (artifactIds.size !== config.artifacts.length) {
    throw new AppError("artifacts 包含重复 id", 400, "CONFIG_INVALID");
  }
  const artifacts = config.artifacts.map((artifact) => {
    if (!roleIds.has(artifact.owner)) {
      throw new AppError(`产物 ${artifact.id} 的角色 ${artifact.owner} 未定义`, 400, "CONFIG_INVALID");
    }
    assertSafeArtifactPath(artifact.id, artifact.path);
    const subdirectory = subdirectories.get(artifact.owner);
    const ownerRoot = subdirectory
      ? resolveWithinOutputRoot(outputRoot, subdirectory, `角色 ${artifact.owner} 的 output.subdirectory`)
      : outputRoot;
    const absolutePath = path.resolve(ownerRoot, ...artifact.path.split("/"));
    if (!isWithin(outputRoot, absolutePath) || !isWithin(ownerRoot, absolutePath)) {
      throw new AppError(
        `产物 ${artifact.id} 的路径逃逸 owner 输出目录：${artifact.path}`,
        400,
        "CONFIG_INVALID",
      );
    }
    assertOwnerNamespace(artifact.id, artifact.owner, outputRoot, absolutePath);
    assertArtifactDoesNotOverlapControls(
      artifact.id,
      absolutePath,
      [
        path.join(projectRoot, "ai-native.yaml"),
        path.join(projectRoot, ".ai-sdlc"),
        path.join(projectRoot, ".git"),
        agentRoot,
      ],
    );
    const relativePath = path.relative(projectRoot, absolutePath).split(path.sep).join("/");
    return {
      id: artifact.id,
      owner: artifact.owner,
      relativePath,
      absolutePath,
      platformInjected: platformInjectedArtifactIds.has(artifact.id),
    };
  });
  const artifactByPath = new Map<string, string>();
  for (const artifact of artifacts) {
    const physicalKey = comparablePhysicalPath(artifact.absolutePath);
    const existing = artifactByPath.get(physicalKey);
    if (existing) {
      throw new AppError(
        `产物 ${existing} 与 ${artifact.id} 指向同一路径 ${artifact.relativePath}`,
        400,
        "CONFIG_INVALID"
      );
    }
    artifactByPath.set(physicalKey, artifact.id);
  }
  for (const [index, left] of artifacts.entries()) {
    for (const right of artifacts.slice(index + 1)) {
      if (
        comparablePathIsWithin(left.absolutePath, right.absolutePath)
        || comparablePathIsWithin(right.absolutePath, left.absolutePath)
      ) {
        throw new AppError(
          `产物 ${left.id} 与 ${right.id} 的路径不能互相嵌套`,
          400,
          "CONFIG_INVALID",
        );
      }
    }
  }

  const producerPositions = new Map<string, number>();
  for (const [position, phase] of config.workflow.phases.entries()) {
    for (const output of phase.outputs) {
      const artifact = artifacts.find((item) => item.id === output);
      if (!artifact) {
        throw new AppError(`阶段 ${phase.id} 的输出 ${output} 未注册`, 400, "CONFIG_INVALID");
      }
      if (artifact.owner !== phase.owner) {
        throw new AppError(`阶段 ${phase.id} 的输出 ${output} owner 不匹配`, 400, "CONFIG_INVALID");
      }
      if (producerPositions.has(output)) {
        throw new AppError(`产物 ${output} 被多个阶段声明为输出`, 400, "CONFIG_INVALID");
      }
      producerPositions.set(output, position);
    }
  }
  for (const [position, phase] of config.workflow.phases.entries()) {
    for (const input of phase.inputs) {
      const producer = producerPositions.get(input);
      if (producer === undefined || producer >= position) {
        throw new AppError(`阶段 ${phase.id} 的输入 ${input} 必须来自更早阶段`, 400, "CONFIG_INVALID");
      }
    }
  }

  const releaseEvidenceValidationRequired = await hasCompleteReleaseEvidencePack(
    projectRoot,
    config.capabilities?.release_evidence === "v1",
  );

  return {
    version: config.version,
    project: config.project,
    roles: config.roles,
    phases: config.workflow.phases as PhaseDefinition[],
    agentClient: config.agent.client,
    agentDirectory: config.paths.agents,
    outputRoot,
    releaseEvidenceValidationRequired,
    artifacts,
    configPath
  };
}

const platformDesignArtifacts = [
  { id: "design-prototype", owner: "designer", path: "prototype.html" },
  { id: "figma-handoff", owner: "designer", path: "figma-handoff.md" }
] as const;

const platformChangeContractArtifact = {
  id: "change-contract",
  owner: "pm-ba",
  path: "change-contract.md",
} as const;

const changeContractInputPhaseIds = [
  "design",
  "architecture",
  "implementation",
  "verification",
  "release",
] as const;

/**
 * Older initialized projects predate the immutable per-Run Change Contract.
 * Extend their parsed definition in memory so routing has one canonical input,
 * while leaving the project-owned ai-native.yaml byte-for-byte unchanged.
 */
function registerPlatformChangeContract(config: RawConfig, injected: Set<string>): void {
  if (!config.artifacts.some((artifact) => artifact.id === platformChangeContractArtifact.id)) {
    config.artifacts.push({ ...platformChangeContractArtifact });
    injected.add(platformChangeContractArtifact.id);
  }

  const discovery = config.workflow.phases.find((phase) => phase.id === "discovery");
  if (discovery && !discovery.outputs.includes(platformChangeContractArtifact.id)) {
    discovery.outputs.unshift(platformChangeContractArtifact.id);
  }

  for (const phaseId of changeContractInputPhaseIds) {
    const phase = config.workflow.phases.find((candidate) => candidate.id === phaseId);
    if (phase && !phase.inputs.includes(platformChangeContractArtifact.id)) {
      phase.inputs.unshift(platformChangeContractArtifact.id);
    }
  }
}

const platformArchitectureArtifacts = [
  { id: "architecture", owner: "architect", path: "architecture.md" },
  { id: "architecture-discovery-context", owner: "architect", path: "00-discovery-context.md" },
  { id: "architecture-options", owner: "architect", path: "00-options.md" },
  { id: "architecture-c4-context", owner: "architect", path: "01-context.mmd" },
  { id: "architecture-c4-containers", owner: "architect", path: "02-containers.mmd" },
  { id: "architecture-adrs", owner: "architect", path: "04-adrs" },
  { id: "architecture-patterns", owner: "architect", path: "05-patterns.md" },
  { id: "architecture-nfrs", owner: "architect", path: "06-nfrs.md" },
  { id: "architecture-adversarial", owner: "architect", path: "07-adversarial.md" }
] as const;

const platformEngineeringArtifacts = [
  {
    id: "implementation-notes",
    owner: "software-engineer",
    path: "ai-native/engineering/implementation-notes.md",
  },
  {
    id: "implementation-plan",
    owner: "software-engineer",
    path: "ai-native/engineering/implementation-plan.md",
  },
  {
    id: "implementation-tasks",
    owner: "software-engineer",
    path: "ai-native/engineering/implementation-tasks.md",
  },
  {
    id: "engineering-session-log",
    owner: "software-engineer",
    path: "ai-native/engineering/session-log.md",
  },
  {
    id: "engineering-test-evidence",
    owner: "software-engineer",
    path: "ai-native/engineering/independent-test-evidence.md",
  },
  {
    id: "engineering-review",
    owner: "software-engineer",
    path: "ai-native/engineering/review.md",
  },
  {
    id: "engineering-provenance",
    owner: "software-engineer",
    path: "ai-native/engineering/pr-provenance.md",
  },
] as const;

/**
 * Older initialized projects predate selectable HTML/Figma design deliverables.
 * Treat these two platform capabilities as a backwards-compatible extension so
 * existing runs do not need their project-owned ai-native.yaml rewritten.
 */
function registerPlatformDesignOutputs(config: RawConfig, injected: Set<string>): void {
  const design = config.workflow.phases.find((phase) => phase.id === "design");
  if (!design) return;
  for (const artifact of platformDesignArtifacts) {
    if (!config.artifacts.some((candidate) => candidate.id === artifact.id)) {
      config.artifacts.push({ ...artifact });
      injected.add(artifact.id);
    }
    if (!design.outputs.includes(artifact.id)) design.outputs.push(artifact.id);
  }
}

/**
 * Older initialized projects did not route the approved design contract to
 * Tester. Add it in memory so post-implementation responsive/accessibility
 * obligations cannot disappear between Design and Verification.
 */
function registerPlatformVerificationDesignInput(config: RawConfig): void {
  const verification = config.workflow.phases.find((phase) => phase.id === "verification");
  const hasDesignSpec = config.artifacts.some((artifact) => artifact.id === "design-spec");
  if (!verification || !hasDesignSpec || verification.inputs.includes("design-spec")) return;
  const downstreamEvidenceIndex = verification.inputs.findIndex((input) =>
    input.startsWith("architecture")
    || input.startsWith("implementation")
    || input.startsWith("engineering-")
  );
  verification.inputs.splice(
    downstreamEvidenceIndex >= 0 ? downstreamEvidenceIndex : verification.inputs.length,
    0,
    "design-spec",
  );
}

/**
 * Older initialized projects registered only the architecture pack index. The
 * platform now treats the complete architecture pack as one canonical contract,
 * while keeping the project-owned YAML immutable for backwards compatibility.
 */
function registerPlatformArchitectureOutputs(config: RawConfig, injected: Set<string>): void {
  const architecture = config.workflow.phases.find((phase) => phase.id === "architecture");
  if (!architecture) return;
  for (const artifact of platformArchitectureArtifacts) {
    if (!config.artifacts.some((candidate) => candidate.id === artifact.id)) {
      config.artifacts.push({ ...artifact });
      injected.add(artifact.id);
    }
    if (!architecture.outputs.includes(artifact.id)) architecture.outputs.push(artifact.id);
  }
}

/**
 * Older initialized projects registered only implementation-notes. Extend the
 * live definition with the complete Web-reviewable engineering evidence pack.
 * The explicit paths retain the legacy no-config layout; newly initialized
 * projects declare basename paths beneath the role's output subdirectory.
 */
function registerPlatformEngineeringOutputs(
  config: RawConfig,
  hasRoleOutputSubdirectory: boolean,
  injected: Set<string>,
): void {
  const implementation = config.workflow.phases.find((phase) => phase.id === "implementation");
  if (!implementation) return;
  for (const artifact of platformEngineeringArtifacts) {
    const existing = config.artifacts.find((candidate) => candidate.id === artifact.id);
    const legacyPath = `ai-native/engineering/${path.posix.basename(artifact.path)}`;
    if (existing && hasRoleOutputSubdirectory && existing.path === legacyPath) {
      existing.path = path.posix.basename(artifact.path);
    }
    if (!existing) {
      config.artifacts.push({
        ...artifact,
        path: hasRoleOutputSubdirectory ? path.posix.basename(artifact.path) : artifact.path,
      });
      injected.add(artifact.id);
    }
    if (!implementation.outputs.includes(artifact.id)) implementation.outputs.push(artifact.id);
  }

  const verification = config.workflow.phases.find((phase) => phase.id === "verification");
  for (const artifactId of ["engineering-test-evidence", "engineering-review"]) {
    if (verification && !verification.inputs.includes(artifactId)) {
      verification.inputs.push(artifactId);
    }
  }
}

/**
 * Released project definitions before the DevOps v1 pack did not route the
 * immutable Run contract or the implementation provenance into Release. Keep
 * the project-owned YAML unchanged while making the effective Release input
 * contract complete and deterministic.
 */
function registerPlatformReleaseInputs(
  config: RawConfig,
  hasRoleOutputSubdirectory: boolean,
): void {
  const release = config.workflow.phases.find((phase) => phase.id === "release");
  if (!release) return;
  const releaseRunbook = config.artifacts.find((artifact) => artifact.id === "release-runbook");
  if (
    releaseRunbook
    && hasRoleOutputSubdirectory
    && releaseRunbook.path === "ai-native/operations/release-runbook.md"
  ) {
    releaseRunbook.path = "release-runbook.md";
  }
  const requiredInputs = [
    "change-contract",
    "implementation-notes",
    "engineering-provenance",
  ] as const;
  for (const artifactId of requiredInputs) {
    if (release.inputs.includes(artifactId)) continue;
    if (artifactId === "change-contract") {
      release.inputs.unshift(artifactId);
      continue;
    }
    const testReportIndex = release.inputs.indexOf("test-report");
    release.inputs.splice(
      testReportIndex >= 0 ? testReportIndex : release.inputs.length,
      0,
      artifactId,
    );
  }
}

function safeProjectPath(projectRoot: string, relative: string): string {
  if (
    path.isAbsolute(relative)
    || /^[a-z]:\//iu.test(relative)
    || relative.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(relative)
  ) {
    throw new AppError(`配置包含不安全路径：${relative}`, 400, "UNSAFE_CONFIG_PATH");
  }
  const resolved = path.resolve(projectRoot, relative);
  if (!isWithin(projectRoot, resolved)) {
    throw new AppError(`配置路径逃逸项目目录：${relative}`, 400, "UNSAFE_CONFIG_PATH");
  }
  return resolved;
}

function assertSafeArtifactPath(artifactId: string, relative: string): void {
  const segments = relative.split("/");
  if (
    !relative
    || path.isAbsolute(relative)
    || /^[a-z]:\//iu.test(relative)
    || relative.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(relative)
    || segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new AppError(
      `产物 ${artifactId} 包含不安全的原始路径：${JSON.stringify(relative)}`,
      400,
      "CONFIG_INVALID",
    );
  }
}

function normalizeRoleSubdirectory(roleId: string, relative: string): string {
  const segments = relative.split("/");
  if (segments.at(-1) === "") segments.pop();
  if (
    segments.length === 0
    || path.isAbsolute(relative)
    || /^[a-z]:\//iu.test(relative)
    || relative.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(relative)
    || segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new AppError(
      `角色 ${roleId} 的 output.subdirectory 无效`,
      400,
      "CONFIG_INVALID",
    );
  }
  return segments.join("/");
}

function resolveWithinOutputRoot(outputRoot: string, relative: string, label: string): string {
  const resolved = path.resolve(outputRoot, ...relative.split("/"));
  if (!isWithin(outputRoot, resolved)) {
    throw new AppError(`${label} 逃逸 paths.outputs`, 400, "CONFIG_INVALID");
  }
  return resolved;
}

function assertOwnerNamespace(
  artifactId: string,
  owner: string,
  outputRoot: string,
  absolutePath: string,
): void {
  const relative = path.relative(outputRoot, absolutePath).split(path.sep).join("/");
  const [namespaceRoot, namespace] = relative.split("/");
  if (namespaceRoot?.normalize("NFC").toLowerCase() !== "ai-native") return;
  const expected = canonicalOwnerNamespaces[owner as keyof typeof canonicalOwnerNamespaces];
  if (!expected || namespace?.normalize("NFC").toLowerCase() !== expected) {
    throw new AppError(
      `产物 ${artifactId} 不能写入其他角色的 ai-native 命名空间`,
      400,
      "CONFIG_INVALID",
    );
  }
}

function assertArtifactDoesNotOverlapControls(
  artifactId: string,
  absolutePath: string,
  controls: string[],
): void {
  for (const control of controls) {
    if (
      comparablePathIsWithin(control, absolutePath)
      || comparablePathIsWithin(absolutePath, control)
    ) {
      throw new AppError(
        `产物 ${artifactId} 不能与项目控制路径重叠`,
        400,
        "CONFIG_INVALID",
      );
    }
  }
}

function comparablePhysicalPath(value: string): string {
  return path.resolve(value)
    .split(path.sep)
    .join("/")
    .normalize("NFC")
    .toLowerCase();
}

function comparablePathIsWithin(parent: string, child: string): boolean {
  const comparableParent = comparablePhysicalPath(parent).replace(/\/+$/u, "");
  const comparableChild = comparablePhysicalPath(child).replace(/\/+$/u, "");
  return comparableChild === comparableParent
    || comparableChild.startsWith(`${comparableParent}/`);
}

async function readRoleSubdirectories(
  projectRoot: string,
  outputRoot: string,
  roleIds: Set<string>,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const roleId of roleIds) {
    const configPath = path.join(projectRoot, ".ai-sdlc", "roles", roleId, "config.yaml");
    const stats = await lstatOrNull(configPath);
    if (!stats) continue;
    let roleConfig: { output?: { subdirectory: string } };
    try {
      await assertNoSymbolicLinkSegments(projectRoot, configPath);
      if (!stats.isFile()) throw new Error("config.yaml 不是普通文件");
      roleConfig = z.object({
        output: z.object({ subdirectory: z.string().min(1) }).optional(),
      }).passthrough().parse(YAML.parse(await readFile(configPath, "utf8")));
    } catch (error) {
      throw new AppError(
        `角色 ${roleId} 的 config.yaml 格式或文件类型无效`,
        400,
        "CONFIG_INVALID",
        error,
      );
    }
    if (roleConfig.output?.subdirectory) {
      const normalized = normalizeRoleSubdirectory(roleId, roleConfig.output.subdirectory);
      resolveWithinOutputRoot(outputRoot, normalized, `角色 ${roleId} 的 output.subdirectory`);
      result.set(roleId, normalized);
    }
  }
  return result;
}

export async function assertDefinitionAgentFiles(
  projectRoot: string,
  definition: Pick<LoadedDefinition, "agentClient" | "agentDirectory">,
): Promise<void> {
  const parsedClient = definitionAgentClientSchema.safeParse(definition.agentClient);
  if (!parsedClient.success) {
    throw new AppError("agent.client 不是受支持的客户端", 400, "CONFIG_INVALID");
  }
  const contract = nativeAgentContracts[parsedClient.data];
  if (definition.agentDirectory !== contract.directory) {
    throw new AppError(
      `agent.client ${parsedClient.data} 必须使用标准 Agent 目录 ${contract.directory}`,
      400,
      "CONFIG_INVALID",
    );
  }
  const agentRoot = safeProjectPath(projectRoot, definition.agentDirectory);
  await validateNativeAgentFiles(projectRoot, parsedClient.data, agentRoot, true);
}

async function validateNativeAgentFiles(
  projectRoot: string,
  agentClient: keyof typeof nativeAgentContracts,
  agentRoot: string,
  required: boolean,
): Promise<void> {
  const rootStats = await lstatOrNull(agentRoot);
  if (!rootStats) {
    if (!required) return;
    throw new AppError(
      `缺少 ${agentClient} 标准 Agent 目录`,
      400,
      "CONFIG_INVALID",
    );
  }
  try {
    await assertNoSymbolicLinkSegments(projectRoot, agentRoot);
    if (!rootStats.isDirectory()) throw new Error("Agent 路径不是目录");
    const contract = nativeAgentContracts[agentClient];
    for (const roleId of expectedRoleIds) {
      const rolePath = path.join(agentRoot, contract.fileName(roleId));
      await assertNoSymbolicLinkSegments(projectRoot, rolePath);
      const roleStats = await lstatOrNull(rolePath);
      if (!roleStats?.isFile()) {
        throw new Error(`缺少普通 Agent 文件 ${contract.fileName(roleId)}`);
      }
    }
  } catch (error) {
    throw new AppError(
      `${agentClient} 的六角色 Agent 契约无效`,
      400,
      "CONFIG_INVALID",
      error,
    );
  }
}

async function assertNoSymbolicLinkSegments(projectRoot: string, target: string): Promise<void> {
  if (!isWithin(projectRoot, target)) throw new Error("路径逃逸项目目录");
  const relative = path.relative(projectRoot, target);
  let cursor = projectRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const stats = await lstatOrNull(cursor);
    if (!stats) return;
    if (stats.isSymbolicLink()) throw new Error(`路径经过符号链接：${segment}`);
  }
}

async function validateConfiguredOutputRoot(
  projectRoot: string,
  outputRoot: string,
): Promise<void> {
  try {
    await assertNoSymbolicLinkSegments(projectRoot, outputRoot);
    const stats = await lstatOrNull(outputRoot);
    if (stats && !stats.isDirectory()) throw new Error("paths.outputs 不是普通目录");
  } catch (error) {
    throw new AppError(
      "paths.outputs 必须位于项目内，且现有路径链不能包含符号链接或非目录节点",
      400,
      "CONFIG_INVALID",
      error,
    );
  }
}

async function lstatOrNull(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ENOTDIR") {
      throw new AppError(
        "配置路径的父节点不是目录",
        400,
        "CONFIG_INVALID",
        error,
      );
    }
    throw error;
  }
}

const releaseEvidenceCapabilityMarker = "ai-sdlc:release-evidence-v1";

async function hasCompleteReleaseEvidencePack(
  projectRoot: string,
  declaredByDefinition: boolean,
): Promise<boolean> {
  const requiredFiles = [
    {
      requiredFile: path.join(projectRoot, ".ai-sdlc", "roles", "devops", "config.yaml"),
      semantic: (content: string) => z.object({
        version: z.literal(1),
        output: z.object({ subdirectory: z.literal("ai-native/operations") }),
      }).passthrough().safeParse(YAML.parse(content)).success,
    },
    {
      requiredFile: path.join(projectRoot, ".ai-sdlc", "roles", "devops", "workflow.md"),
      semantic: (content: string) => {
        const visible = stripHtmlComments(content);
        return visible.length >= 1_200
          && /^# DevOps workflow\s*$/mu.test(visible)
          && hasSubstantiveMarkdownSections(visible, [
            "Evidence contract",
            "Completion gate",
            "Execution boundary",
          ])
          && visible.includes("Human: <role/name reference>")
          && visible.includes("SHA-256")
          && visible.includes("Ready for human go/no-go");
      },
    },
    {
      requiredFile: path.join(projectRoot, ".ai-sdlc", "templates", "release-runbook.md"),
      semantic: (content: string) => {
        const visible = stripHtmlComments(content);
        return visible.length >= 2_000
          && /^# Release Runbook:/mu.test(visible)
          && hasSubstantiveMarkdownSections(visible, [
            "Status and immutable bindings",
            "Trusted upstream input bindings",
            "Evidence and supply-chain applicability",
            "Release preconditions",
            "Ordered rollout",
            "Health and smoke checks",
            "Monitoring and response",
            "Rollback and recovery",
            "Incident and escalation",
            "Risks, exceptions, and open decisions",
            "Human go/no-go and execution boundary",
          ])
          && visible.includes("**Human release owner:** Human:")
          && visible.includes("**Rollback decision owner:** Human:")
          && visible.includes("**Go/no-go owner and decision record location:** Human:")
          && visible.includes("**Deployment execution:** Not executed by preparing this runbook.");
      },
    },
  ];
  const files = await Promise.all(requiredFiles.map(async ({ requiredFile, semantic }) => {
    const stats = await lstatOrNull(requiredFile);
    if (!stats?.isFile() || stats.isSymbolicLink()) {
      return { requiredFile, valid: false, marked: false };
    }
    try {
      await assertNoSymbolicLinkSegments(projectRoot, requiredFile);
      const content = await readFile(requiredFile, "utf8");
      const marked = content.includes(releaseEvidenceCapabilityMarker);
      return {
        requiredFile,
        valid: marked && semantic(content),
        marked,
      };
    } catch {
      return { requiredFile, valid: false, marked: false };
    }
  }));
  const capabilityClaimed = declaredByDefinition || files.some(({ marked }) => marked);
  if (!capabilityClaimed) return false;

  const invalid = files.filter(({ valid, marked }) => !valid || !marked);
  if (invalid.length > 0) {
    throw new AppError(
      "Release evidence v1 已声明，但 DevOps 能力包缺失、非普通文件或版本标记不一致",
      400,
      "CONFIG_INVALID",
      {
        invalidFiles: invalid.map(({ requiredFile }) => path.relative(projectRoot, requiredFile)),
      },
    );
  }
  return true;
}

function hasSubstantiveMarkdownSections(content: string, headings: string[]): boolean {
  const lines = content.split(/\r?\n/u);
  for (const heading of headings) {
    const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
    if (start < 0) return false;
    const body: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (/^##\s+/u.test(line)) break;
      body.push(line);
    }
    const meaningfulBody = stripHtmlComments(body.join("\n")).trim();
    const distinctTokens = new Set(
      (meaningfulBody.match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? [])
        .map((token) => token.toLocaleLowerCase("en-US")),
    );
    if (meaningfulBody.length < 20 || distinctTokens.size < 3) return false;
  }
  return true;
}

function stripHtmlComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/gu, "");
}
