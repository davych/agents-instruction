#!/usr/bin/env node

import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateRoot = path.join(packageRoot, "templates");

export async function run(args = process.argv.slice(2), cwd = process.cwd(), output = (message) => process.stdout.write(message)) {
  const options = parseArgs(args);
  if (options.help) {
    output(help());
    return 0;
  }

  const target = path.resolve(cwd, options.target);
  await mkdir(target, { recursive: true });

  const targetConfigPath = path.join(target, "ai-native.yaml");
  const targetHasConfig = existsSync(targetConfigPath);
  let configSource;

  if (targetHasConfig && !options.config && (options.name || options.summary) && !options.force) {
    throw new Error("目标项目已有 ai-native.yaml；请直接修改配置，或明确使用 --force");
  }

  if (options.config) {
    if (targetHasConfig && !options.force) {
      throw new Error("目标项目已有 ai-native.yaml；请直接修改它后重新运行 init，或使用 --force");
    }
    configSource = await readFile(path.resolve(cwd, options.config), "utf8");
  } else if (targetHasConfig) {
    configSource = await readFile(targetConfigPath, "utf8");
  } else {
    configSource = await readFile(path.join(templateRoot, "ai-native.yaml"), "utf8");
  }

  const config = YAML.parse(configSource);
  if (options.name) config.project.name = options.name;
  if (options.summary) config.project.summary = options.summary;
  validateConfig(config);

  const entries = await buildEntries(config);
  if (!targetHasConfig || options.config || options.name || options.summary) {
    entries.unshift({ path: "ai-native.yaml", content: YAML.stringify(config, { lineWidth: 0 }) });
  }

  let created = 0;
  let skipped = 0;
  for (const entry of entries) {
    const outputPath = safeOutputPath(target, entry.path);
    const existed = existsSync(outputPath);
    if (existed && !options.force) {
      skipped += 1;
      output(`skip    ${entry.path}\n`);
      continue;
    }
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, ensureNewline(entry.content), "utf8");
    created += 1;
    output(`${existed ? "write" : "create"}  ${entry.path}\n`);
  }

  output(`\n完成：写入 ${created} 个文件，跳过 ${skipped} 个已有文件。\n`);
  return 0;
}

async function buildEntries(config) {
  const roleMap = new Map(config.roles.map((role) => [role.id, role]));
  const common = {
    PROJECT_NAME: config.project.name,
    PROJECT_SUMMARY: config.project.summary,
    LOCALE: config.project.locale,
    ROLE_LIST: config.roles.map((role) => `- **${role.name}** (\`${role.id}\`): ${role.mission}`).join("\n"),
    WORKFLOW_LIST: config.workflow.phases.map((phase, index) => {
      const outputs = phase.outputs.map((id) => `\`${id}\``).join(", ");
      return `${index + 1}. **${phase.name}** — ${roleMap.get(phase.owner).name} → ${outputs}; gate: ${phase.gate}`;
    }).join("\n")
  };
  const entries = [];
  const addTemplate = async (outputPath, templatePath, values = {}) => {
    const source = await readFile(path.join(templateRoot, templatePath), "utf8");
    entries.push({ path: outputPath, content: render(source, { ...common, ...values }) });
  };

  await addTemplate("AGENTS.md", "project/AGENTS.md");

  for (const baseline of config.baselines) {
    await addTemplate(baseline.path, `baselines/${baseline.template}.md`);
  }

  for (const role of config.roles) {
    const ownedArtifacts = config.artifacts.filter((artifact) => artifact.owner === role.id);
    const values = roleValues(role, ownedArtifacts);
    await addTemplate(`${config.output.roles}/${role.id}.md`, "role.md", values);

    if (config.providers.githubCopilot) {
      await addTemplate(`.github/agents/${role.id}.agent.md`, "providers/copilot-agent.md", values);
    }
    if (config.providers.claudeCode) {
      await addTemplate(`.claude/agents/${role.id}.md`, "providers/claude-agent.md", values);
    }
    if (config.providers.codex) {
      await addTemplate(`.codex/agents/${role.id}.toml`, "providers/codex-agent.toml", {
        ...values,
        ROLE_ID_JSON: JSON.stringify(role.id),
        ROLE_MISSION_JSON: JSON.stringify(role.mission),
        CODEX_INSTRUCTIONS_JSON: JSON.stringify(`Act as ${role.name} for ${config.project.name}. Read ai-native.yaml, AGENTS.md, and ${config.output.roles}/${role.id}.md before working.`)
      });
    }
  }

  for (const artifact of config.artifacts) {
    const owner = roleMap.get(artifact.owner);
    await addTemplate(artifact.path, "artifact.md", {
      ARTIFACT_ID: artifact.id,
      ARTIFACT_TITLE: artifact.title,
      ROLE_ID: owner.id,
      ROLE_NAME: owner.name
    });
  }

  if (config.providers.githubCopilot) {
    await addTemplate(".github/copilot-instructions.md", "project/copilot-instructions.md");
  }
  if (config.providers.claudeCode) {
    await addTemplate("CLAUDE.md", "project/CLAUDE.md");
  }

  return entries;
}

function roleValues(role, artifacts) {
  return {
    ROLE_ID: role.id,
    ROLE_NAME: role.name,
    ROLE_MISSION: role.mission,
    ROLE_MISSION_JSON: JSON.stringify(role.mission),
    RESPONSIBILITIES: role.responsibilities.map((item) => `- ${item}`).join("\n"),
    DELIVERABLES: artifacts.length
      ? artifacts.map((artifact) => `- \`${artifact.id}\`: \`${artifact.path}\``).join("\n")
      : "- 暂无"
  };
}

function validateConfig(config) {
  if (config?.version !== 1) throw new Error("ai-native.yaml 仅支持 version: 1");
  if (!config?.project?.name || !config?.project?.summary) throw new Error("project.name 和 project.summary 必填");
  if (!config?.providers || !config?.output?.roles) throw new Error("providers 和 output.roles 必填");
  for (const key of ["roles", "artifacts", "baselines"]) {
    if (!Array.isArray(config[key])) throw new Error(`${key} 必须是数组`);
  }
  if (!Array.isArray(config?.workflow?.phases)) throw new Error("workflow.phases 必须是数组");

  const requiredRoles = ["pm-ba", "designer", "architect", "software-engineer", "tester", "devops"];
  const roleIds = new Set(config.roles.map((role) => role.id));
  const artifactIds = new Set(config.artifacts.map((artifact) => artifact.id));
  for (const roleId of requiredRoles) {
    if (!roleIds.has(roleId)) throw new Error(`缺少角色: ${roleId}`);
  }
  for (const role of config.roles) {
    if (!/^[a-z]+(?:-[a-z]+)*$/u.test(role.id)) throw new Error(`角色 ID 不合法: ${role.id}`);
    if (!role.name || !role.mission || !Array.isArray(role.responsibilities)) throw new Error(`角色配置不完整: ${role.id}`);
  }
  for (const artifact of config.artifacts) {
    if (!roleIds.has(artifact.owner)) throw new Error(`产物 ${artifact.id} 的 owner 不存在`);
    assertRelativePath(artifact.path);
  }
  for (const baseline of config.baselines) {
    if (!['project-charter', 'workflow', 'roles'].includes(baseline.template)) throw new Error(`未知 baseline 模板: ${baseline.template}`);
    assertRelativePath(baseline.path);
  }
  for (const phase of config.workflow.phases) {
    if (!roleIds.has(phase.owner)) throw new Error(`阶段 ${phase.id} 的 owner 不存在`);
    for (const output of phase.outputs) {
      if (!artifactIds.has(output)) throw new Error(`阶段 ${phase.id} 引用了未知产物: ${output}`);
    }
  }
  assertRelativePath(config.output.roles);
}

function parseArgs(args) {
  const options = { target: ".", config: null, name: null, summary: null, force: false, help: false };
  const rest = [...args];
  const command = rest[0] && !rest[0].startsWith("-") ? rest.shift() : "init";
  if (["help", "--help", "-h"].includes(command)) return { ...options, help: true };
  if (command !== "init") throw new Error(`仅支持 init，收到: ${command}`);

  let targetSet = false;
  while (rest.length) {
    const value = rest.shift();
    if (value === "--help" || value === "-h") options.help = true;
    else if (value === "--force") options.force = true;
    else if (["--config", "--name", "--summary"].includes(value)) {
      const next = rest.shift();
      if (!next) throw new Error(`${value} 需要一个值`);
      options[value.slice(2)] = next;
    } else if (value.startsWith("-")) throw new Error(`未知选项: ${value}`);
    else if (!targetSet) {
      options.target = value;
      targetSet = true;
    } else throw new Error(`只允许一个目标目录: ${value}`);
  }
  return options;
}

function render(source, values) {
  return source.replace(/\{\{([A-Z0-9_]+)\}\}/gu, (match, key) => {
    if (!(key in values)) throw new Error(`模板变量缺失: ${key}`);
    return String(values[key]);
  });
}

function safeOutputPath(root, relativePath) {
  assertRelativePath(relativePath);
  return path.join(root, relativePath);
}

function assertRelativePath(value) {
  if (typeof value !== "string" || !value || path.isAbsolute(value) || value.includes("\\")) {
    throw new Error(`输出必须是 POSIX 相对路径: ${value}`);
  }
  if (value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`输出路径不安全: ${value}`);
  }
}

function ensureNewline(value) {
  return `${value.trimEnd()}\n`;
}

function help() {
  return `create-ai-native-sdlc\n\n用法:\n  create-ai-native-sdlc init [target] [options]\n\n选项:\n  --config <yaml>   从指定 YAML 初始化\n  --name <name>     覆盖项目名\n  --summary <text>  覆盖项目简介\n  --force           覆盖目标中的同名文件\n  -h, --help        显示帮助\n`;
}

const isDirect = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  run().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`错误：${error.message}\n`);
    process.exitCode = 1;
  });
}
