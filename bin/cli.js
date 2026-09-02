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
const coreRoleIds = [
  "pm-ba",
  "designer",
  "architect",
];
const developmentRoleIds = [
  "software-engineer",
  "tester",
  "devops",
];
const roleIds = [...coreRoleIds, ...developmentRoleIds];

const developmentProfiles = {
  none: {
    label: "No development",
    roleIds: coreRoleIds,
    activePhases: ["Discovery", "Design", "Architecture"],
    stackIds: [],
    defaultStack: null,
  },
  frontend: {
    label: "Frontend",
    roleIds,
    activePhases: [
      "Discovery",
      "Design",
      "Architecture",
      "Implementation",
      "Verification",
      "Release",
    ],
    stackIds: ["react-shadcn", "react-antd", "react-mui", "frontend-existing"],
    defaultStack: "react-shadcn",
  },
  backend: {
    label: "Backend",
    roleIds,
    activePhases: [
      "Discovery",
      "Design",
      "Architecture",
      "Implementation",
      "Verification",
      "Release",
    ],
    stackIds: ["java-spring", "node-typescript", "python-fastapi", "backend-existing"],
    defaultStack: "java-spring",
  },
};

const stackProfiles = {
  "react-shadcn": {
    development: "frontend",
    label: "React + Vite + Tailwind + shadcn/ui",
    uiSystem: "shadcn/ui",
    uiMcp: "shadcn",
    validationFocus: "For frontend work, prioritize configured type checks, lint, unit or component tests, and the production build.",
  },
  "react-antd": {
    development: "frontend",
    label: "React + Vite + Ant Design",
    uiSystem: "Ant Design",
    uiMcp: null,
    validationFocus: "For frontend work, prioritize configured type checks, lint, unit or component tests, and the production build.",
  },
  "react-mui": {
    development: "frontend",
    label: "React + Vite + Material UI",
    uiSystem: "Material UI",
    uiMcp: null,
    validationFocus: "For frontend work, prioritize configured type checks, lint, unit or component tests, and the production build.",
  },
  "frontend-existing": {
    development: "frontend",
    label: "Use the existing frontend stack",
    uiSystem: "Follow existing project conventions",
    uiMcp: null,
    validationFocus: "For frontend work, follow the project's configured build, type, lint, and test conventions.",
  },
  "java-spring": {
    development: "backend",
    label: "Java + Spring Boot",
    uiSystem: "Not applicable",
    uiMcp: null,
    validationFocus: "For Java backend work, prioritize the configured build, unit or service tests, and API or OpenAPI contract checks.",
  },
  "node-typescript": {
    development: "backend",
    label: "Node.js + TypeScript",
    uiSystem: "Not applicable",
    uiMcp: null,
    validationFocus: "For Node.js backend work, prioritize configured type checks, lint, unit or API tests, and contract checks.",
  },
  "python-fastapi": {
    development: "backend",
    label: "Python + FastAPI",
    uiSystem: "Not applicable",
    uiMcp: null,
    validationFocus: "For Python backend work, prioritize configured lint or type checks, unit or API tests, and contract checks.",
  },
  "backend-existing": {
    development: "backend",
    label: "Use the existing backend stack",
    uiSystem: "Not applicable",
    uiMcp: null,
    validationFocus: "For backend work, follow the project's configured build, lint, type, test, and contract conventions.",
  },
};

const validationProfiles = {
  lean: {
    label: "Lean",
    guidance: "Use the smallest existing build, type, lint, or test checks that cover the changed behavior.",
  },
  standard: {
    label: "Standard",
    guidance: "Use relevant tests plus the project's normal build, type, lint, and contract checks.",
  },
  thorough: {
    label: "Thorough",
    guidance: "Start with Standard and add relevant integration, end-to-end, security, or compatibility checks when the project supports them.",
  },
};

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
    output(`Development work: ${configuration.development === "none" ? "No" : "Yes"}\n`);
    output(`Development area: ${configuration.development === "none" ? "Not applicable" : configuration.developmentProfile.label}\n`);
    if (configuration.stack) output(`Stack: ${configuration.stack.label}\n`);
    if (configuration.validation) output(`Validation: ${configuration.validation.label}\n`);
    output(`Role agents: ${tool.agentsDirectory}\n`);
    output(`Dedicated agents: ${configuration.roleIds.join(", ")}\n`);
    if (configuration.stack?.uiMcp === "shadcn") {
      output(`shadcn MCP: ${tool.mcpPath}\n`);
    }
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
    || !options.development
    || (options.development !== "none" && (!options.stack || !options.validation));
}

async function resolveConfiguration(options, prompt, output, detected) {
  let development = options.development;

  if (!development) {
    const enabled = await askForDevelopmentWork(prompt, output, detected);
    development = enabled
      ? await askForDevelopmentArea(prompt, output, detected)
      : "none";
  }

  const developmentProfile = developmentProfiles[development];
  if (development === "none") {
    if (options.stack) {
      throw new Error("--stack cannot be used when --development is none.");
    }
    if (options.validation) {
      throw new Error("--validation cannot be used when --development is none.");
    }
    return {
      development,
      developmentProfile,
      stackId: "none",
      stack: null,
      validationId: "not-applicable",
      validation: null,
      roleIds: [...developmentProfile.roleIds],
      activePhases: [...developmentProfile.activePhases],
      detected,
    };
  }

  const stackId = options.stack
    ?? await askForStack(prompt, output, development, detected);
  const stack = stackProfiles[stackId];
  if (stack?.development !== development) {
    throw new Error(`Stack ${stackId} is not valid for ${development} development.`);
  }

  const validationId = options.validation ?? await askForValidation(prompt, output);
  const validation = validationProfiles[validationId];
  return {
    development,
    developmentProfile,
    stackId,
    stack,
    validationId,
    validation,
    roleIds: [...developmentProfile.roleIds],
    activePhases: [...developmentProfile.activePhases],
    detected,
  };
}

async function askForDevelopmentWork(prompt, output, detected) {
  if (!prompt) throw new Error("--development is required.");
  const detectedNote = detected.recommendedDevelopment
    ? ` Detected ${detected.recommendedDevelopment} project evidence.`
    : "";
  const question = [
    `Will this project perform code development?${detectedNote}`,
    "  1. Yes",
    "  2. No - product, design, and architecture work only",
    "Enter 1 or 2: ",
  ].join("\n");

  while (true) {
    const answer = String(await ask(prompt, question)).toLowerCase();
    if (["1", "yes", "y"].includes(answer)) return true;
    if (["2", "no", "n"].includes(answer)) return false;
    output("Choose 1 or 2.\n");
  }
}

async function askForDevelopmentArea(prompt, output, detected) {
  if (!prompt) throw new Error("--development is required.");
  const mark = (value) => detected.recommendedDevelopment === value
    ? " (detected; recommended)"
    : "";
  const question = [
    "What development work does this project own?",
    `  1. Frontend${mark("frontend")}`,
    `  2. Backend${mark("backend")}`,
    "Enter 1 or 2: ",
  ].join("\n");

  while (true) {
    const answer = normalizeDevelopment(await ask(prompt, question));
    if (answer === "frontend" || answer === "backend") return answer;
    output("Choose 1 or 2.\n");
  }
}

async function askForStack(prompt, output, development, detected) {
  if (!prompt) throw new Error(`--stack is required for ${development} development.`);
  const profile = developmentProfiles[development];
  const detectedStack = detected.recommendedStacks[development];
  const recommended = profile.stackIds.includes(detectedStack)
    ? detectedStack
    : profile.defaultStack;
  const choices = profile.stackIds.map((stackId, index) => {
    const suffix = stackId === recommended
      ? detectedStack === stackId ? " (project evidence; recommended)" : " (recommended)"
      : "";
    return `  ${index + 1}. ${stackProfiles[stackId].label}${suffix}`;
  });
  const answerRange = choiceRange(profile.stackIds.length);
  const question = [
    `Choose a ${development} stack preference:`,
    ...choices,
    `Enter ${answerRange}: `,
  ].join("\n");

  while (true) {
    const raw = await ask(prompt, question);
    const numeric = Number.parseInt(raw, 10);
    const stackId = Number.isInteger(numeric) && String(numeric) === raw
      ? profile.stackIds[numeric - 1]
      : normalizeStack(raw);
    if (profile.stackIds.includes(stackId)) return stackId;
    output(`Choose ${answerRange}.\n`);
  }
}

function choiceRange(count) {
  const choices = Array.from({ length: count }, (_, index) => String(index + 1));
  return choices.length === 2
    ? `${choices[0]} or ${choices[1]}`
    : `${choices.slice(0, -1).join(", ")}, or ${choices.at(-1)}`;
}

async function askForValidation(prompt, output) {
  if (!prompt) throw new Error("--validation is required when development is enabled.");
  const ids = ["standard", "lean", "thorough"];
  const question = [
    "Choose a validation preference:",
    "  1. Standard - normal tests and project checks (recommended)",
    "  2. Lean - smallest checks for the changed behavior",
    "  3. Thorough - add relevant integration or end-to-end checks",
    "Enter 1, 2, or 3: ",
  ].join("\n");

  while (true) {
    const raw = await ask(prompt, question);
    const numeric = Number.parseInt(raw, 10);
    const validationId = Number.isInteger(numeric) && String(numeric) === raw
      ? ids[numeric - 1]
      : normalizeValidation(raw);
    if (validationId) return validationId;
    output("Choose 1, 2, or 3.\n");
  }
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
  ];
  if (configuration.stack?.uiMcp === "shadcn") {
    entries.push({ path: tool.mcpPath, content: tool.mcpContent });
  }
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
    : "| None | No supported stack files were detected | No recommendation |";

  return {
    DEVELOPMENT_WORK: configuration.development === "none" ? "No" : "Yes",
    DEVELOPMENT_AREA: configuration.development === "none"
      ? "Not applicable"
      : configuration.developmentProfile.label,
    STACK: configuration.stack?.label ?? "Not applicable",
    UI_SYSTEM: configuration.stack?.uiSystem ?? "Not applicable",
    UI_MCP: configuration.stack?.uiMcp ?? "None",
    VALIDATION: configuration.validation?.label ?? "Not applicable",
    ACTIVE_PHASES: configuration.activePhases.join(", "),
    DEDICATED_AGENTS: configuration.roleIds.join(", "),
    VALIDATION_GUIDANCE: configuration.validation
      ? `${configuration.validation.guidance} ${configuration.stack.validationFocus}`
      : "Code validation is not configured because this project does not perform development work.",
    DETECTED_EVIDENCE_ROWS: evidenceRows,
  };
}

function markdownCell(value) {
  return String(value).replace(/\|/gu, "\\|").replace(/\r?\n/gu, " ");
}

async function detectProject(target) {
  const evidence = [];
  let frontendDetected = false;
  let backendDetected = false;
  const recommendedStacks = { frontend: null, backend: null };
  const backendStackCandidates = new Set();
  let react = false;
  let vite = false;
  let tailwind = false;
  let antDesign = false;
  let materialUi = false;
  let nodeBackend = false;
  let typeScript = false;
  const targetStats = lstatIfPresent(target);
  if (targetStats && (!targetStats.isDirectory() || targetStats.isSymbolicLink())) {
    return { evidence, recommendedDevelopment: null, recommendedStacks };
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

      react = has("react");
      vite = has("vite");
      tailwind = has("tailwindcss");
      antDesign = has("antd");
      materialUi = has("@mui/material");
      nodeBackend = ["@nestjs/core", "express", "fastify"].some(has);
      typeScript = has("typescript");

      if (react) {
        frontendDetected = true;
        signals.push("React dependency");
      }
      if (vite) signals.push("Vite dependency");
      if (tailwind) signals.push("Tailwind CSS dependency");
      if (antDesign) {
        frontendDetected = true;
        signals.push("Ant Design dependency");
      }
      if (materialUi) {
        frontendDetected = true;
        signals.push("Material UI dependency");
      }
      if (nodeBackend) {
        backendDetected = true;
        signals.push("Node.js backend dependency");
      }
      if (typeScript) signals.push("TypeScript dependency");
      if (scripts.length > 0) signals.push(`scripts: ${scripts.join(", ")}`);
    } catch {
      signals.push("content could not be parsed");
    }
    evidence.push({
      path: "package.json",
      signal: signals.join("; "),
      usedFor: frontendDetected || backendDetected
        ? "development area, stack preference, and validation evidence"
        : "existing-stack and validation evidence",
    });
  }

  if (hasProjectFile(target, "tsconfig.json")) {
    typeScript = true;
    evidence.push({
      path: "tsconfig.json",
      signal: "TypeScript project configuration",
      usedFor: nodeBackend ? "backend stack evidence" : "project evidence",
    });
  }

  if (nodeBackend) {
    backendStackCandidates.add(typeScript ? "node-typescript" : "backend-existing");
  }

  const componentsSource = await readProjectFile(target, "components.json");
  const shadcn = componentsSource !== null && isShadcnConfiguration(componentsSource);
  if (componentsSource !== null) {
    if (shadcn) frontendDetected = true;
    evidence.push({
      path: "components.json",
      signal: shadcn
        ? "shadcn/ui project configuration"
        : "components.json present; shadcn/ui configuration not confirmed",
      usedFor: shadcn ? "frontend stack and UI MCP evidence" : "project evidence only",
    });
  }

  if (frontendDetected) {
    const frontendStackCandidates = [];
    const shadcnMatchesPreset = react && vite && tailwind && shadcn;
    const antDesignMatchesPreset = react && vite && antDesign;
    const materialUiMatchesPreset = react && vite && materialUi;
    if (shadcnMatchesPreset) frontendStackCandidates.push("react-shadcn");
    if (antDesignMatchesPreset) frontendStackCandidates.push("react-antd");
    if (materialUiMatchesPreset) frontendStackCandidates.push("react-mui");

    const incompleteUiEvidence = (shadcn && !shadcnMatchesPreset)
      || (antDesign && !antDesignMatchesPreset)
      || (materialUi && !materialUiMatchesPreset);
    recommendedStacks.frontend = frontendStackCandidates.length === 1 && !incompleteUiEvidence
      ? frontendStackCandidates[0]
      : "frontend-existing";
  }

  for (const [file, signal] of [
    ["pnpm-lock.yaml", "pnpm lockfile"],
    ["yarn.lock", "Yarn lockfile"],
    ["package-lock.json", "npm lockfile"],
  ]) {
    if (hasProjectFile(target, file)) {
      evidence.push({ path: file, signal, usedFor: "package-manager evidence" });
    }
  }

  const javaFiles = ["pom.xml", "build.gradle", "build.gradle.kts"];
  for (const file of javaFiles) {
    const source = await readProjectFile(target, file);
    if (source === null) continue;
    backendDetected = true;
    const spring = /spring[.-]boot|org\.springframework\.boot/iu.test(source);
    backendStackCandidates.add(spring ? "java-spring" : "backend-existing");
    evidence.push({
      path: file,
      signal: spring ? "Java build with Spring Boot" : "Java build file",
      usedFor: spring
        ? "backend stack and validation recommendation"
        : "backend area, existing-stack, and validation recommendation",
    });
  }
  for (const [file, signal] of [
    ["mvnw", "Maven wrapper"],
    ["gradlew", "Gradle wrapper"],
  ]) {
    if (hasProjectFile(target, file)) {
      evidence.push({ path: file, signal, usedFor: "validation command evidence" });
    }
  }

  for (const file of ["pyproject.toml", "requirements.txt"]) {
    const source = await readProjectFile(target, file);
    if (source === null) continue;
    backendDetected = true;
    const fastApi = /\bfastapi\b/iu.test(source);
    backendStackCandidates.add(fastApi ? "python-fastapi" : "backend-existing");
    evidence.push({
      path: file,
      signal: fastApi ? "Python project with FastAPI" : "Python project file",
      usedFor: fastApi
        ? "backend stack and validation recommendation"
        : "backend area, existing-stack, and validation recommendation",
    });
  }

  if (backendStackCandidates.size === 1) {
    [recommendedStacks.backend] = backendStackCandidates;
  } else if (backendStackCandidates.size > 1) {
    recommendedStacks.backend = "backend-existing";
  }

  if (targetHasContent) {
    recommendedStacks.frontend ??= "frontend-existing";
    recommendedStacks.backend ??= "backend-existing";
    if (evidence.length === 0) {
      evidence.push({
        path: ".",
        signal: "Target directory is not empty",
        usedFor: "existing-stack recommendation",
      });
    }
  }

  return {
    evidence,
    recommendedDevelopment: frontendDetected === backendDetected
      ? null
      : frontendDetected ? "frontend" : "backend",
    recommendedStacks,
  };
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

function normalizeDevelopment(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  const aliases = {
    "1": "frontend",
    frontend: "frontend",
    front: "frontend",
    "front-end": "frontend",
    "2": "backend",
    backend: "backend",
    back: "backend",
    "back-end": "backend",
    none: "none",
    no: "none",
    docs: "none",
    documentation: "none",
    "no-development": "none",
  };
  return aliases[normalized] ?? null;
}

function normalizeStack(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  const aliases = {
    "react-shadcn": "react-shadcn",
    shadcn: "react-shadcn",
    "shadcn/ui": "react-shadcn",
    "react-antd": "react-antd",
    antd: "react-antd",
    "ant-design": "react-antd",
    "ant design": "react-antd",
    "react-mui": "react-mui",
    mui: "react-mui",
    "material-ui": "react-mui",
    "material ui": "react-mui",
    "frontend-existing": "frontend-existing",
    "existing-frontend": "frontend-existing",
    "java-spring": "java-spring",
    java: "java-spring",
    spring: "java-spring",
    "spring-boot": "java-spring",
    "node-typescript": "node-typescript",
    node: "node-typescript",
    typescript: "node-typescript",
    "python-fastapi": "python-fastapi",
    python: "python-fastapi",
    fastapi: "python-fastapi",
    "backend-existing": "backend-existing",
    "existing-backend": "backend-existing",
  };
  return aliases[normalized] ?? null;
}

function normalizeValidation(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  const aliases = {
    lean: "lean",
    light: "lean",
    minimal: "lean",
    standard: "standard",
    normal: "standard",
    thorough: "thorough",
    full: "thorough",
    complete: "thorough",
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
    development: null,
    stack: null,
    validation: null,
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
    } else if (value === "--development") {
      const rawDevelopment = optionValue(values, ++index, value);
      options.development = normalizeDevelopment(rawDevelopment);
      if (!options.development) {
        throw new Error(`Unknown development mode: ${rawDevelopment}`);
      }
    } else if (value === "--stack") {
      const rawStack = optionValue(values, ++index, value);
      options.stack = normalizeStack(rawStack);
      if (!options.stack) throw new Error(`Unknown stack: ${rawStack}`);
    } else if (value === "--validation") {
      const rawValidation = optionValue(values, ++index, value);
      options.validation = normalizeValidation(rawValidation);
      if (!options.validation) {
        throw new Error(`Unknown validation preference: ${rawValidation}`);
      }
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
  --development <mode>        none, frontend, or backend
  --stack <preset>            Stack preset for frontend or backend development
  --validation <preference>   lean, standard, or thorough
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
