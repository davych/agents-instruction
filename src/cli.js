import { access, mkdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildBlueprint } from "./blueprint.js";
import {
  DEFAULT_CONFIG_PATH,
  GENERATOR_NAME
} from "./constants.js";
import {
  buildInitialConfig,
  findProjectRoot,
  loadConfig,
  parseAndValidateConfig
} from "./config.js";
import { applyPlan, createPlan } from "./engine.js";
import { CliError, ConfigError } from "./errors.js";
import { assertSafeRelativePath } from "./fs-safety.js";
import { loadManifest } from "./manifest.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageJsonPath = path.resolve(moduleDirectory, "../package.json");
const { version: GENERATOR_VERSION } = JSON.parse(await readFile(packageJsonPath, "utf8"));

const COMMANDS = new Set(["init", "sync", "check"]);

export async function runCli(
  args,
  {
    cwd = process.cwd(),
    stdout = (message) => process.stdout.write(message),
    stderr = (message) => process.stderr.write(message)
  } = {}
) {
  let options;
  try {
    options = parseArguments(args);
  } catch (error) {
    return reportError(error, { stderr, json: args.includes("--json") });
  }

  if (options.version) {
    stdout(`${GENERATOR_VERSION}\n`);
    return 0;
  }
  if (options.help) {
    stdout(usage());
    return 0;
  }

  try {
    validateOptionCombination(options);
    const result = await execute(options, cwd);
    printResult(result, options, stdout);
    return result.exitCode;
  } catch (error) {
    return reportError(error, { stderr, json: options.json });
  }
}

async function execute(options, cwd) {
  const requestedTarget = path.resolve(cwd, options.target);
  let root;
  let config;
  let configSource;
  let configPath = options.config;
  let entries;

  if (options.command === "init") {
    const projectName = options.name ?? (await detectProjectName(requestedTarget));
    const projectSummary = options.summary ?? `${projectName} 的 AI-native 交付工作区。`;
    configSource = await buildInitialConfig({ projectName, projectSummary });
    config = await parseAndValidateConfig(configSource, configPath);
    const blueprint = buildBlueprint(config, configPath);

    if (options.dryRun) {
      root = await resolveDryRunRoot(requestedTarget);
    } else {
      await ensureTargetDirectory(requestedTarget);
      root = await realpath(requestedTarget);
    }
    entries = [
      {
        path: configPath,
        mode: "config",
        content: configSource,
        tracked: false
      },
      ...blueprint
    ];
  } else {
    await assertDirectory(requestedTarget);
    root = await findProjectRoot(requestedTarget, configPath);
    root = await realpath(root);
    const loaded = await loadConfig(root, configPath);
    config = loaded.config;
    configSource = loaded.source;
    configPath = loaded.configPath;
    entries = buildBlueprint(config, configPath);
  }

  const { manifest, source: manifestSource } = await loadManifest(root);
  const plan = await createPlan({
    root,
    entries,
    previousManifest: manifest,
    previousManifestSource: manifestSource,
    force: options.force,
    prune: options.prune,
    protectedPaths: [configPath]
  });

  if (options.command === "check") {
    return { exitCode: plan.drift ? 1 : 0, plan, applied: null, mode: "check" };
  }
  if (options.dryRun) {
    return { exitCode: 0, plan, applied: null, mode: "dry-run" };
  }

  const applied = await applyPlan(plan);
  return { exitCode: 0, plan, applied, mode: options.command };
}

function parseArguments(args) {
  const options = {
    command: null,
    target: ".",
    config: DEFAULT_CONFIG_PATH,
    dryRun: false,
    force: false,
    prune: false,
    json: false,
    help: false,
    version: false,
    name: null,
    summary: null
  };
  const positional = [];
  let commandSeen = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--version" || argument === "-v") {
      options.version = true;
      continue;
    }
    if (argument === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (argument === "--force") {
      options.force = true;
      continue;
    }
    if (argument === "--prune") {
      options.prune = true;
      continue;
    }
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (["--name", "--summary", "--config"].includes(argument)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new CliError(`${argument} 需要一个值`);
      }
      index += 1;
      assignValueOption(options, argument, value);
      continue;
    }
    const equalsMatch = argument.match(/^(--name|--summary|--config)=(.*)$/u);
    if (equalsMatch) {
      if (equalsMatch[2].length === 0) {
        throw new CliError(`${equalsMatch[1]} 需要一个值`);
      }
      assignValueOption(options, equalsMatch[1], equalsMatch[2]);
      continue;
    }
    if (argument.startsWith("-")) {
      throw new CliError(`未知选项: ${argument}`);
    }
    if (options.command === null && COMMANDS.has(argument)) {
      options.command = argument;
      commandSeen = true;
      continue;
    }
    if (!commandSeen && options.command === null) {
      throw new CliError(`未知命令: ${argument}`);
    }
    positional.push(argument);
  }

  options.command ??= "init";
  if (positional.length > 1) {
    throw new CliError(`只允许一个目标目录: ${positional.join(" ")}`);
  }
  if (positional.length === 1) {
    options.target = positional[0];
  }
  assertSafeRelativePath(options.config, "config path");
  return options;
}

function assignValueOption(options, name, value) {
  if (name === "--name") options.name = value;
  if (name === "--summary") options.summary = value;
  if (name === "--config") options.config = value;
}

function validateOptionCombination(options) {
  if (options.command !== "init" && (options.name !== null || options.summary !== null)) {
    throw new CliError("--name 和 --summary 只适用于 init");
  }
  if (options.command === "check" && (options.force || options.prune || options.dryRun)) {
    throw new CliError("check 是严格只读命令，不接受 --force、--prune 或 --dry-run");
  }
  if (options.command !== "sync" && options.prune) {
    throw new CliError("--prune 只适用于 sync");
  }
}

async function ensureTargetDirectory(target) {
  try {
    const stats = await stat(target);
    if (!stats.isDirectory()) {
      throw new ConfigError(`目标不是目录: ${target}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(target, { recursive: true });
  }
}

async function resolveDryRunRoot(target) {
  try {
    const stats = await stat(target);
    if (!stats.isDirectory()) {
      throw new ConfigError(`目标不是目录: ${target}`);
    }
    return realpath(target);
  } catch (error) {
    if (error.code === "ENOENT") {
      return path.resolve(target);
    }
    throw error;
  }
}

async function assertDirectory(target) {
  const stats = await stat(target).catch((error) => {
    if (error.code === "ENOENT") {
      throw new ConfigError(`目标目录不存在: ${target}`);
    }
    throw error;
  });
  if (!stats.isDirectory()) {
    throw new ConfigError(`目标不是目录: ${target}`);
  }
}

async function detectProjectName(target) {
  try {
    await access(path.join(target, "package.json"));
    const packageJson = JSON.parse(await readFile(path.join(target, "package.json"), "utf8"));
    if (typeof packageJson.name === "string" && packageJson.name.trim().length > 0) {
      return packageJson.name.replace(/^@[^/]+\//u, "");
    }
  } catch {
    // The target may not be a Node.js project; fall back to its directory name.
  }
  return path.basename(target) || "my-product";
}

function printResult(result, options, stdout) {
  const publicActions = result.plan.actions.map(({ kind, mode, path: filePath, reason }) => ({
    kind,
    mode,
    path: filePath,
    ...(reason ? { reason } : {})
  }));

  if (options.json) {
    stdout(`${JSON.stringify({
      mode: result.mode,
      root: result.plan.root,
      drift: result.plan.drift,
      counts: result.plan.counts,
      actions: publicActions,
      backupDirectory: result.applied?.backupDirectory ?? null,
      exitCode: result.exitCode
    }, null, 2)}\n`);
    return;
  }

  const visibleActions = publicActions.filter((action) => action.kind !== "skip");
  for (const action of visibleActions) {
    const suffix = action.reason ? ` (${action.reason})` : "";
    stdout(`${action.kind.padEnd(7)} ${action.path}${suffix}\n`);
  }

  if (result.mode === "check") {
    stdout(result.plan.drift ? "\n检查失败：生成内容与配置不一致。\n" : "检查通过：生成内容与配置一致。\n");
  } else if (result.mode === "dry-run") {
    stdout(`\nDry run 完成：计划 ${visibleActions.length} 项变更，未写入文件。\n`);
  } else {
    stdout(`\n完成：写入 ${result.applied.written} 个文件。\n`);
    if (result.applied.backupDirectory) {
      stdout(`备份：${result.applied.backupDirectory}\n`);
    }
  }
}

function reportError(error, { stderr, json }) {
  const normalized = error instanceof CliError
    ? error
    : new CliError(error?.message ?? String(error), { exitCode: 1 });
  if (json) {
    stderr(`${JSON.stringify({
      error: normalized.name,
      message: normalized.message,
      details: normalized.details,
      exitCode: normalized.exitCode
    }, null, 2)}\n`);
  } else {
    stderr(`错误：${normalized.message}\n`);
    for (const detail of normalized.details ?? []) {
      stderr(`  - ${detail}\n`);
    }
  }
  return normalized.exitCode;
}

function usage() {
  return `${GENERATOR_NAME} ${GENERATOR_VERSION}

用法：
  npx ${GENERATOR_NAME} init [target] [options]
  npx ${GENERATOR_NAME} sync [target] [options]
  npx ${GENERATOR_NAME} check [target] [options]

命令：
  init    创建 ${DEFAULT_CONFIG_PATH} 并生成 baseline、角色、技能和三种 AI 工具适配
  sync    从现有 YAML 重新计算并安全同步 generated 文件
  check   严格只读地校验配置、漂移、冲突和陈旧文件

选项：
  --name <name>       初始化项目名
  --summary <text>    初始化项目简介
  --config <path>     配置相对路径（默认 ${DEFAULT_CONFIG_PATH}）
  --dry-run           只显示 init/sync 计划，不写文件
  --force             覆盖冲突的 generated 内容并先备份
  --prune             sync 时清理已停用且未被人工修改的 generated 内容
  --json              输出机器可读 JSON
  -h, --help          显示帮助
  -v, --version       显示版本

退出码：0=成功/一致，1=配置错误或 check 检测到漂移，2=文件冲突。
`;
}
