#!/usr/bin/env node

import { lstatSync, realpathSync } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  readdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateRoot = path.join(packageRoot, "templates");
const roleIds = [
  "pm-ba",
  "designer",
  "architect",
  "software-engineer",
  "tester",
  "devops",
];

const aiTools = {
  copilot: {
    label: "GitHub Copilot",
    instructionsPath: ".github/copilot-instructions.md",
    agentsDirectory: ".github/agents",
    mcpPath: ".vscode/mcp.json",
    mcpContent: [
      "{",
      '  "servers": {',
      '    "shadcn": {',
      '      "command": "npx",',
      '      "args": ["shadcn@latest", "mcp"]',
      "    }",
      "  }",
      "}",
    ].join("\n"),
    roleFileName: (roleId) => `${roleId}.agent.md`,
    renderRole: renderMarkdownAgent,
  },
  claude: {
    label: "Claude Code",
    instructionsPath: "CLAUDE.md",
    agentsDirectory: ".claude/agents",
    mcpPath: ".mcp.json",
    mcpContent: [
      "{",
      '  "mcpServers": {',
      '    "shadcn": {',
      '      "command": "npx",',
      '      "args": ["shadcn@latest", "mcp"]',
      "    }",
      "  }",
      "}",
    ].join("\n"),
    roleFileName: (roleId) => `${roleId}.md`,
    renderRole: renderMarkdownAgent,
  },
  codex: {
    label: "Codex",
    instructionsPath: "AGENTS.md",
    agentsDirectory: ".codex/agents",
    mcpPath: ".codex/config.toml",
    mcpContent: [
      "[mcp_servers.shadcn]",
      'command = "npx"',
      'args = ["shadcn@latest", "mcp"]',
    ].join("\n"),
    roleFileName: (roleId) => `${roleId}.toml`,
    renderRole: renderCodexAgent,
  },
};

export async function run(args = process.argv.slice(2), context = {}) {
  const options = parseArgs(args);
  const output = context.output ?? ((message) => stdout.write(message));

  if (options.help) {
    output(help());
    return 0;
  }

  const cwd = context.cwd ?? process.cwd();
  const target = path.resolve(cwd, options.target);
  let terminal;
  let prompt = context.prompt;

  if (!prompt && (!options.name || !options.summary || !options.tool)) {
    terminal = createInterface({ input: stdin, output: stdout });
    prompt = (question) => terminal.question(question);
  }

  try {
    const defaultName = path.basename(target);
    const projectName = options.name
      ?? (await ask(prompt, `Project name (default: ${defaultName}): `))
      ?? defaultName;
    const resolvedName = projectName || defaultName;
    const projectSummary = options.summary
      ?? await askRequired(prompt, output, "Project summary: ");
    const toolKey = options.tool ?? await askForTool(prompt, output);
    const tool = aiTools[toolKey];
    const entries = await buildEntries(resolvedName, projectSummary, tool);
    const conflicts = findConflicts(target, entries);

    if (conflicts.length > 0) {
      throw new Error(
        `Initialization stopped. These paths already exist or are unsafe:\n${conflicts
          .map((item) => `- ${item}`)
          .join("\n")}`,
      );
    }

    await writeEntries(target, entries, context.beforeWrite);
    output(`Created ${entries.length} files for ${resolvedName}.\n`);
    output(`Tool: ${tool.label}\n`);
    output(`Instructions: ${tool.instructionsPath}\n`);
    output(`Role agents: ${tool.agentsDirectory}\n`);
    output(`shadcn MCP: ${tool.mcpPath}\n`);
    return 0;
  } finally {
    terminal?.close();
  }
}

async function ask(prompt, question) {
  if (!prompt) return null;
  return String((await prompt(question)) ?? "").trim();
}

async function askRequired(prompt, output, question) {
  while (true) {
    const answer = await ask(prompt, question);
    if (answer) return answer;
    if (!prompt) throw new Error(`${question.trim()} is required.`);
    output("Please enter a value.\n");
  }
}

async function askForTool(prompt, output) {
  const question = [
    "Choose your AI tool:",
    "  1. GitHub Copilot",
    "  2. Claude Code",
    "  3. Codex",
    "Enter 1, 2, or 3: ",
  ].join("\n");

  while (true) {
    const answer = await ask(prompt, question);
    const tool = normalizeTool(answer);
    if (tool) return tool;
    if (!prompt) throw new Error("--tool is required.");
    output("Choose 1, 2, or 3.\n");
  }
}

async function buildEntries(projectName, projectSummary, tool) {
  const projectSource = await readFile(path.join(templateRoot, "project.md"), "utf8");
  const projectInstructions = replaceValues(projectSource, {
    PROJECT_NAME: projectName,
    PROJECT_SUMMARY: projectSummary,
    AGENTS_DIRECTORY: tool.agentsDirectory,
  });

  const sharedRoot = path.join(templateRoot, "shared");
  const sharedEntries = await readTemplateDirectory(sharedRoot, sharedRoot);
  const roleEntries = [];

  for (const roleId of roleIds) {
    const source = await readFile(path.join(templateRoot, "agents", `${roleId}.md`), "utf8");
    roleEntries.push({
      path: `${tool.agentsDirectory}/${tool.roleFileName(roleId)}`,
      content: tool.renderRole(roleId, source),
    });
  }

  return [
    { path: tool.instructionsPath, content: projectInstructions },
    { path: tool.mcpPath, content: tool.mcpContent },
    ...sharedEntries,
    ...roleEntries,
  ];
}

async function readTemplateDirectory(root, directory) {
  const entries = [];
  const children = await readdir(directory, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));

  for (const child of children) {
    const sourcePath = path.join(directory, child.name);
    if (child.isDirectory()) {
      entries.push(...await readTemplateDirectory(root, sourcePath));
      continue;
    }
    if (!child.isFile()) {
      throw new Error(`Template is not a regular file: ${sourcePath}`);
    }

    entries.push({
      path: path.relative(root, sourcePath).split(path.sep).join("/"),
      content: await readFile(sourcePath, "utf8"),
    });
  }

  return entries;
}

function renderMarkdownAgent(roleId, source) {
  return [
    "---",
    `name: ${JSON.stringify(roleId)}`,
    `description: ${JSON.stringify(readRoleDescription(source))}`,
    "---",
    "",
    source.trim(),
  ].join("\n");
}

function renderCodexAgent(roleId, source) {
  return [
    `name = ${JSON.stringify(roleId)}`,
    `description = ${JSON.stringify(readRoleDescription(source))}`,
    `developer_instructions = ${JSON.stringify(source.trim())}`,
  ].join("\n");
}

function readRoleDescription(source) {
  const description = source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#"));

  if (!description) throw new Error("Each role needs a short description.");
  return description;
}

function replaceValues(source, values) {
  return source.replace(/\{\{([A-Z_]+)\}\}/gu, (token, key) => values[key] ?? token);
}

function findConflicts(target, entries) {
  const conflicts = new Set();
  const planned = new Map();

  for (const entry of entries) {
    assertSafeRelativePath(entry.path);
    const key = comparablePath(entry.path);
    if (planned.has(key)) {
      conflicts.add(planned.get(key));
      conflicts.add(entry.path);
    } else {
      planned.set(key, entry.path);
    }
  }

  for (const [key, originalPath] of planned) {
    let slash = key.lastIndexOf("/");
    while (slash >= 0) {
      const parentKey = key.slice(0, slash);
      if (planned.has(parentKey)) {
        conflicts.add(planned.get(parentKey));
        conflicts.add(originalPath);
      }
      slash = parentKey.lastIndexOf("/");
    }
  }

  const targetStats = lstatIfPresent(target);
  if (targetStats && (!targetStats.isDirectory() || targetStats.isSymbolicLink())) {
    conflicts.add(".");
    return [...conflicts].sort();
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
        conflicts.add(`${path.relative(target, parent).split(path.sep).join("/")}/`);
        break;
      }
    }
  }

  return [...conflicts].sort();
}

function assertSafeRelativePath(value) {
  if (
    typeof value !== "string"
    || !value
    || path.isAbsolute(value)
    || value.includes("\\")
    || value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe output path: ${value}`);
  }
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

async function writeEntries(target, entries, beforeWrite) {
  const createdFiles = [];

  try {
    if (!lstatIfPresent(target)) await mkdir(target, { recursive: true });
    const targetStats = lstatIfPresent(target);
    if (!targetStats?.isDirectory() || targetStats.isSymbolicLink()) {
      throw new Error("The target must be a real directory.");
    }

    for (const [index, entry] of entries.entries()) {
      await beforeWrite?.({ index, path: entry.path, target });
      const content = ensureNewline(entry.content);
      const destination = path.join(target, entry.path);
      await ensureDirectory(target, path.dirname(destination));
      const handle = await open(destination, "wx");
      const created = {
        path: destination,
        device: null,
        inode: null,
        snapshot: null,
      };
      createdFiles.push(created);
      try {
        const stats = await handle.stat();
        created.device = stats.dev;
        created.inode = stats.ino;
        await handle.writeFile(content, "utf8");
        created.snapshot = content;
      } catch (error) {
        try {
          created.snapshot = await readFile(destination, "utf8");
        } catch {
          // Keep the file if rollback cannot prove what this command wrote.
        }
        throw error;
      } finally {
        await handle.close();
      }
    }
  } catch (error) {
    const rollbackErrors = await rollback(createdFiles);
    if (rollbackErrors.length > 0) {
      const causes = [error, ...rollbackErrors]
        .map((cause) => `- ${cause.message}`)
        .join("\n");
      throw new AggregateError(
        [error, ...rollbackErrors],
        `Initialization failed, and some files could not be removed safely:\n${causes}`,
      );
    }
    throw error;
  }
}

async function ensureDirectory(target, directory) {
  const relative = path.relative(target, directory);
  if (!relative) return;

  let current = target;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stats = lstatIfPresent(current);
    if (!stats) {
      await mkdir(current);
      continue;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Output parent is not a real directory: ${path.relative(target, current)}`);
    }
  }
}

async function rollback(createdFiles) {
  const errors = [];

  for (const created of [...createdFiles].reverse()) {
    try {
      const stats = lstatIfPresent(created.path);
      if (!stats) continue;
      if (created.device === null || created.inode === null) {
        throw new Error(`A created file could not be checked during rollback and was kept: ${created.path}`);
      }
      if (stats.dev !== created.device || stats.ino !== created.inode) {
        throw new Error(`A created file was replaced during rollback and was kept: ${created.path}`);
      }
      if (created.snapshot === null) {
        throw new Error(`A created file could not be checked during rollback and was kept: ${created.path}`);
      }
      const current = await readFile(created.path, "utf8");
      if (current !== created.snapshot) {
        throw new Error(`A created file changed during rollback and was kept: ${created.path}`);
      }
      await unlink(created.path);
    } catch (error) {
      if (error?.code !== "ENOENT") errors.push(error);
    }
  }

  return errors;
}

function ensureNewline(value) {
  return `${value.trimEnd()}\n`;
}

function normalizeTool(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  const aliases = {
    "1": "copilot",
    copilot: "copilot",
    github: "copilot",
    "github-copilot": "copilot",
    "github copilot": "copilot",
    "2": "claude",
    claude: "claude",
    "claude-code": "claude",
    "claude code": "claude",
    "3": "codex",
    codex: "codex",
  };
  return aliases[normalized] ?? null;
}

function parseArgs(args) {
  if (args.includes("--help") || args.includes("-h")) {
    return { help: true, target: "." };
  }

  const values = [...args];
  const command = values.shift();
  if (command !== "init") {
    throw new Error("Use: create-ai-native-sdlc init [target]");
  }

  const options = {
    help: false,
    target: ".",
    name: null,
    summary: null,
    tool: null,
  };
  let targetSet = false;

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--name") {
      options.name = optionValue(values, ++index, "--name");
    } else if (value === "--summary") {
      options.summary = optionValue(values, ++index, "--summary");
    } else if (value === "--tool") {
      const rawTool = optionValue(values, ++index, value);
      options.tool = normalizeTool(rawTool);
      if (!options.tool) throw new Error(`Unknown AI tool: ${rawTool}`);
    } else if (value.startsWith("-")) {
      throw new Error(`Unknown option: ${value}`);
    } else if (!targetSet) {
      options.target = value;
      targetSet = true;
    } else {
      throw new Error(`Unexpected argument: ${value}`);
    }
  }

  return options;
}

function optionValue(values, index, option) {
  const value = values[index];
  if (!value || value.startsWith("-") || !value.trim()) {
    throw new Error(`${option} needs a value.`);
  }
  return value.trim();
}

function help() {
  return `create-ai-native-sdlc

Usage:
  create-ai-native-sdlc init [target] [options]

Options:
  --name <name>       Project name
  --summary <text>    Short project summary
  --tool <tool>       copilot, claude, or codex
  -h, --help          Show help
`;
}

const isDirect = process.argv[1]
  && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirect) {
  run().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
  });
}
