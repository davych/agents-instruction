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

const configSchema = z.object({
  version: z.number().int().positive(),
  project: z.object({
    name: z.string(),
    summary: z.string(),
    locale: z.string().optional()
  }),
  agent: z.object({ client: z.string() }),
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
  artifacts: LoadedArtifactDefinition[];
  configPath: string;
}

export interface LoadedArtifactDefinition {
  id: string;
  owner: string;
  relativePath: string;
  absolutePath: string;
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
  registerPlatformChangeContract(config);
  registerPlatformDesignOutputs(config);
  registerPlatformVerificationDesignInput(config);
  registerPlatformArchitectureOutputs(config);

  const phaseIds = config.workflow.phases.map((phase) => phase.id);
  if (phaseIds.length !== PHASE_IDS.length || phaseIds.some((id, index) => id !== PHASE_IDS[index])) {
    throw new AppError(
      `MVP 仅支持固定阶段顺序：${PHASE_IDS.join(" -> ")}`,
      400,
      "UNSUPPORTED_WORKFLOW"
    );
  }
  const expectedOwners = ["pm-ba", "designer", "architect", "software-engineer", "tester", "devops"];
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

  safeProjectPath(projectRoot, config.paths.agents);
  const outputRoot = safeProjectPath(projectRoot, config.paths.outputs);
  const subdirectories = await readRoleSubdirectories(projectRoot, roleIds);
  registerPlatformEngineeringOutputs(
    config,
    subdirectories.has("software-engineer"),
  );
  const artifactIds = new Set(config.artifacts.map((artifact) => artifact.id));
  if (artifactIds.size !== config.artifacts.length) {
    throw new AppError("artifacts 包含重复 id", 400, "CONFIG_INVALID");
  }
  const artifacts = config.artifacts.map((artifact) => {
    if (!roleIds.has(artifact.owner)) {
      throw new AppError(`产物 ${artifact.id} 的角色 ${artifact.owner} 未定义`, 400, "CONFIG_INVALID");
    }
    const subdirectory = subdirectories.get(artifact.owner);
    const relativePath = subdirectory
      ? path.posix.join(config.paths.outputs, subdirectory, artifact.path)
      : path.posix.join(config.paths.outputs, artifact.path);
    return {
      id: artifact.id,
      owner: artifact.owner,
      relativePath,
      absolutePath: safeProjectPath(projectRoot, relativePath)
    };
  });
  const artifactByPath = new Map<string, string>();
  for (const artifact of artifacts) {
    const existing = artifactByPath.get(artifact.absolutePath);
    if (existing) {
      throw new AppError(
        `产物 ${existing} 与 ${artifact.id} 指向同一路径 ${artifact.relativePath}`,
        400,
        "CONFIG_INVALID"
      );
    }
    artifactByPath.set(artifact.absolutePath, artifact.id);
  }
  for (const [index, left] of artifacts.entries()) {
    for (const right of artifacts.slice(index + 1)) {
      if (
        isWithin(left.absolutePath, right.absolutePath)
        || isWithin(right.absolutePath, left.absolutePath)
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

  return {
    version: config.version,
    project: config.project,
    roles: config.roles,
    phases: config.workflow.phases as PhaseDefinition[],
    agentClient: config.agent.client,
    agentDirectory: config.paths.agents,
    outputRoot,
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
] as const;

/**
 * Older initialized projects predate the immutable per-Run Change Contract.
 * Extend their parsed definition in memory so routing has one canonical input,
 * while leaving the project-owned ai-native.yaml byte-for-byte unchanged.
 */
function registerPlatformChangeContract(config: RawConfig): void {
  if (!config.artifacts.some((artifact) => artifact.id === platformChangeContractArtifact.id)) {
    config.artifacts.push({ ...platformChangeContractArtifact });
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
function registerPlatformDesignOutputs(config: RawConfig): void {
  const design = config.workflow.phases.find((phase) => phase.id === "design");
  if (!design) return;
  for (const artifact of platformDesignArtifacts) {
    if (!config.artifacts.some((candidate) => candidate.id === artifact.id)) {
      config.artifacts.push({ ...artifact });
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
function registerPlatformArchitectureOutputs(config: RawConfig): void {
  const architecture = config.workflow.phases.find((phase) => phase.id === "architecture");
  if (!architecture) return;
  for (const artifact of platformArchitectureArtifacts) {
    if (!config.artifacts.some((candidate) => candidate.id === artifact.id)) {
      config.artifacts.push({ ...artifact });
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

function safeProjectPath(projectRoot: string, relative: string): string {
  if (path.isAbsolute(relative) || relative.includes("\\")) {
    throw new AppError(`配置包含不安全路径：${relative}`, 400, "UNSAFE_CONFIG_PATH");
  }
  const resolved = path.resolve(projectRoot, relative);
  if (!isWithin(projectRoot, resolved)) {
    throw new AppError(`配置路径逃逸项目目录：${relative}`, 400, "UNSAFE_CONFIG_PATH");
  }
  return resolved;
}

async function readRoleSubdirectories(projectRoot: string, roleIds: Set<string>): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const roleId of roleIds) {
    const configPath = path.join(projectRoot, ".ai-sdlc", "roles", roleId, "config.yaml");
    if (!existsSync(configPath)) continue;
    const roleConfig = z.object({
      output: z.object({ subdirectory: z.string() }).optional()
    }).passthrough().parse(YAML.parse(await readFile(configPath, "utf8")));
    if (roleConfig.output?.subdirectory) {
      safeProjectPath(projectRoot, roleConfig.output.subdirectory);
      result.set(roleId, roleConfig.output.subdirectory);
    }
  }
  return result;
}
