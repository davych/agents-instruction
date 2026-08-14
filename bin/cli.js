#!/usr/bin/env node

import { existsSync, lstatSync, realpathSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateRoot = path.join(packageRoot, "templates");
const defaultAgentsDirectory = ".ai-sdlc/agents";

export async function run(args = process.argv.slice(2), context = {}) {
  const options = parseArgs(args);
  const output = context.output ?? ((message) => stdout.write(message));
  if (options.help) {
    output(help());
    return 0;
  }

  const cwd = context.cwd ?? process.cwd();
  const target = path.resolve(cwd, options.target);
  if (lstatIfPresent(path.join(target, "ai-native.yaml"))) {
    throw new Error("目标项目已经存在 ai-native.yaml，初始化已取消");
  }

  let terminal;
  let prompt = context.prompt;
  if (!prompt) {
    terminal = createInterface({ input: stdin, output: stdout });
    prompt = (question) => terminal.question(question);
  }

  try {
    const defaultName = path.basename(target);
    const projectName = (await ask(prompt, `项目名称（默认 ${defaultName}）：`)) || defaultName;
    const projectSummary = await askRequired(prompt, output, "项目简介：");
    const agentsDirectory = await askForAgentsDirectory(prompt, output);
    const designerInputs = await askForDesignerInputs(prompt, output);
    const componentCatalogModule = await askForComponentCatalog(prompt, output);
    const entries = await buildEntries(
      projectName,
      projectSummary,
      agentsDirectory,
      designerInputs,
      componentCatalogModule
    );

    const conflicts = findConflicts(target, entries);
    if (conflicts.length) {
      throw new Error(`目标路径存在冲突，未写入任何文件：\n${conflicts.map((item) => `- ${item}`).join("\n")}`);
    }

    for (const entry of entries) {
      const destination = path.join(target, entry.path);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, ensureNewline(entry.content), "utf8");
    }

    output(`\n初始化完成：${projectName}\n`);
    output(`Agent 目录：${agentsDirectory}\n`);
    output(`写入 ${entries.length} 个文件。\n`);
    if (!componentCatalogModule) {
      output("Designer 组件查询尚未配置，可编辑 .ai-sdlc/roles/designer/scripts/component-query.mjs。\n");
    }
    return 0;
  } finally {
    terminal?.close();
  }
}

function findConflicts(target, entries) {
  const conflicts = new Set(findPlannedConflicts(entries));
  const targetStats = lstatIfPresent(target);
  if (targetStats && (!targetStats.isDirectory() || targetStats.isSymbolicLink())) {
    conflicts.add(target);
    return [...conflicts];
  }

  for (const entry of entries) {
    const destination = path.join(target, entry.path);
    if (lstatIfPresent(destination)) conflicts.add(entry.path);

    let parent = target;
    for (const segment of entry.path.split("/").slice(0, -1)) {
      parent = path.join(parent, segment);
      const stats = lstatIfPresent(parent);
      if (!stats) continue;
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        conflicts.add(`${path.relative(target, parent)}/`);
        break;
      }
    }
  }
  return [...conflicts];
}

function findPlannedConflicts(entries) {
  const files = new Map();
  const conflicts = new Set();

  for (const entry of entries) {
    const key = comparablePath(entry.path);
    if (files.has(key)) {
      conflicts.add(files.get(key));
      conflicts.add(entry.path);
    } else {
      files.set(key, entry.path);
    }
  }

  for (const [key, originalPath] of files) {
    let slash = key.lastIndexOf("/");
    while (slash >= 0) {
      const parentKey = key.slice(0, slash);
      if (files.has(parentKey)) {
        conflicts.add(files.get(parentKey));
        conflicts.add(originalPath);
      }
      slash = parentKey.lastIndexOf("/");
    }
  }

  return conflicts;
}

function comparablePath(value) {
  return value.normalize("NFC").toLowerCase();
}

function lstatIfPresent(value) {
  try {
    return lstatSync(value);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

async function ask(prompt, question) {
  return String((await prompt(question)) ?? "").trim();
}

async function askRequired(prompt, output, question) {
  while (true) {
    const answer = await ask(prompt, question);
    if (answer) return answer;
    output("此项不能为空。\n");
  }
}

async function askForAgentsDirectory(prompt, output) {
  while (true) {
    const answer = await ask(prompt, `原始 Agent 初始化目录（默认 ${defaultAgentsDirectory}）：`);
    const value = answer || defaultAgentsDirectory;
    if (isSafeProjectDirectory(value)) return value;
    output("请输入目标项目内的相对目录，不能包含 .. 或反斜杠。\n");
  }
}

async function askForDesignerInputs(prompt, output) {
  while (true) {
    const answer = await ask(
      prompt,
      "Designer 额外输入 Markdown（项目相对路径，多个用逗号分隔，可留空）："
    );
    if (!answer) return [];
    const values = answer.split(/[,，]/u).map((value) => value.trim()).filter(Boolean);
    if (values.length && values.every((value) => isSafeProjectFile(value, ".md"))) return values;
    output("请输入项目内的 .md 相对路径，不能包含 .. 或反斜杠。\n");
  }
}

async function askForComponentCatalog(prompt, output) {
  while (true) {
    const answer = await ask(
      prompt,
      "Designer 组件清单模块（项目相对 .mjs 路径，可留空）："
    );
    if (!answer || isSafeProjectFile(answer, ".mjs")) return answer || null;
    output("请输入项目内的 .mjs 相对路径，不能包含 .. 或反斜杠。\n");
  }
}

async function buildEntries(
  projectName,
  projectSummary,
  agentsDirectory,
  designerInputs,
  componentCatalogModule
) {
  const configTemplate = await readFile(path.join(templateRoot, "ai-native.yaml"), "utf8");
  const config = configTemplate
    .replaceAll("{{PROJECT_NAME}}", JSON.stringify(projectName))
    .replaceAll("{{PROJECT_SUMMARY}}", JSON.stringify(projectSummary))
    .replaceAll("{{AGENTS_DIRECTORY}}", JSON.stringify(agentsDirectory));

  const designerInputConfig = designerInputs.length
    ? `  markdown:\n${designerInputs.map((input) => `    - ${JSON.stringify(input)}`).join("\n")}`
    : "  markdown: []";
  const sharedEntries = await readTemplateDirectory(path.join(templateRoot, "shared"));
  for (const entry of sharedEntries) {
    entry.content = entry.content
      .replaceAll("{{DESIGNER_INPUTS}}", designerInputConfig)
      .replaceAll("{{DESIGNER_ROLE_PATH}}", JSON.stringify(`${agentsDirectory}/designer.md`))
      .replaceAll(
        JSON.stringify("__AI_SDLC_COMPONENT_CATALOG_MODULE__"),
        JSON.stringify(componentCatalogModule)
      );
  }

  const agentEntries = await readTemplateDirectory(path.join(templateRoot, "agents"));
  for (const entry of agentEntries) {
    entry.path = `${agentsDirectory}/${entry.path}`;
  }

  return [{ path: "ai-native.yaml", content: config }, ...sharedEntries, ...agentEntries];
}

function isSafeProjectDirectory(value) {
  if (path.isAbsolute(value) || value.includes("\\")) return false;
  return !value.split("/").some((segment) => !segment || segment === "." || segment === "..");
}

function isSafeProjectFile(value, extension) {
  if (!value.toLowerCase().endsWith(extension) || path.isAbsolute(value) || value.includes("\\")) {
    return false;
  }
  return !value.split("/").some((segment) => !segment || segment === "." || segment === "..");
}

async function readTemplateDirectory(directory, current = directory) {
  const entries = [];
  const directoryEntries = await readdir(current, { withFileTypes: true });
  directoryEntries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

  for (const entry of directoryEntries) {
    const source = path.join(current, entry.name);
    if (entry.isDirectory()) {
      entries.push(...await readTemplateDirectory(directory, source));
    } else if (entry.isFile()) {
      entries.push({
        path: path.relative(directory, source).split(path.sep).join("/"),
        content: await readFile(source, "utf8")
      });
    }
  }
  return entries;
}

function parseArgs(args) {
  if (!args.length) return { target: ".", help: false };
  if (args.length === 1 && ["help", "--help", "-h"].includes(args[0])) {
    return { target: ".", help: true };
  }
  if (args[0] !== "init") throw new Error(`仅支持 init，收到：${args[0]}`);
  if (args.length === 2 && ["--help", "-h"].includes(args[1])) {
    return { target: ".", help: true };
  }
  if (args.length > 2) throw new Error("用法：create-ai-native-sdlc init [target]");
  if (args[1]?.startsWith("-")) throw new Error(`未知选项：${args[1]}`);
  return { target: args[1] ?? ".", help: false };
}

function ensureNewline(value) {
  return `${value.trimEnd()}\n`;
}

function help() {
  return `create-ai-native-sdlc\n\n用法：\n  create-ai-native-sdlc init [target]\n\nCLI 会询问项目名称、项目简介、原始 Agent 初始化目录，以及可选的 Designer 输入和组件清单模块。\n`;
}

const entryPath = process.argv[1];
const isDirect = entryPath && existsSync(entryPath) && realpathSync(entryPath) === fileURLToPath(import.meta.url);
if (isDirect) {
  run().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`错误：${error.message}\n`);
    process.exitCode = 1;
  });
}
