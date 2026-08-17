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
  registerPlatformDesignOutputs(config);

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
