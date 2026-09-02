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
const roleDefinitions = [
  {
    id: "pm-ba",
    label: "PM / BA",
    phase: "Discovery",
    purpose: "product discovery and requirements",
    artifactPaths: [
      "/docs/ai-sdlc/prd.md",
      "/docs/ai-sdlc/stories/",
    ],
  },
  {
    id: "designer",
    label: "Designer",
    phase: "Design",
    purpose: "experience and interaction design",
    artifactPaths: [
      "/docs/ai-sdlc/design-baseline.md",
      "/docs/ai-sdlc/design-spec.md",
    ],
  },
  {
    id: "architect",
    label: "Architect",
    phase: "Architecture",
    purpose: "system architecture and technology planning",
    artifactPaths: [
      "/docs/ai-sdlc/technology-profile.md",
      "/docs/ai-sdlc/architecture.md",
      "/docs/ai-sdlc/architecture-discovery-context.md",
      "/docs/ai-sdlc/architecture-options.md",
      "/docs/ai-sdlc/architecture-c4-context.mmd",
      "/docs/ai-sdlc/architecture-c4-containers.mmd",
      "/docs/ai-sdlc/architecture-patterns.md",
      "/docs/ai-sdlc/architecture-nfrs.md",
      "/docs/ai-sdlc/architecture-risk-review.md",
      "/docs/ai-sdlc/adrs/",
    ],
  },
  {
    id: "software-engineer",
    label: "Software Engineer",
    phase: "Implementation",
    purpose: "software implementation",
    artifactPaths: [
      "/docs/ai-sdlc/implementation-plan.md",
      "/docs/ai-sdlc/implementation-tasks.md",
      "/docs/ai-sdlc/implementation-notes.md",
    ],
  },
  {
    id: "tester",
    label: "Tester",
    phase: "Verification",
    purpose: "verification and quality evidence",
    artifactPaths: ["/docs/ai-sdlc/test-report.md"],
  },
  {
    id: "devops",
    label: "DevOps",
    phase: "Release",
    purpose: "release and operations",
    artifactPaths: ["/docs/ai-sdlc/release-runbook.md"],
  },
];
const roleIds = roleDefinitions.map(({ id }) => id);
const roleById = new Map(roleDefinitions.map((role) => [role.id, role]));

const aiTools = {
  copilot: {
    label: "GitHub Copilot",
    instructionsPath: ".github/copilot-instructions.md",
    agentsDirectory: ".github/agents",
    roleFileName: (roleId) => `${roleId}.agent.md`,
    renderRole: renderMarkdownAgent,
  },
  claude: {
    label: "Claude Code",
    instructionsPath: "CLAUDE.md",
    agentsDirectory: ".claude/agents",
    roleFileName: (roleId) => `${roleId}.md`,
    renderRole: renderMarkdownAgent,
  },
  codex: {
    label: "Codex",
    instructionsPath: "AGENTS.md",
    agentsDirectory: ".codex/agents",
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
  const detected = await detectProject(target);
  let terminal;
  let prompt = context.prompt;

  if (!prompt && needsInteractiveInput(options) && stdin.isTTY && context.output === undefined) {
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
    const configuration = await resolveConfiguration(options, prompt, output, detected);
    const entries = await buildEntries(
      resolvedName,
      projectSummary,
      tool,
      configuration,
    );
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
    output("Profile: .ai-sdlc/project-profile.md\n");
    output("Artifact hosts: .ai-sdlc/artifact-hosts.json\n");
    output("Artifact bridge: .agents/skills/sdlc-artifact-bridge/SKILL.md\n");
    output(`Role agents: ${configuration.roleIds.length > 0 ? tool.agentsDirectory : "None"}\n`);
    output(`Selected roles: ${formatList(configuration.roleIds)}\n`);
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

function needsInteractiveInput(options) {
  return !options.name
    || !options.summary
    || !options.tool
    || options.roles === null;
}

async function resolveConfiguration(options, prompt, output, detected) {
  const selectedRoleIds = options.roles ?? await askForRoles(prompt, output);
  return {
    roleIds: [...selectedRoleIds],
    activePhases: selectedRoleIds.map((roleId) => roleById.get(roleId).phase),
    detected,
  };
}

async function askForRoles(prompt, output) {
  if (!prompt) throw new Error("--roles is required.");
  const selected = [];

  for (const role of roleDefinitions) {
    const question = [
      `Initialize the ${role.label} role for ${role.purpose}?`,
      "  1. Yes",
      "  2. No",
      "Enter 1 or 2: ",
    ].join("\n");

    while (true) {
      const answer = String(await ask(prompt, question)).toLowerCase();
      if (["1", "yes", "y"].includes(answer)) {
        selected.push(role.id);
        break;
      }
      if (["2", "no", "n"].includes(answer)) break;
      output("Choose 1 or 2.\n");
    }
  }

  return selected;
}

async function buildEntries(projectName, projectSummary, tool, configuration) {
  const projectSource = await readFile(path.join(templateRoot, "project.md"), "utf8");
  const projectInstructions = replaceValues(projectSource, {
    PROJECT_NAME: projectName,
    PROJECT_SUMMARY: projectSummary,
    AGENTS_DIRECTORY: tool.agentsDirectory,
  });
  const profileSource = await readFile(path.join(templateRoot, "project-profile.md"), "utf8");
  const projectProfile = replaceValues(profileSource, profileValues(configuration));

  const sharedRoot = path.join(templateRoot, "shared");
  const sharedEntries = await readTemplateDirectory(sharedRoot, sharedRoot);
  const roleEntries = [];

  for (const roleId of configuration.roleIds) {
    const source = await readFile(path.join(templateRoot, "agents", `${roleId}.md`), "utf8");
    roleEntries.push({
      path: `${tool.agentsDirectory}/${tool.roleFileName(roleId)}`,
      content: tool.renderRole(roleId, source),
    });
  }

  const entries = [
    { path: tool.instructionsPath, content: projectInstructions },
    { path: ".ai-sdlc/artifact-hosts.json", content: renderArtifactHosts(configuration) },
  ];
  entries.push(
    { path: ".ai-sdlc/project-profile.md", content: projectProfile },
    ...sharedEntries,
    ...roleEntries,
  );
  return entries;
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

function profileValues(configuration) {
  const evidenceRows = configuration.detected.evidence.length > 0
    ? configuration.detected.evidence.map((item) => [
      markdownCell(item.path),
      markdownCell(item.signal),
      markdownCell(item.usedFor),
    ].join(" | ")).map((row) => `| ${row} |`).join("\n")
    : "| None | No supported project evidence was detected | Available to the Architect on first use |";

  const roleCoverageRows = roleDefinitions.map((role) => {
    const local = configuration.roleIds.includes(role.id);
    return `| ${role.phase} | ${role.id} | ${local ? "Initialized" : "Not initialized"} | ${local ? "local" : "unconfigured"} |`;
  }).join("\n");

  return {
    LOCAL_ROLE_AGENTS: formatList(configuration.roleIds),
    ACTIVE_LOCAL_PHASES: formatList(configuration.activePhases),
    ROLE_COVERAGE_ROWS: roleCoverageRows,
    DETECTED_EVIDENCE_ROWS: evidenceRows,
  };
}

function renderArtifactHosts(configuration) {
  const routes = Object.fromEntries(roleDefinitions.map((role) => {
    const local = configuration.roleIds.includes(role.id);
    return [role.phase.toLowerCase(), {
      phase: role.phase,
      role: role.id,
      host: local ? "local" : null,
      paths: role.artifactPaths,
    }];
  }));
  return JSON.stringify({
    version: 1,
    defaultHost: "local",
    hosts: {
      local: {
        kind: "filesystem",
        root: ".",
        artifactIndex: "docs/ai-sdlc/index.md",
      },
    },
    routes,
  }, null, 2);
}

function formatList(values) {
  return values.length > 0 ? values.join(", ") : "None";
}

function markdownCell(value) {
  return String(value).replace(/\|/gu, "\\|").replace(/\r?\n/gu, " ");
}

async function detectProject(target) {
  const evidence = [];
  const targetStats = lstatIfPresent(target);
  if (targetStats && (!targetStats.isDirectory() || targetStats.isSymbolicLink())) {
    return { evidence };
  }
  const targetHasContent = targetStats?.isDirectory()
    ? (await readdir(target)).length > 0
    : false;

  const packageSource = await readProjectFile(target, "package.json");
  if (packageSource !== null) {
    const signals = ["Node.js package manifest"];
    try {
      const manifest = JSON.parse(packageSource);
      const packages = {
        ...(manifest.dependencies ?? {}),
        ...(manifest.devDependencies ?? {}),
      };
      const has = (name) => Object.hasOwn(packages, name);
      const scripts = Object.keys(manifest.scripts ?? {})
        .filter((name) => ["build", "lint", "test", "typecheck"].includes(name));

      if (has("react")) signals.push("React dependency");
      if (has("vite")) signals.push("Vite dependency");
      if (has("tailwindcss")) signals.push("Tailwind CSS dependency");
      if (has("antd")) signals.push("Ant Design dependency");
      if (has("@mui/material")) signals.push("Material UI dependency");
      if (["@nestjs/core", "express", "fastify"].some(has)) {
        signals.push("Node.js backend dependency");
      }
      if (has("typescript")) signals.push("TypeScript dependency");
      if (scripts.length > 0) signals.push(`scripts: ${scripts.join(", ")}`);
    } catch {
      signals.push("content could not be parsed");
    }
    evidence.push({
      path: "package.json",
      signal: signals.join("; "),
      usedFor: "Architect technology-profile evidence",
    });
  }

  if (hasProjectFile(target, "tsconfig.json")) {
    evidence.push({
      path: "tsconfig.json",
      signal: "TypeScript project configuration",
      usedFor: "Architect technology-profile evidence",
    });
  }

  const componentsSource = await readProjectFile(target, "components.json");
  const shadcn = componentsSource !== null && isShadcnConfiguration(componentsSource);
  if (componentsSource !== null) {
    evidence.push({
      path: "components.json",
      signal: shadcn
        ? "shadcn/ui project configuration"
        : "components.json present; shadcn/ui configuration not confirmed",
      usedFor: "Architect technology-profile evidence",
    });
  }

  for (const [file, signal] of [
    ["pnpm-lock.yaml", "pnpm lockfile"],
    ["yarn.lock", "Yarn lockfile"],
    ["package-lock.json", "npm lockfile"],
  ]) {
    if (hasProjectFile(target, file)) {
      evidence.push({ path: file, signal, usedFor: "Architect technology-profile evidence" });
    }
  }

  const javaFiles = ["pom.xml", "build.gradle", "build.gradle.kts"];
  for (const file of javaFiles) {
    const source = await readProjectFile(target, file);
    if (source === null) continue;
    const spring = /spring[.-]boot|org\.springframework\.boot/iu.test(source);
    evidence.push({
      path: file,
      signal: spring ? "Java build with Spring Boot" : "Java build file",
      usedFor: "Architect technology-profile evidence",
    });
  }
  for (const [file, signal] of [
    ["mvnw", "Maven wrapper"],
    ["gradlew", "Gradle wrapper"],
  ]) {
    if (hasProjectFile(target, file)) {
      evidence.push({ path: file, signal, usedFor: "Architect technology-profile evidence" });
    }
  }

  for (const file of ["pyproject.toml", "requirements.txt"]) {
    const source = await readProjectFile(target, file);
    if (source === null) continue;
    const fastApi = /\bfastapi\b/iu.test(source);
    evidence.push({
      path: file,
      signal: fastApi ? "Python project with FastAPI" : "Python project file",
      usedFor: "Architect technology-profile evidence",
    });
  }

  if (targetHasContent && evidence.length === 0) {
    evidence.push({
      path: ".",
      signal: "Target directory is not empty",
      usedFor: "Architect discovery evidence",
    });
  }

  return { evidence };
}

function isShadcnConfiguration(source) {
  try {
    const configuration = JSON.parse(source);
    return configuration !== null
      && typeof configuration === "object"
      && !Array.isArray(configuration)
      && typeof configuration.$schema === "string"
      && /ui\.shadcn\.com\/schema\.json/iu.test(configuration.$schema);
  } catch {
    return false;
  }
}

function hasProjectFile(target, relativePath) {
  const stats = lstatIfPresent(path.join(target, relativePath));
  return Boolean(stats?.isFile() && !stats.isSymbolicLink());
}

async function readProjectFile(target, relativePath) {
  const file = path.join(target, relativePath);
  const stats = lstatIfPresent(file);
  if (!stats?.isFile() || stats.isSymbolicLink()) return null;
  return readFile(file, "utf8");
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

function parseRoles(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "all") return [...roleIds];
  if (raw === "none") return [];

  const aliases = {
    "pm-ba": "pm-ba",
    pm: "pm-ba",
    ba: "pm-ba",
    designer: "designer",
    design: "designer",
    architect: "architect",
    architecture: "architect",
    "software-engineer": "software-engineer",
    engineer: "software-engineer",
    developer: "software-engineer",
    tester: "tester",
    qa: "tester",
    devops: "devops",
    ops: "devops",
  };
  const selected = new Set();

  for (const item of raw.split(",").map((part) => part.trim())) {
    const roleId = aliases[item];
    if (!roleId) throw new Error(`Unknown role: ${item || value}`);
    if (selected.has(roleId)) throw new Error(`Duplicate role: ${roleId}`);
    selected.add(roleId);
  }

  return roleIds.filter((roleId) => selected.has(roleId));
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
    roles: null,
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
    } else if (value === "--roles") {
      options.roles = parseRoles(optionValue(values, ++index, value));
    } else if (value === "--development") {
      throw new Error("--development was removed. Select independent local agents with --roles.");
    } else if (value === "--stack" || value === "--validation") {
      throw new Error(`${value} was removed. The Architect records technology and quality decisions in the technology profile when they are needed.`);
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
  --name <name>               Project name
  --summary <text>            Short project summary
  --tool <tool>               copilot, claude, or codex
  --roles <list>              Comma-separated role IDs, all, or none
  -h, --help                  Show help
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
