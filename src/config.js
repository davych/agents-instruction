import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv from "ajv";
import YAML from "yaml";

import { BLOCK_MARKERS, DEFAULT_CONFIG_PATH, TEMPLATE_SET } from "./constants.js";
import { ConfigError } from "./errors.js";
import { assertSafeRelativePath } from "./fs-safety.js";
import { normalizeLineEndings, slugify } from "./utils.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(moduleDirectory, "../schemas/config.schema.json");
const templatePath = path.resolve(moduleDirectory, "../templates/ai-native.config.yaml");

const REQUIRED_ROLE_IDS = [
  "pm-ba",
  "designer",
  "architect",
  "software-engineer",
  "tester",
  "devops"
];

let validatorPromise;

async function getValidator() {
  if (!validatorPromise) {
    validatorPromise = readFile(schemaPath, "utf8").then((source) => {
      const schema = JSON.parse(source);
      const ajv = new Ajv({ allErrors: true, strict: true });
      return ajv.compile(schema);
    });
  }
  return validatorPromise;
}

export async function buildInitialConfig({ projectName, projectSummary }) {
  const source = await readFile(templatePath, "utf8");
  const replacements = {
    PROJECT_ID_JSON: JSON.stringify(slugify(projectName)),
    PROJECT_NAME_JSON: JSON.stringify(projectName),
    PROJECT_SUMMARY_JSON: JSON.stringify(projectSummary)
  };
  return normalizeLineEndings(source).replace(
    /\{\{(PROJECT_ID_JSON|PROJECT_NAME_JSON|PROJECT_SUMMARY_JSON)\}\}/gu,
    (_, key) => replacements[key]
  );
}

export async function parseAndValidateConfig(source, sourceLabel = DEFAULT_CONFIG_PATH) {
  const document = YAML.parseDocument(normalizeLineEndings(source), {
    prettyErrors: true,
    uniqueKeys: true
  });

  if (document.errors.length > 0) {
    throw new ConfigError(`无法解析 ${sourceLabel}`, document.errors.map((error) => error.message));
  }

  let config;
  try {
    config = document.toJS({ maxAliasCount: 100 });
  } catch (error) {
    throw new ConfigError(`无法解析 ${sourceLabel}`, [error.message]);
  }

  const validate = await getValidator();
  if (!validate(config)) {
    const details = validate.errors.map((error) => {
      const location = error.instancePath || "/";
      return `${location}: ${error.message}`;
    });
    throw new ConfigError(`${sourceLabel} 不符合 schemaVersion 1`, details);
  }

  validateSemantics(config, sourceLabel);
  return config;
}

export async function loadConfig(root, configPath = DEFAULT_CONFIG_PATH) {
  const safeConfigPath = assertSafeRelativePath(configPath, "config path");
  const source = await readFile(path.join(root, safeConfigPath), "utf8").catch((error) => {
    if (error.code === "ENOENT") {
      throw new ConfigError(`未找到 ${safeConfigPath}；请先运行 init`);
    }
    throw error;
  });
  return {
    config: await parseAndValidateConfig(source, safeConfigPath),
    source,
    configPath: safeConfigPath
  };
}

export async function findProjectRoot(startDirectory, configPath = DEFAULT_CONFIG_PATH) {
  const safeConfigPath = assertSafeRelativePath(configPath, "config path");
  let cursor = path.resolve(startDirectory);

  while (true) {
    try {
      await access(path.join(cursor, safeConfigPath));
      return cursor;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new ConfigError(`从 ${startDirectory} 向上未找到 ${safeConfigPath}`);
    }
    cursor = parent;
  }
}

function validateSemantics(config, sourceLabel) {
  if (config.templateSet !== TEMPLATE_SET) {
    throw new ConfigError(`${sourceLabel} 使用了不受支持的 templateSet: ${config.templateSet}`);
  }

  assertUnique(config.roles, "role id");
  assertUnique(config.workflow.phases, "phase id");
  assertUnique(config.baselines, "baseline id");
  assertUnique(config.artifacts, "artifact id");

  const roles = new Map(config.roles.map((role) => [role.id, role]));
  const artifacts = new Map(config.artifacts.map((artifact) => [artifact.id, artifact]));

  const missingRoles = REQUIRED_ROLE_IDS.filter((id) => !roles.has(id));
  if (missingRoles.length > 0) {
    throw new ConfigError(`${sourceLabel} 缺少必需角色`, missingRoles);
  }

  for (const role of config.roles) {
    if (!role.enabled && role.deliverables.length > 0) {
      throw new ConfigError(`禁用角色 ${role.id} 的 deliverables 必须为空；请先移除或改派对应产物`);
    }
    for (const artifactId of role.deliverables) {
      const artifact = artifacts.get(artifactId);
      if (!artifact) {
        throw new ConfigError(`角色 ${role.id} 引用了未知交付物: ${artifactId}`);
      }
      if (artifact.owner !== role.id) {
        throw new ConfigError(`角色 ${role.id} 声明了不属于自己的交付物: ${artifactId}`);
      }
    }
  }

  for (const artifact of config.artifacts) {
    const owner = roles.get(artifact.owner);
    if (!owner) {
      throw new ConfigError(`交付物 ${artifact.id} 引用了未知角色: ${artifact.owner}`);
    }
    if (!owner.enabled) {
      throw new ConfigError(`交付物 ${artifact.id} 的负责人角色已禁用: ${artifact.owner}`);
    }
    if (!owner.deliverables.includes(artifact.id)) {
      throw new ConfigError(`交付物 ${artifact.id} 未登记在角色 ${artifact.owner} 的 deliverables 中`);
    }
    assertPathWithin(artifact.output, config.paths.artifacts, `artifact ${artifact.id}`);
  }

  for (const phase of config.workflow.phases) {
    const owner = roles.get(phase.owner);
    if (!owner) {
      throw new ConfigError(`阶段 ${phase.id} 引用了未知角色: ${phase.owner}`);
    }
    if (!owner.enabled) {
      throw new ConfigError(`阶段 ${phase.id} 的负责人角色已禁用: ${phase.owner}`);
    }
    for (const artifactId of [...phase.inputs, ...phase.outputs]) {
      if (!artifacts.has(artifactId)) {
        throw new ConfigError(`阶段 ${phase.id} 引用了未知交付物: ${artifactId}`);
      }
    }
    for (const artifactId of phase.outputs) {
      if (artifacts.get(artifactId).owner !== phase.owner) {
        throw new ConfigError(`阶段 ${phase.id} 不能产出其他角色拥有的交付物: ${artifactId}`);
      }
    }
  }

  validateWorkflowGraph(config.workflow.phases, artifacts);

  for (const baseline of config.baselines) {
    assertPathWithin(baseline.output, config.paths.baseline, `baseline ${baseline.id}`);
  }

  const outputPaths = [
    ...config.baselines.map((item) => item.output),
    ...config.artifacts.map((item) => item.output)
  ];
  for (const outputPath of outputPaths) {
    assertSafeRelativePath(outputPath);
  }
  const duplicateOutput = outputPaths.find((value, index) => outputPaths.indexOf(value) !== index);
  if (duplicateOutput) {
    throw new ConfigError(`多个产物使用了同一路径: ${duplicateOutput}`);
  }

  rejectMarkerInjection(config);
}

function validateWorkflowGraph(phases, artifacts) {
  const producedBy = new Map();
  for (const phase of phases) {
    for (const inputId of phase.inputs) {
      if (!producedBy.has(inputId)) {
        throw new ConfigError(`阶段 ${phase.id} 的输入尚未由前序阶段产出: ${inputId}`);
      }
    }
    for (const outputId of phase.outputs) {
      if (producedBy.has(outputId)) {
        throw new ConfigError(`交付物 ${outputId} 被多个阶段产出: ${producedBy.get(outputId)} / ${phase.id}`);
      }
      producedBy.set(outputId, phase.id);
    }
  }

  for (const artifactId of artifacts.keys()) {
    if (!producedBy.has(artifactId)) {
      throw new ConfigError(`交付物 ${artifactId} 未被任何 workflow phase 产出`);
    }
  }
}

function assertUnique(items, label) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) {
      throw new ConfigError(`${label} 重复: ${item.id}`);
    }
    seen.add(item.id);
  }
}

function assertPathWithin(outputPath, parentPath, label) {
  assertSafeRelativePath(outputPath, `${label} output`);
  assertSafeRelativePath(parentPath, `${label} parent path`);
  if (!outputPath.startsWith(`${parentPath}/`)) {
    throw new ConfigError(`${label} output 必须位于 ${parentPath} 下: ${outputPath}`);
  }
}

function rejectMarkerInjection(value, cursor = "config") {
  if (typeof value === "string") {
    for (const markers of Object.values(BLOCK_MARKERS)) {
      if (value.includes(markers.start) || value.includes(markers.end)) {
        throw new ConfigError(`${cursor} 不能包含生成器区块标记`);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectMarkerInjection(item, `${cursor}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      rejectMarkerInjection(child, `${cursor}.${key}`);
    }
  }
}
