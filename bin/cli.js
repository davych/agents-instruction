#!/usr/bin/env node

import { constants as fsConstants, lstatSync, realpathSync } from "node:fs";
import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateRoot = path.join(packageRoot, "templates");
const installationPath = ".ai-sdlc/installation.json";
const installationSchemaVersion = 1;
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
  if (options.command === "update") {
    return runUpdate(target, options, context, output);
  }

  return runInit(target, options, context, output);
}

async function runInit(target, options, context, output) {
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
      toolKey,
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
    output(`Installation: ${installationPath}\n`);
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

async function runUpdate(target, options, context, output) {
  const targetIdentity = assertUpdateTarget(target);
  const installation = await detectInstallation(target, options.tool, targetIdentity);
  const tool = aiTools[installation.toolKey];
  const entries = await buildUpdateEntries(
    target,
    installation.toolKey,
    tool,
    installation.roleIds,
    targetIdentity,
  );
  await context.beforePlan?.({ target, entries });
  assertUpdateTarget(target, targetIdentity);
  const result = await updateEntries(
    target,
    entries,
    context,
    targetIdentity,
  );

  output(`Refreshed SDLC-managed files for ${tool.label}.\n`);
  output(`Tool: ${tool.label}\n`);
  output(`Updated: ${result.updated}\n`);
  output(`Added: ${result.created}\n`);
  output(`Unchanged: ${result.unchanged}\n`);
  output(`Selected roles: ${formatList(installation.roleIds)}\n`);
  output("Preserved project settings and delivery artifacts.\n");
  return 0;
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

async function buildEntries(projectName, projectSummary, toolKey, tool, configuration) {
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
    {
      path: installationPath,
      content: renderInstallation(toolKey, configuration.roleIds),
    },
  ];
  entries.push(
    { path: ".ai-sdlc/project-profile.md", content: projectProfile },
    ...sharedEntries,
    ...roleEntries,
  );
  return entries;
}

async function buildUpdateEntries(
  target,
  toolKey,
  tool,
  installedRoleIds,
  targetIdentity,
) {
  assertTargetIdentity(target, targetIdentity);
  const sharedRoot = path.join(templateRoot, "shared");
  const sharedEntries = (await readTemplateDirectory(sharedRoot, sharedRoot))
    .filter(({ path: entryPath }) => isManagedUpdatePath(entryPath));
  const roleEntries = [];

  for (const roleId of installedRoleIds) {
    const source = await readFile(path.join(templateRoot, "agents", `${roleId}.md`), "utf8");
    roleEntries.push({
      path: `${tool.agentsDirectory}/${tool.roleFileName(roleId)}`,
      content: tool.renderRole(roleId, source),
    });
  }

  const configurationEntries = [];
  const profileMissing = !lstatIfPresent(path.join(target, ".ai-sdlc/project-profile.md"));
  const registryMissing = !lstatIfPresent(path.join(target, ".ai-sdlc/artifact-hosts.json"));
  const configuration = {
    roleIds: installedRoleIds,
    activePhases: installedRoleIds.map((roleId) => roleById.get(roleId).phase),
    detected: profileMissing ? await detectProject(target) : { evidence: [] },
  };

  if (!lstatIfPresent(path.join(target, installationPath))) {
    configurationEntries.push({
      path: installationPath,
      content: renderInstallation(toolKey, installedRoleIds),
      createOnly: true,
    });
  }
  if (profileMissing) {
    const profileSource = await readFile(path.join(templateRoot, "project-profile.md"), "utf8");
    configurationEntries.push({
      path: ".ai-sdlc/project-profile.md",
      content: replaceValues(profileSource, profileValues(configuration)),
      createOnly: true,
    });
  }
  if (registryMissing) {
    configurationEntries.push({
      path: ".ai-sdlc/artifact-hosts.json",
      content: renderArtifactHosts(configuration),
      createOnly: true,
    });
  }

  assertTargetIdentity(target, targetIdentity);
  return [...configurationEntries, ...sharedEntries, ...roleEntries];
}

function isManagedUpdatePath(entryPath) {
  return entryPath === ".ai-sdlc/workflow.md"
    || entryPath === ".ai-sdlc/technology-planning.md"
    || entryPath === ".agents/skills/sdlc-artifact-bridge/SKILL.md"
    || entryPath.startsWith(".ai-sdlc/templates/");
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

function renderInstallation(tool, selectedRoleIds) {
  return JSON.stringify({
    schemaVersion: installationSchemaVersion,
    tool,
    roles: selectedRoleIds,
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

async function readSafeProjectFile(
  target,
  relativePath,
  expectedStats,
  targetIdentity = readTargetIdentity(target),
) {
  assertSafeParents(target, relativePath, targetIdentity);
  const destination = path.join(target, relativePath);
  const handle = await open(destination, existingOpenFlags(false));
  try {
    const stats = await handle.stat();
    if (
      !stats.isFile()
      || stats.nlink !== 1
      || stats.dev !== expectedStats.dev
      || stats.ino !== expectedStats.ino
    ) {
      throw new Error(`Unsafe project file: ${relativePath}`);
    }
    assertRealPathInside(target, destination, relativePath, targetIdentity);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function assertUpdateTarget(target, expectedIdentity) {
  const targetIdentity = readTargetIdentity(target);
  if (expectedIdentity) assertMatchingTargetIdentity(targetIdentity, expectedIdentity);

  const sdlcDirectory = lstatIfPresent(path.join(target, ".ai-sdlc"));
  if (!sdlcDirectory?.isDirectory() || sdlcDirectory.isSymbolicLink()) {
    throw new Error(
      "Update stopped. No supported SDLC installation was found. Run init first.",
    );
  }

  for (const relativePath of [
    installationPath,
    ".ai-sdlc/project-profile.md",
    ".ai-sdlc/artifact-hosts.json",
  ]) {
    const stats = lstatIfPresent(path.join(target, relativePath));
    if (stats && (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1)) {
      throw new Error(`Update stopped. Installation state is unsafe: ${relativePath}`);
    }
  }
  return targetIdentity;
}

async function detectInstallation(target, requestedTool, targetIdentity) {
  assertTargetIdentity(target, targetIdentity);
  const record = await readInstallation(target, targetIdentity);
  if (record) {
    if (requestedTool && requestedTool !== record.tool) {
      throw new Error(
        `Update stopped. This SDLC installation uses ${record.tool}, not ${requestedTool}.`,
      );
    }
    return { toolKey: record.tool, roleIds: record.roles };
  }

  if (!hasLegacyInstallationLayout(target)) {
    throw new Error(
      "Update stopped. No supported SDLC installation was found. Run init first.",
    );
  }

  const installed = [];
  for (const [toolKey, tool] of Object.entries(aiTools)) {
    if (await hasGeneratedProjectInstructions(target, tool, targetIdentity)) {
      installed.push([toolKey, tool]);
    }
  }
  const selected = requestedTool
    ? installed.find(([toolKey]) => toolKey === requestedTool)
    : installed.length === 1 ? installed[0] : null;

  if (!selected) {
    if (installed.length > 1 && !requestedTool) {
      throw new Error(
        `Update stopped. Multiple legacy SDLC tools were detected (${installed
          .map(([toolKey]) => toolKey)
          .join(", ")}). Choose one with --tool.`,
      );
    }
    const detail = requestedTool
      ? `${aiTools[requestedTool].label} is not recognized as this SDLC installation.`
      : "No generated AI tool instructions were recognized.";
    throw new Error(`Update stopped. ${detail}`);
  }

  return {
    toolKey: selected[0],
    roleIds: await detectInstalledRoleIds(target, selected[1], targetIdentity),
  };
}

async function readInstallation(target, targetIdentity) {
  const file = path.join(target, installationPath);
  const stats = lstatIfPresent(file);
  if (!stats) return null;

  let record;
  try {
    record = JSON.parse(await readSafeProjectFile(
      target,
      installationPath,
      stats,
      targetIdentity,
    ));
  } catch (error) {
    throw new Error(`Update stopped. ${installationPath} is invalid: ${error.message}`);
  }
  if (
    record === null
    || typeof record !== "object"
    || Array.isArray(record)
    || record.schemaVersion !== installationSchemaVersion
    || !Object.hasOwn(aiTools, record.tool)
    || !Array.isArray(record.roles)
  ) {
    throw new Error(`Update stopped. ${installationPath} has an unsupported format.`);
  }
  const hasUnknownRole = record.roles.some(
    (roleId) => typeof roleId !== "string" || !roleById.has(roleId),
  );
  if (hasUnknownRole || new Set(record.roles).size !== record.roles.length) {
    throw new Error(`Update stopped. ${installationPath} contains invalid roles.`);
  }
  return {
    tool: record.tool,
    roles: roleIds.filter((roleId) => record.roles.includes(roleId)),
  };
}

function hasLegacyInstallationLayout(target) {
  const workflow = lstatIfPresent(path.join(target, ".ai-sdlc/workflow.md"));
  const oldWorkflow = lstatIfPresent(path.join(target, ".ai-sdlc/workflows/default.md"));
  const templates = lstatIfPresent(path.join(target, ".ai-sdlc/templates"));
  return Boolean(
    (workflow?.isFile() && !workflow.isSymbolicLink())
    || (oldWorkflow?.isFile() && !oldWorkflow.isSymbolicLink())
    || (templates?.isDirectory() && !templates.isSymbolicLink()),
  );
}

async function hasGeneratedProjectInstructions(target, tool, targetIdentity) {
  const stats = lstatIfPresent(path.join(target, tool.instructionsPath));
  if (!stats?.isFile() || stats.isSymbolicLink()) return false;
  const source = await readSafeProjectFile(
    target,
    tool.instructionsPath,
    stats,
    targetIdentity,
  );
  return /^# AI-native delivery workflow\s*$/mu.test(source)
    && /^\*\*Project:\*\*\s+.+$/mu.test(source)
    && /^\*\*Goal:\*\*\s+.+$/mu.test(source)
    && /(?:\.ai-sdlc\/workflow\.md|docs\/ai-sdlc\/index\.md)/u.test(source);
}

async function detectInstalledRoleIds(target, tool, targetIdentity) {
  const profilePath = ".ai-sdlc/project-profile.md";
  const profileStats = lstatIfPresent(path.join(target, profilePath));
  const profile = profileStats
    ? await readSafeProjectFile(target, profilePath, profileStats, targetIdentity)
    : null;
  const currentConfigurationMatch = profile?.match(
    /^\|\s*Local role agents\s*\|\s*(.*?)\s*\|\s*$/imu,
  );
  const legacyConfigurationMatch = profile?.match(
    /^\|\s*Dedicated agents\s*\|\s*(.*?)\s*\|\s*$/imu,
  );
  const configurationMatch = currentConfigurationMatch ?? legacyConfigurationMatch;

  if (configurationMatch) {
    const configured = configurationMatch[1].trim();
    if (!configured) {
      throw new Error("Update stopped. The project profile contains invalid local roles.");
    }
    if (configured.toLowerCase() === "none") return [];
    const selected = configured.split(",").map((value) => value.trim());
    if (selected.some((roleId) => !roleById.has(roleId))) {
      throw new Error("Update stopped. The project profile contains invalid local roles.");
    }
    if (new Set(selected).size !== selected.length) {
      throw new Error("Update stopped. The project profile contains duplicate local roles.");
    }
    return roleIds.filter((roleId) => selected.includes(roleId));
  }

  const detected = [];
  for (const roleId of roleIds) {
    const rolePath = path.join(
      target,
      tool.agentsDirectory,
      tool.roleFileName(roleId),
    );
    const stats = lstatIfPresent(rolePath);
    if (!stats) continue;
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
      throw new Error(`Update stopped. A legacy role path is unsafe: ${roleId}`);
    }
    detected.push(roleId);
  }
  return detected;
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
  const conflicts = findPlannedConflicts(entries);

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

function findPlannedConflicts(entries) {
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

  return conflicts;
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

function readTargetIdentity(target) {
  const before = lstatIfPresent(target);
  if (!before?.isDirectory() || before.isSymbolicLink()) {
    throw new Error("Update stopped. The target must be an existing real directory.");
  }
  const realPath = realpathSync(target);
  const after = lstatIfPresent(target);
  if (
    !after?.isDirectory()
    || after.isSymbolicLink()
    || after.dev !== before.dev
    || after.ino !== before.ino
  ) {
    throw new Error("Update stopped. The target changed while it was being checked.");
  }
  return { device: after.dev, inode: after.ino, realPath };
}

function assertMatchingTargetIdentity(current, expected) {
  if (
    current.device !== expected.device
    || current.inode !== expected.inode
    || current.realPath !== expected.realPath
  ) {
    throw new Error("Update stopped. The target changed during the update.");
  }
}

function assertTargetIdentity(target, expected) {
  const current = readTargetIdentity(target);
  assertMatchingTargetIdentity(current, expected);
}

function existingOpenFlags(writable) {
  const access = writable ? fsConstants.O_RDWR : fsConstants.O_RDONLY;
  return access | (fsConstants.O_NOFOLLOW ?? 0);
}

function createOpenFlags() {
  return fsConstants.O_RDWR
    | fsConstants.O_CREAT
    | fsConstants.O_EXCL
    | (fsConstants.O_NOFOLLOW ?? 0);
}

function assertSafeParents(target, relativePath, targetIdentity) {
  assertTargetIdentity(target, targetIdentity);
  let parent = target;
  for (const segment of relativePath.split("/").slice(0, -1)) {
    parent = path.join(parent, segment);
    const stats = lstatIfPresent(parent);
    if (!stats?.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Unsafe project path: ${relativePath}`);
    }
  }
  assertTargetIdentity(target, targetIdentity);
}

function assertRealPathInside(target, destination, relativePath, targetIdentity) {
  assertTargetIdentity(target, targetIdentity);
  const realDestination = realpathSync(destination);
  const relative = path.relative(targetIdentity.realPath, realDestination);
  if (
    !relative
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error(`Managed path resolves outside the target: ${relativePath}`);
  }
  assertTargetIdentity(target, targetIdentity);
}

function assertRealParentInside(target, destination, relativePath, targetIdentity) {
  assertTargetIdentity(target, targetIdentity);
  const realParent = realpathSync(path.dirname(destination));
  const relative = path.relative(targetIdentity.realPath, realParent);
  if (
    relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error(`Managed parent resolves outside the target: ${relativePath}`);
  }
  assertTargetIdentity(target, targetIdentity);
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

async function updateEntries(target, entries, context, targetIdentity) {
  const plan = await planUpdateEntries(target, entries, targetIdentity);
  const applied = [];
  const createdDirectories = [];

  try {
    for (const [index, change] of plan.changes.entries()) {
      assertTargetIdentity(target, targetIdentity);
      await context.beforeWrite?.({ index, path: change.path, target, command: "update" });
      assertTargetIdentity(target, targetIdentity);
      const destination = path.join(target, change.path);
      await ensureUpdateDirectory(
        target,
        path.dirname(destination),
        targetIdentity,
        createdDirectories,
        context,
      );
      assertTargetIdentity(target, targetIdentity);
      assertRealParentInside(target, destination, change.path, targetIdentity);

      if (change.previous === null) {
        await context.beforeCreateOpen?.({
          path: change.path,
          destination,
          target,
        });
        const handle = await open(destination, createOpenFlags());
        const record = {
          kind: "created",
          path: destination,
          relativePath: change.path,
          device: null,
          inode: null,
          before: null,
          after: change.content,
          restored: false,
        };
        applied.push(record);
        try {
          const stats = await handle.stat();
          if (!stats.isFile() || stats.nlink !== 1) {
            throw new Error(`Unsafe managed file created at: ${change.path}`);
          }
          record.device = stats.dev;
          record.inode = stats.ino;
          assertRealPathInside(target, destination, change.path, targetIdentity);
          if (context.writeCreatedFile) {
            await context.writeCreatedFile({
              handle,
              content: change.content,
              path: change.path,
            });
          } else {
            await handle.writeFile(change.content, "utf8");
          }
        } catch (error) {
          try {
            record.after = await readHandleContent(handle);
          } catch {
            // Keep the file if rollback cannot prove what this command wrote.
          }
          throw error;
        } finally {
          await handle.close();
        }
        continue;
      }

      const handle = await open(destination, existingOpenFlags(true));
      let record;
      try {
        const stats = await handle.stat();
        if (
          !stats.isFile()
          || stats.nlink !== 1
          || stats.dev !== change.device
          || stats.ino !== change.inode
        ) {
          throw new Error(`Update target changed before it could be written: ${change.path}`);
        }
        const current = await handle.readFile("utf8");
        if (current !== change.previous) {
          throw new Error(`Update target changed before it could be written: ${change.path}`);
        }
        assertRealPathInside(target, destination, change.path, targetIdentity);
        const writeStats = await handle.stat();
        if (writeStats.nlink !== 1) {
          throw new Error(`Update target became unsafe before it could be written: ${change.path}`);
        }

        record = {
          kind: "updated",
          path: destination,
          relativePath: change.path,
          device: stats.dev,
          inode: stats.ino,
          before: change.previous,
          after: change.content,
          restored: false,
        };
        applied.push(record);
        try {
          await replaceHandleContent(handle, change.content);
        } catch (error) {
          try {
            await replaceHandleContent(handle, change.previous);
            record.restored = true;
          } catch (restoreError) {
            try {
              record.after = await readHandleContent(handle);
            } catch {
              // Keep the expected content if the partial file cannot be read safely.
            }
            throw new AggregateError(
              [error, restoreError],
              `Update failed while writing ${change.path}, and its previous content could not be restored.`,
            );
          }
          throw error;
        }
      } finally {
        await handle.close();
      }
    }
  } catch (error) {
    const rollbackErrors = await rollbackUpdates(
      target,
      applied,
      targetIdentity,
      context,
    );
    rollbackErrors.push(...await rollbackUpdateDirectories(
      target,
      createdDirectories,
      targetIdentity,
    ));
    if (rollbackErrors.length > 0) {
      const causes = [error, ...rollbackErrors]
        .map((cause) => `- ${cause.message}`)
        .join("\n");
      throw new AggregateError(
        [error, ...rollbackErrors],
        `Update failed, and some files could not be restored safely:\n${causes}`,
      );
    }
    throw error;
  }

  return {
    created: plan.changes.filter(({ previous }) => previous === null).length,
    updated: plan.changes.filter(({ previous }) => previous !== null).length,
    unchanged: plan.unchanged,
  };
}

async function planUpdateEntries(target, entries, targetIdentity) {
  const conflicts = findPlannedConflicts(entries);
  const createOnlyConflicts = [];
  const changes = [];
  let unchanged = 0;

  for (const entry of entries) {
    assertTargetIdentity(target, targetIdentity);
    const content = ensureNewline(entry.content);
    const destination = path.join(target, entry.path);

    let parent = target;
    let unsafeParent = false;
    for (const segment of entry.path.split("/").slice(0, -1)) {
      parent = path.join(parent, segment);
      const parentStats = lstatIfPresent(parent);
      if (!parentStats) continue;
      if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
        conflicts.add(`${path.relative(target, parent).split(path.sep).join("/")}/`);
        unsafeParent = true;
        break;
      }
    }
    if (unsafeParent) continue;

    const stats = lstatIfPresent(destination);
    if (!stats) {
      changes.push({ path: entry.path, content, previous: null });
      continue;
    }
    if (entry.createOnly) {
      createOnlyConflicts.push(entry.path);
      continue;
    }
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
      conflicts.add(entry.path);
      continue;
    }

    const previous = await readUpdateSnapshot(
      target,
      stats,
      entry.path,
      targetIdentity,
    );
    if (previous === content) {
      unchanged += 1;
      continue;
    }
    changes.push({
      path: entry.path,
      content,
      previous,
      device: stats.dev,
      inode: stats.ino,
    });
  }

  if (conflicts.size > 0 || createOnlyConflicts.length > 0) {
    const sections = [];
    if (conflicts.size > 0) {
      sections.push(
        `These managed paths are unsafe:\n${[...conflicts]
          .sort()
          .map((item) => `- ${item}`)
          .join("\n")}`,
      );
    }
    if (createOnlyConflicts.length > 0) {
      sections.push(
        `These legacy configuration paths appeared during the update:\n${createOnlyConflicts
          .sort()
          .map((item) => `- ${item}`)
          .join("\n")}`,
      );
    }
    throw new Error(
      `Update stopped. ${sections.join("\n")}`,
    );
  }
  assertTargetIdentity(target, targetIdentity);
  return { changes, unchanged };
}

async function readUpdateSnapshot(target, expectedStats, entryPath, targetIdentity) {
  return readSafeProjectFile(target, entryPath, expectedStats, targetIdentity);
}

async function replaceHandleContent(handle, content) {
  const buffer = Buffer.from(content, "utf8");
  await handle.truncate(0);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(
      buffer,
      offset,
      buffer.length - offset,
      offset,
    );
    if (bytesWritten === 0) throw new Error("A file write made no progress.");
    offset += bytesWritten;
  }
}

async function readHandleContent(handle) {
  const { size } = await handle.stat();
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset).toString("utf8");
}

async function rollbackUpdates(target, applied, targetIdentity, context) {
  const errors = [];

  for (const record of [...applied].reverse()) {
    if (record.restored) continue;
    try {
      assertTargetIdentity(target, targetIdentity);
      if (record.kind === "created") {
        await context.beforeCreatedRollbackClaim?.({
          path: record.path,
          relativePath: record.relativePath,
          target,
        });
        await removeCreatedUpdate(target, record, targetIdentity);
        continue;
      }

      const stats = lstatIfPresent(record.path);
      if (!stats) {
        throw new Error(`An updated file disappeared during rollback: ${record.path}`);
      }
      if (
        record.device === null
        || record.inode === null
        || stats.nlink !== 1
        || stats.dev !== record.device
        || stats.ino !== record.inode
      ) {
        throw new Error(`An updated file was replaced during rollback and was kept: ${record.path}`);
      }
      const current = await readSafeProjectFile(
        target,
        record.relativePath,
        stats,
        targetIdentity,
      );
      if (current !== record.after) {
        throw new Error(`An updated file changed during rollback and was kept: ${record.path}`);
      }

      assertRealParentInside(
        target,
        record.path,
        record.relativePath,
        targetIdentity,
      );
      const handle = await open(record.path, existingOpenFlags(true));
      try {
        const currentStats = await handle.stat();
        if (
          currentStats.nlink !== 1
          || !currentStats.isFile()
          || currentStats.dev !== record.device
          || currentStats.ino !== record.inode
        ) {
          throw new Error(`An updated file was replaced during rollback and was kept: ${record.path}`);
        }
        assertRealPathInside(
          target,
          record.path,
          record.relativePath,
          targetIdentity,
        );
        const openContent = await handle.readFile("utf8");
        if (openContent !== record.after) {
          throw new Error(`An updated file changed during rollback and was kept: ${record.path}`);
        }
        if ((await handle.stat()).nlink !== 1) {
          throw new Error(`An updated file became unsafe during rollback and was kept: ${record.path}`);
        }
        await replaceHandleContent(handle, record.before);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error?.code !== "ENOENT") errors.push(error);
    }
  }

  return errors;
}

async function removeCreatedUpdate(target, record, targetIdentity) {
  assertTargetIdentity(target, targetIdentity);
  const quarantine = path.join(
    path.dirname(record.path),
    `.${path.basename(record.path)}.ai-sdlc-rollback-${randomUUID()}`,
  );
  await rename(record.path, quarantine);

  try {
    const quarantineStats = lstatIfPresent(quarantine);
    if (
      !quarantineStats
      || !quarantineStats.isFile()
      || quarantineStats.isSymbolicLink()
      || quarantineStats.nlink !== 1
      || quarantineStats.dev !== record.device
      || quarantineStats.ino !== record.inode
    ) {
      throw new Error(`An updated file was replaced during rollback and was kept: ${record.path}`);
    }

    const content = await readClaimedRollbackContent(quarantine, quarantineStats);
    if (content !== record.after) {
      throw new Error(`An updated file changed during rollback and was kept: ${record.path}`);
    }

    await unlink(quarantine);
  } catch (error) {
    try {
      if (!lstatIfPresent(quarantine)) {
        throw new Error(`The claimed rollback file disappeared: ${quarantine}`);
      }
      await restoreClaimedRollbackPath(quarantine, record.path);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        `${error.message} Its original path could not be restored safely.`,
      );
    }
    throw error;
  }
}

async function readClaimedRollbackContent(file, expectedStats) {
  const handle = await open(file, existingOpenFlags(false));
  try {
    const stats = await handle.stat();
    if (
      !stats.isFile()
      || stats.nlink !== 1
      || stats.dev !== expectedStats.dev
      || stats.ino !== expectedStats.ino
    ) {
      throw new Error(`A claimed rollback file changed before it could be checked: ${file}`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function restoreClaimedRollbackPath(quarantine, destination) {
  try {
    await link(quarantine, destination);
    await unlink(quarantine);
  } catch (error) {
    throw new Error(
      `A concurrently replaced file was preserved at ${quarantine} because its original path could not be restored: ${error.message}`,
    );
  }
}

async function ensureUpdateDirectory(
  target,
  directory,
  targetIdentity,
  createdDirectories,
  context,
) {
  const relative = path.relative(target, directory);
  if (
    relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error(`Output directory is outside the target: ${directory}`);
  }
  if (!relative) return;

  let current = target;
  for (const segment of relative.split(path.sep)) {
    assertTargetIdentity(target, targetIdentity);
    current = path.join(current, segment);
    const stats = lstatIfPresent(current);
    const relativePath = path.relative(target, current).split(path.sep).join("/");
    if (stats) {
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error(`Output parent is not a real directory: ${relativePath}`);
      }
      assertRealPathInside(target, current, relativePath, targetIdentity);
      continue;
    }

    await context.beforeDirectoryCreate?.({
      path: relativePath,
      destination: current,
      target,
    });
    assertTargetIdentity(target, targetIdentity);
    await mkdir(current);
    const createdStats = lstatIfPresent(current);
    if (!createdStats?.isDirectory() || createdStats.isSymbolicLink()) {
      throw new Error(`A created output parent is unsafe: ${relativePath}`);
    }
    createdDirectories.push({
      path: current,
      relativePath,
      device: createdStats.dev,
      inode: createdStats.ino,
    });
    assertRealPathInside(target, current, relativePath, targetIdentity);
  }
}

async function rollbackUpdateDirectories(target, createdDirectories, targetIdentity) {
  const errors = [];

  for (const record of [...createdDirectories].reverse()) {
    try {
      assertTargetIdentity(target, targetIdentity);
      await removeCreatedUpdateDirectory(record);
    } catch (error) {
      if (error?.code !== "ENOENT") errors.push(error);
    }
  }

  return errors;
}

async function removeCreatedUpdateDirectory(record) {
  const quarantine = path.join(
    path.dirname(record.path),
    `.${path.basename(record.path)}.ai-sdlc-rollback-${randomUUID()}`,
  );
  await rename(record.path, quarantine);

  try {
    const stats = lstatIfPresent(quarantine);
    if (
      !stats
      || !stats.isDirectory()
      || stats.isSymbolicLink()
      || stats.dev !== record.device
      || stats.ino !== record.inode
    ) {
      throw new Error(`A created directory was replaced during rollback and was kept: ${record.path}`);
    }
    if ((await readdir(quarantine)).length > 0) {
      throw new Error(`A created directory changed during rollback and was kept: ${record.path}`);
    }
    await rmdir(quarantine);
  } catch (error) {
    try {
      if (!lstatIfPresent(quarantine)) {
        throw new Error(`The claimed rollback directory disappeared: ${quarantine}`);
      }
      if (lstatIfPresent(record.path)) {
        throw new Error(`The original directory path is no longer available: ${record.path}`);
      }
      await rename(quarantine, record.path);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        `${error.message} Its original path could not be restored safely.`,
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
    return { help: true, command: null, target: "." };
  }

  const values = [...args];
  const command = values.shift();
  if (command !== "init" && command !== "update") {
    throw new Error(
      "Use: create-ai-native-sdlc init [target] or create-ai-native-sdlc update [target]",
    );
  }

  const options = {
    command,
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
      if (command !== "init") throw new Error("--name is only available with init.");
      options.name = optionValue(values, ++index, "--name");
    } else if (value === "--summary") {
      if (command !== "init") throw new Error("--summary is only available with init.");
      options.summary = optionValue(values, ++index, "--summary");
    } else if (value === "--tool") {
      const rawTool = optionValue(values, ++index, value);
      options.tool = normalizeTool(rawTool);
      if (!options.tool) throw new Error(`Unknown AI tool: ${rawTool}`);
    } else if (value === "--roles") {
      if (command !== "init") throw new Error("--roles is only available with init.");
      options.roles = parseRoles(optionValue(values, ++index, value));
    } else if (value === "--development") {
      if (command !== "init") throw new Error("--development is not available with update.");
      throw new Error("--development was removed. Select independent local agents with --roles.");
    } else if (value === "--stack" || value === "--validation") {
      if (command !== "init") throw new Error(`${value} is not available with update.`);
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
  create-ai-native-sdlc update [target] [--tool <tool>]

Commands:
  init                         Add the workflow without overwriting files
  update                       Refresh managed SDLC files and preserve project data

Init options:
  --name <name>               Project name
  --summary <text>            Short project summary
  --tool <tool>               copilot, claude, or codex
  --roles <list>              Comma-separated role IDs, all, or none

Update options:
  --tool <tool>               Resolve multiple detected legacy AI tools

General:
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
