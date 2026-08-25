#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateRoot = path.join(packageRoot, "templates");
const transactionMarkerName = ".ai-native-sdlc-init-transaction.json";
const transactionFormat = "create-ai-native-sdlc/init-transaction";
const transactionVersion = 1;

const clients = {
  copilot: {
    id: "github-copilot",
    label: "GitHub Copilot",
    directory: ".github/agents",
    fileName: (roleId) => `${roleId}.agent.md`,
    render: renderMarkdownAgent
  },
  claude: {
    id: "claude-code",
    label: "Claude Code",
    directory: ".claude/agents",
    fileName: (roleId) => `${roleId}.md`,
    render: renderMarkdownAgent
  },
  codex: {
    id: "codex",
    label: "Codex",
    directory: ".codex/agents",
    fileName: (roleId) => `${roleId}.toml`,
    render: renderCodexAgent
  }
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
  const signal = context.signal;
  signal?.throwIfAborted();
  if (await recoverInterruptedInitialization(target, signal)) {
    output("检测到未完成的初始化事务；已验证并清理其遗留项。\n");
  }
  signal?.throwIfAborted();
  if (lstatIfPresent(path.join(target, "ai-native.yaml"))) {
    throw new Error("目标项目已经存在 ai-native.yaml，初始化已取消");
  }

  let terminal;
  let prompt = context.prompt;
  if (!prompt) {
    terminal = createInterface({ input: stdin, output: stdout });
    prompt = (question) => terminal.question(question);
  }

  const createdFiles = [];
  const createdDirectories = [];
  try {
    const defaultName = path.basename(target);
    const projectName = (await ask(prompt, `项目名称（默认 ${defaultName}）：`, signal)) || defaultName;
    const projectSummary = await askRequired(prompt, output, "项目简介：", signal);
    const clientId = options.client ?? await askForClient(prompt, output, signal);
    const client = clients[clientId];
    const designerInputs = await askForDesignerInputs(prompt, output, signal);
    const componentCatalogModule = await askForComponentCatalog(prompt, output, signal);
    const entries = await buildEntries(
      projectName,
      projectSummary,
      client,
      designerInputs,
      componentCatalogModule,
      signal
    );

    signal?.throwIfAborted();
    const conflicts = findConflicts(target, entries);
    if (conflicts.length) {
      throw new Error(`目标路径存在冲突，未写入任何文件：\n${conflicts.map((item) => `- ${item}`).join("\n")}`);
    }

    const preparedEntries = entries.map((entry) => {
      const content = ensureNewline(entry.content);
      return { ...entry, content, sha256: hashContent(content) };
    });
    for (const entry of preparedEntries) {
      await ensureDirectory(target, path.dirname(path.join(target, entry.path)), createdDirectories, signal);
    }
    const transaction = await createInitializationTransaction(
      target,
      preparedEntries,
      createdFiles,
      createdDirectories,
      signal,
    );

    for (const entry of transaction.entries) {
      signal?.throwIfAborted();
      const destination = path.join(target, entry.path);
      await ensureDirectory(target, path.dirname(destination), createdDirectories, signal);
      signal?.throwIfAborted();
      await link(entry.staged.path, destination);
      const published = await lstat(destination, { bigint: true });
      if (!published.isFile() || !sameIdentity(published, entry.staged)) {
        throw new Error(`初始化输出发布后身份校验失败：${entry.path}`);
      }
      createdFiles.push({
        path: destination,
        dev: published.dev,
        ino: published.ino,
        sha256: entry.sha256,
      });
    }

    signal?.throwIfAborted();
    await commitInitializationTransaction(transaction, signal);
    output(`\n初始化完成：${projectName}\n`);
    output(`AI 客户端：${client.label}\n`);
    output(`Agent 目录：${client.directory}\n`);
    output(`写入 ${entries.length} 个文件。\n`);
    if (!componentCatalogModule) {
      output("Designer 组件查询尚未配置，可编辑 .ai-sdlc/roles/designer/scripts/component-query.mjs。\n");
    }
    return 0;
  } catch (error) {
    try {
      await rollbackCreatedEntries(createdFiles, createdDirectories);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `初始化失败，且无法完整回滚本次创建的文件：${rollbackError.message}`,
      );
    }
    throw error;
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

async function ask(prompt, question, signal) {
  signal?.throwIfAborted();
  const answer = await waitForAbort(Promise.resolve().then(() => prompt(question)), signal);
  signal?.throwIfAborted();
  return String(answer ?? "").trim();
}

async function askRequired(prompt, output, question, signal) {
  while (true) {
    const answer = await ask(prompt, question, signal);
    if (answer) return answer;
    signal?.throwIfAborted();
    output("此项不能为空。\n");
  }
}

async function askForClient(prompt, output, signal) {
  const question = [
    "选择 AI 客户端：",
    "  1. GitHub Copilot",
    "  2. Claude Code",
    "  3. Codex",
    "请输入 1、2 或 3："
  ].join("\n");

  while (true) {
    const answer = (await ask(prompt, question, signal)).toLowerCase();
    const aliases = {
      "1": "copilot",
      copilot: "copilot",
      "github copilot": "copilot",
      "github-copilot": "copilot",
      "2": "claude",
      claude: "claude",
      "claude code": "claude",
      "claude-code": "claude",
      "3": "codex",
      codex: "codex"
    };
    if (aliases[answer]) return aliases[answer];
    signal?.throwIfAborted();
    output("请选择 1、2 或 3。\n");
  }
}

async function askForDesignerInputs(prompt, output, signal) {
  while (true) {
    const answer = await ask(
      prompt,
      "Designer 额外输入 Markdown（项目相对路径，多个用逗号分隔，可留空）：",
      signal
    );
    if (!answer) return [];
    const values = answer.split(/[,，]/u).map((value) => value.trim()).filter(Boolean);
    if (values.length && values.every((value) => isSafeProjectFile(value, ".md"))) return values;
    signal?.throwIfAborted();
    output("请输入项目内的 .md 相对路径，不能包含 .. 或反斜杠。\n");
  }
}

async function askForComponentCatalog(prompt, output, signal) {
  while (true) {
    const answer = await ask(
      prompt,
      "Designer 组件清单模块（项目相对 .mjs 路径，可留空）：",
      signal
    );
    if (!answer || isSafeProjectFile(answer, ".mjs")) return answer || null;
    signal?.throwIfAborted();
    output("请输入项目内的 .mjs 相对路径，不能包含 .. 或反斜杠。\n");
  }
}

async function buildEntries(
  projectName,
  projectSummary,
  client,
  designerInputs,
  componentCatalogModule,
  signal
) {
  const rolePaths = Object.fromEntries(
    ["pm-ba", "designer", "architect", "software-engineer", "tester", "devops"]
      .map((roleId) => [roleId, `${client.directory}/${client.fileName(roleId)}`])
  );
  signal?.throwIfAborted();
  const configTemplate = await readFile(path.join(templateRoot, "ai-native.yaml"), {
    encoding: "utf8",
    signal,
  });
  const config = configTemplate
    .replaceAll("{{PROJECT_NAME}}", JSON.stringify(projectName))
    .replaceAll("{{PROJECT_SUMMARY}}", JSON.stringify(projectSummary))
    .replaceAll("{{AI_CLIENT}}", JSON.stringify(client.id))
    .replaceAll("{{AGENTS_DIRECTORY}}", JSON.stringify(client.directory));

  const designerInputConfig = designerInputs.length
    ? `  markdown:\n${designerInputs.map((input) => `    - ${JSON.stringify(input)}`).join("\n")}`
    : "  markdown: []";
  const sharedRoot = path.join(templateRoot, "shared");
  const sharedEntries = await readTemplateDirectory(sharedRoot, sharedRoot, signal);
  for (const entry of sharedEntries) {
    entry.content = entry.content
      .replaceAll("{{PM_BA_ROLE_PATH}}", JSON.stringify(rolePaths["pm-ba"]))
      .replaceAll("{{ARCHITECT_ROLE_PATH}}", JSON.stringify(rolePaths.architect))
      .replaceAll("{{SOFTWARE_ENGINEER_ROLE_PATH}}", JSON.stringify(rolePaths["software-engineer"]))
      .replaceAll("{{DESIGNER_INPUTS}}", designerInputConfig)
      .replaceAll("{{DESIGNER_ROLE_PATH}}", JSON.stringify(rolePaths.designer))
      .replaceAll(
        JSON.stringify("__AI_SDLC_COMPONENT_CATALOG_MODULE__"),
        JSON.stringify(componentCatalogModule)
      );
  }

  const agentRoot = path.join(templateRoot, "agents");
  const agentEntries = await readTemplateDirectory(agentRoot, agentRoot, signal);
  for (const entry of agentEntries) {
    const roleId = path.basename(entry.path, ".md");
    entry.path = rolePaths[roleId];
    entry.content = client.render(roleId, entry.content);
  }

  return [{ path: "ai-native.yaml", content: config }, ...sharedEntries, ...agentEntries];
}

function isSafeProjectFile(value, extension) {
  if (!value.toLowerCase().endsWith(extension) || path.isAbsolute(value) || value.includes("\\")) {
    return false;
  }
  return !value.split("/").some((segment) => !segment || segment === "." || segment === "..");
}

function renderMarkdownAgent(roleId, source) {
  const description = readAgentDescription(source);
  return [
    "---",
    `name: ${JSON.stringify(roleId)}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    source.trim()
  ].join("\n");
}

function renderCodexAgent(roleId, source) {
  return [
    `name = ${JSON.stringify(roleId)}`,
    `description = ${JSON.stringify(readAgentDescription(source))}`,
    `developer_instructions = ${JSON.stringify(source.trim())}`
  ].join("\n");
}

function readAgentDescription(source) {
  const withoutHeading = source.replace(/^#\s+[^\n]+\n+/u, "");
  const description = withoutHeading.split(/\n\s*\n/u, 1)[0]?.trim();
  if (!description) throw new Error("Agent 模板缺少标题后的角色描述");
  return description;
}

async function readTemplateDirectory(directory, current = directory, signal) {
  signal?.throwIfAborted();
  const entries = [];
  const directoryEntries = await readdir(current, { withFileTypes: true });
  directoryEntries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

  for (const entry of directoryEntries) {
    signal?.throwIfAborted();
    const source = path.join(current, entry.name);
    if (entry.isDirectory()) {
      entries.push(...await readTemplateDirectory(directory, source, signal));
    } else if (entry.isFile()) {
      entries.push({
        path: path.relative(directory, source).split(path.sep).join("/"),
        content: await readFile(source, { encoding: "utf8", signal })
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
  let target = ".";
  let targetSeen = false;
  let client;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--client") {
      if (client) throw new Error("--client 不能重复");
      const requested = args[index + 1];
      if (!requested || !clients[requested]) {
        throw new Error("--client 仅支持 copilot、claude 或 codex");
      }
      client = requested;
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) throw new Error(`未知选项：${argument}`);
    if (targetSeen) throw new Error("用法：create-ai-native-sdlc init [target] [--client <client>]");
    target = argument;
    targetSeen = true;
  }
  return { target, client, help: false };
}

async function createInitializationTransaction(
  target,
  entries,
  createdFiles,
  createdDirectories,
  signal,
) {
  const transactionId = randomUUID();
  const stagingName = transactionStagingName(transactionId);
  const stagingPath = path.join(target, stagingName);
  const liveDirectories = createdDirectories.filter((directory) => isWithinTarget(target, directory.path));

  signal?.throwIfAborted();
  await mkdir(stagingPath, { mode: 0o700 });
  const staging = await rememberCreatedDirectory(stagingPath, createdDirectories);

  const stagedEntries = [];
  for (const [index, entry] of entries.entries()) {
    const stagedPath = path.join(stagingPath, transactionPayloadName(index));
    const staged = await createTrackedFile(
      stagedPath,
      entry.content,
      createdFiles,
      signal,
      { mode: 0o666, sync: true },
    );
    stagedEntries.push({ ...entry, staged });
  }

  const journal = {
    format: transactionFormat,
    version: transactionVersion,
    transactionId,
    ownerPid: process.pid,
    entries: stagedEntries.map((entry) => ({
      path: entry.path,
      sha256: entry.sha256,
      dev: entry.staged.dev.toString(),
      ino: entry.staged.ino.toString(),
    })),
    directories: liveDirectories.map((directory) => ({
      path: projectRelativePath(target, directory.path),
      dev: directory.dev.toString(),
      ino: directory.ino.toString(),
    })),
    staging: {
      path: stagingName,
      dev: staging.dev.toString(),
      ino: staging.ino.toString(),
    },
  };
  const markerContent = `${JSON.stringify(journal, null, 2)}\n`;
  const temporaryMarker = await createTrackedFile(
    path.join(target, transactionMarkerTemporaryName(transactionId)),
    markerContent,
    createdFiles,
    signal,
    { mode: 0o600, sync: true },
  );
  const marker = {
    path: path.join(target, transactionMarkerName),
    dev: temporaryMarker.dev,
    ino: temporaryMarker.ino,
    sha256: temporaryMarker.sha256,
  };
  await link(temporaryMarker.path, marker.path);
  createdFiles.push(marker);
  const publishedMarker = await lstat(marker.path, { bigint: true });
  if (!publishedMarker.isFile() || !sameIdentity(publishedMarker, marker)) {
    throw new Error("初始化事务 marker 发布后身份校验失败");
  }
  await unlinkRecordedFile(temporaryMarker);

  return {
    entries: stagedEntries,
    marker,
    staging,
  };
}

async function commitInitializationTransaction(transaction, signal) {
  for (const entry of [...transaction.entries].reverse()) {
    signal?.throwIfAborted();
    await unlinkRecordedFile(entry.staged);
  }
  signal?.throwIfAborted();
  await rmdirRecordedDirectory(transaction.staging, { tolerateNonEmpty: false });
  // The marker unlink is the transaction commit point. A signal observed
  // before this call rolls back; a signal delivered after it starts loses the
  // race to a completed commit and the direct CLI reports success.
  signal?.throwIfAborted();
  await unlinkRecordedFile(transaction.marker, { allowMissing: false });
}

async function recoverInterruptedInitialization(target, signal) {
  const targetStats = lstatIfPresent(target);
  if (!targetStats) return false;
  if (!targetStats.isDirectory() || targetStats.isSymbolicLink()) {
    throw new Error(`初始化目标不是普通目录：${target}`);
  }

  const markerPath = path.join(target, transactionMarkerName);
  const markerStats = lstatIfPresent(markerPath);
  if (!markerStats) {
    const unjournaled = (await readdir(target)).filter(isInitializerTransactionRemainder);
    if (unjournaled.length > 0) {
      throw recoveryRefusal(
        `发现没有可验证事务 marker 的初始化遗留项，已原样保留供人工检查：${unjournaled.join(", ")}`,
      );
    }
    return false;
  }
  if (!markerStats.isFile() || markerStats.isSymbolicLink()) {
    throw recoveryRefusal(`事务 marker 不是普通文件：${markerPath}`);
  }

  signal?.throwIfAborted();
  const marker = await inspectStableRegularFile(markerPath, { maximumBytes: 4 * 1024 * 1024 });
  if (!marker) throw recoveryRefusal("事务 marker 在读取期间消失");
  const journal = parseTransactionJournal(marker.content);
  if (isProcessAlive(journal.ownerPid)) {
    throw recoveryRefusal(`事务仍由活动进程 ${journal.ownerPid} 持有`);
  }
  const expectedMarker = { ...marker, sha256: hashContent(marker.content) };
  const stagingPath = path.join(target, journal.staging.path);
  const temporaryMarkerPath = path.join(
    target,
    transactionMarkerTemporaryName(journal.transactionId),
  );

  const directoryChecks = [];
  for (const directory of journal.directories) {
    const directoryPath = directory.path === "." ? target : path.join(target, directory.path);
    const current = await inspectExpectedDirectory(directoryPath, directory);
    if (current) directoryChecks.push({ ...directory, path: directoryPath });
  }
  const stagingDirectory = await inspectExpectedDirectory(stagingPath, journal.staging);
  if (stagingDirectory) {
    const allowedNames = new Set(journal.entries.map((_, index) => transactionPayloadName(index)));
    const unexpected = (await readdir(stagingPath)).filter((name) => !allowedNames.has(name));
    if (unexpected.length > 0) {
      throw recoveryRefusal(`staging 目录包含未知条目：${unexpected.join(", ")}`);
    }
  }

  const temporaryMarker = await inspectExpectedFile(
    temporaryMarkerPath,
    expectedMarker,
    expectedMarker.sha256,
  );
  const stagedFiles = [];
  const liveFiles = [];
  for (const [index, entry] of journal.entries.entries()) {
    signal?.throwIfAborted();
    const stagedPath = path.join(stagingPath, transactionPayloadName(index));
    const staged = await inspectExpectedFile(stagedPath, entry, entry.sha256);
    if (staged) stagedFiles.push({ path: stagedPath, expected: entry });

    await assertSafeProjectParentChain(target, entry.path);
    const destination = path.join(target, entry.path);
    const live = await inspectExpectedFile(destination, entry, entry.sha256);
    if (live) liveFiles.push({ path: destination, expected: entry });
  }

  signal?.throwIfAborted();
  for (const file of [...liveFiles].reverse()) {
    await removeExpectedFile(file.path, file.expected, file.expected.sha256, signal);
  }
  for (const file of [...stagedFiles].reverse()) {
    await removeExpectedFile(file.path, file.expected, file.expected.sha256, signal);
  }
  if (stagingDirectory) {
    await removeExpectedDirectory(stagingPath, journal.staging, { tolerateNonEmpty: false });
  }
  for (const directory of directoryChecks
    .filter((entry) => entry.path !== target)
    .sort((left, right) => right.path.length - left.path.length)) {
    await removeExpectedDirectory(directory.path, directory, { tolerateNonEmpty: true });
  }
  if (temporaryMarker) {
    await removeExpectedFile(
      temporaryMarkerPath,
      expectedMarker,
      expectedMarker.sha256,
      signal,
    );
  }
  await removeExpectedFile(markerPath, expectedMarker, expectedMarker.sha256, signal, {
    allowMissing: false,
  });

  const targetDirectory = directoryChecks.find((entry) => entry.path === target);
  if (targetDirectory) {
    await removeExpectedDirectory(target, targetDirectory, { tolerateNonEmpty: true });
  }
  return true;
}

function parseTransactionJournal(content) {
  let value;
  try {
    value = JSON.parse(content.toString("utf8"));
  } catch {
    throw recoveryRefusal("事务 marker 不是有效 JSON");
  }
  if (!isPlainObject(value)
    || value.format !== transactionFormat
    || value.version !== transactionVersion
    || !isTransactionId(value.transactionId)
    || !Array.isArray(value.entries)
    || value.entries.length === 0
    || value.entries.length > 10_000
    || !Array.isArray(value.directories)
    || !isPlainObject(value.staging)) {
    throw recoveryRefusal("事务 marker 结构或版本无效");
  }
  assertExactKeys(value, [
    "format",
    "version",
    "transactionId",
    "ownerPid",
    "entries",
    "directories",
    "staging"
  ]);
  if (!Number.isSafeInteger(value.ownerPid) || value.ownerPid <= 0) {
    throw recoveryRefusal("事务 owner PID 无效");
  }

  const stagingName = transactionStagingName(value.transactionId);
  const staging = parseJournalIdentity(value.staging, "staging 目录");
  if (staging.path !== stagingName) throw recoveryRefusal("staging 目录名与事务 ID 不匹配");

  const entries = value.entries.map((entry, index) => {
    assertExactKeys(entry, ["path", "sha256", "dev", "ino"]);
    if (!isInitializerOutputPath(entry.path)) {
      throw recoveryRefusal(`输出路径不属于初始化器：${String(entry.path)}`);
    }
    if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.sha256)) {
      throw recoveryRefusal(`输出哈希无效：${entry.path}`);
    }
    return { ...parseJournalIdentity(entry, `输出 ${index}`), sha256: entry.sha256 };
  });
  if (!entries.some((entry) => entry.path === "ai-native.yaml")) {
    throw recoveryRefusal("事务 marker 缺少 ai-native.yaml");
  }
  if (findPlannedConflicts(entries).size > 0) {
    throw recoveryRefusal("事务 marker 包含重复或相互覆盖的输出路径");
  }

  const allowedDirectories = plannedParentDirectories(entries.map((entry) => entry.path));
  const directoryKeys = new Set();
  const directories = value.directories.map((directory, index) => {
    const parsed = parseJournalIdentity(directory, `目录 ${index}`);
    if (parsed.path !== "." && !isSafeRelativePath(parsed.path)) {
      throw recoveryRefusal(`目录路径无效：${parsed.path}`);
    }
    if (!allowedDirectories.has(parsed.path)) {
      throw recoveryRefusal(`目录不属于预期输出路径：${parsed.path}`);
    }
    const key = comparablePath(parsed.path);
    if (directoryKeys.has(key)) throw recoveryRefusal(`目录路径重复：${parsed.path}`);
    directoryKeys.add(key);
    return parsed;
  });

  return {
    transactionId: value.transactionId,
    ownerPid: value.ownerPid,
    entries,
    directories,
    staging,
  };
}

function parseJournalIdentity(value, label) {
  if (!isPlainObject(value)) throw recoveryRefusal(`${label} 不是对象`);
  assertExactKeys(value, ["path", "dev", "ino"], ["sha256"]);
  if (typeof value.path !== "string"
    || typeof value.dev !== "string"
    || !/^\d+$/u.test(value.dev)
    || typeof value.ino !== "string"
    || !/^\d+$/u.test(value.ino)) {
    throw recoveryRefusal(`${label} 的路径或 inode 身份无效`);
  }
  return { path: value.path, dev: BigInt(value.dev), ino: BigInt(value.ino) };
}

function assertExactKeys(value, required, optional = []) {
  if (!isPlainObject(value)) throw recoveryRefusal("事务 marker 字段不是对象");
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !allowed.has(key))) {
    throw recoveryRefusal("事务 marker 含有缺失或未知字段");
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTransactionId(value) {
  return typeof value === "string"
    && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

function isInitializerOutputPath(value) {
  return isSafeRelativePath(value) && (
    value === "ai-native.yaml"
    || value.startsWith(".ai-sdlc/")
    || value.startsWith(".github/agents/")
    || value.startsWith(".claude/agents/")
    || value.startsWith(".codex/agents/")
  );
}

function isSafeRelativePath(value) {
  if (typeof value !== "string" || !value || path.isAbsolute(value) || value.includes("\\")) {
    return false;
  }
  return !value.split("/").some((segment) => !segment || segment === "." || segment === "..");
}

function plannedParentDirectories(paths) {
  const directories = new Set(["."]);
  for (const value of paths) {
    const segments = value.split("/").slice(0, -1);
    for (let length = 1; length <= segments.length; length += 1) {
      directories.add(segments.slice(0, length).join("/"));
    }
  }
  return directories;
}

function transactionStagingName(transactionId) {
  return `.ai-native-sdlc-init-${transactionId}.staging`;
}

function transactionMarkerTemporaryName(transactionId) {
  return `.ai-native-sdlc-init-${transactionId}.journal.tmp`;
}

function isInitializerTransactionRemainder(name) {
  return /^\.ai-native-sdlc-init-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:staging|journal\.tmp)$/iu.test(name);
}

function transactionPayloadName(index) {
  return `${String(index).padStart(6, "0")}.payload`;
}

function projectRelativePath(target, value) {
  const relative = path.relative(target, value);
  return relative ? relative.split(path.sep).join("/") : ".";
}

function isWithinTarget(target, value) {
  const relative = path.relative(target, value);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function hashContent(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sameIdentity(stats, expected) {
  return stats.dev === expected.dev && stats.ino === expected.ino;
}

function sameFileSnapshot(left, right) {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function recoveryRefusal(message) {
  return new Error(`未完成初始化事务恢复已拒绝：${message}`);
}

async function inspectStableRegularFile(filePath, options = {}) {
  let before;
  try {
    before = await lstat(filePath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw recoveryRefusal(`遗留路径不是普通文件：${filePath}`);
  }
  if (options.maximumBytes !== undefined && before.size > BigInt(options.maximumBytes)) {
    throw recoveryRefusal(`事务 marker 超过大小限制：${filePath}`);
  }

  let handle;
  try {
    handle = await open(filePath, "r");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameIdentity(opened, before)) {
      throw recoveryRefusal(`遗留文件在打开前被替换：${filePath}`);
    }
    const content = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameFileSnapshot(opened, after)) {
      throw recoveryRefusal(`遗留文件在读取期间被修改：${filePath}`);
    }
    return { path: filePath, content, dev: after.dev, ino: after.ino };
  } finally {
    await handle.close();
  }
}

async function inspectExpectedFile(filePath, expected, expectedHash) {
  const current = await inspectStableRegularFile(filePath);
  if (!current) return null;
  if (!sameIdentity(current, expected)) {
    throw recoveryRefusal(`遗留文件 inode 不匹配，已保留：${filePath}`);
  }
  if (hashContent(current.content) !== expectedHash) {
    throw recoveryRefusal(`遗留文件内容已修改，已保留：${filePath}`);
  }
  return current;
}

async function removeExpectedFile(filePath, expected, expectedHash, signal, options = {}) {
  signal?.throwIfAborted();
  const current = await inspectExpectedFile(filePath, expected, expectedHash);
  if (!current) {
    if (options.allowMissing === false) throw recoveryRefusal(`必须存在的遗留文件已消失：${filePath}`);
    return false;
  }
  await unlink(filePath);
  return true;
}

async function inspectExpectedDirectory(directoryPath, expected) {
  let current;
  try {
    current = await lstat(directoryPath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!current.isDirectory() || current.isSymbolicLink()) {
    throw recoveryRefusal(`遗留目录类型不安全，已保留：${directoryPath}`);
  }
  if (!sameIdentity(current, expected)) {
    throw recoveryRefusal(`遗留目录 inode 不匹配，已保留：${directoryPath}`);
  }
  return current;
}

async function removeExpectedDirectory(directoryPath, expected, options = {}) {
  const current = await inspectExpectedDirectory(directoryPath, expected);
  if (!current) return false;
  try {
    await rmdir(directoryPath);
    return true;
  } catch (error) {
    if (options.tolerateNonEmpty && ["ENOTEMPTY", "EEXIST"].includes(error?.code)) return false;
    throw error;
  }
}

async function assertSafeProjectParentChain(target, relativePath) {
  let cursor = target;
  for (const segment of relativePath.split("/").slice(0, -1)) {
    cursor = path.join(cursor, segment);
    const stats = lstatIfPresent(cursor);
    if (!stats) return;
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw recoveryRefusal(`输出父目录链不安全：${cursor}`);
    }
  }
}

async function createTrackedFile(filePath, content, createdFiles, signal, options = {}) {
  signal?.throwIfAborted();
  const handle = await open(filePath, "wx", options.mode ?? 0o666);
  try {
    const stats = await handle.stat({ bigint: true });
    const record = { path: filePath, dev: stats.dev, ino: stats.ino };
    createdFiles.push(record);
    await writeFile(handle, content, { encoding: "utf8", signal });
    if (options.sync) await handle.sync();
    record.sha256 = hashContent(content);
    return record;
  } finally {
    await handle.close();
  }
}

async function rememberCreatedDirectory(directoryPath, createdDirectories) {
  const stats = await lstat(directoryPath, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`新建目录身份校验失败：${directoryPath}`);
  }
  const record = { path: directoryPath, dev: stats.dev, ino: stats.ino };
  createdDirectories.push(record);
  return record;
}

async function unlinkRecordedFile(record, options = {}) {
  let current;
  if (record.sha256) {
    current = await inspectStableRegularFile(record.path);
    if (!current && options.allowMissing !== false) return false;
    if (!current) {
      const error = new Error(`必须存在的初始化文件已消失：${record.path}`);
      error.code = "ENOENT";
      throw error;
    }
  } else {
    try {
      current = await lstat(record.path, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT" && options.allowMissing !== false) return false;
      throw error;
    }
  }
  if (!sameIdentity(current, record)) {
    throw new Error(`拒绝删除 inode 不匹配的路径：${record.path}`);
  }
  if (record.sha256 && hashContent(current.content) !== record.sha256) {
    throw new Error(`拒绝删除内容已修改的路径：${record.path}`);
  }
  await unlink(record.path);
  return true;
}

async function rmdirRecordedDirectory(record, options = {}) {
  let current;
  try {
    current = await lstat(record.path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (!current.isDirectory() || !sameIdentity(current, record)) {
    throw new Error(`拒绝删除身份已变化的目录：${record.path}`);
  }
  try {
    await rmdir(record.path);
    return true;
  } catch (error) {
    if (options.tolerateNonEmpty && ["ENOTEMPTY", "EEXIST"].includes(error?.code)) return false;
    throw error;
  }
}

async function ensureDirectory(target, directory, createdDirectories, signal) {
  if (path.relative(target, directory).startsWith(`..${path.sep}`)) {
    throw new Error(`目标目录逃逸初始化范围：${directory}`);
  }
  const missingTargetChain = [];
  let existingAncestor = target;
  while (!lstatIfPresent(existingAncestor)) {
    missingTargetChain.unshift(existingAncestor);
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }
  for (const candidate of missingTargetChain) {
    signal?.throwIfAborted();
    await mkdir(candidate);
    await rememberCreatedDirectory(candidate, createdDirectories);
  }
  const targetStats = lstatIfPresent(target);
  if (!targetStats?.isDirectory() || targetStats.isSymbolicLink()) {
    throw new Error(`初始化目标不是普通目录：${target}`);
  }
  let cursor = target;
  for (const segment of path.relative(target, directory).split(path.sep).filter(Boolean)) {
    signal?.throwIfAborted();
    cursor = path.join(cursor, segment);
    const existing = lstatIfPresent(cursor);
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw new Error(`目标目录链包含非普通目录：${cursor}`);
      }
      continue;
    }
    try {
      await mkdir(cursor);
      await rememberCreatedDirectory(cursor, createdDirectories);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const raced = lstatIfPresent(cursor);
      if (!raced?.isDirectory() || raced.isSymbolicLink()) throw error;
    }
  }
}

async function rollbackCreatedEntries(createdFiles, createdDirectories) {
  const failures = [];
  for (const file of [...createdFiles].reverse()) {
    try {
      await unlinkRecordedFile(file);
    } catch (error) {
      if (error?.code !== "ENOENT") failures.push(error);
    }
  }
  for (const directory of [...createdDirectories].reverse()) {
    try {
      await rmdirRecordedDirectory(directory, { tolerateNonEmpty: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `回滚本次初始化输出失败：${failures.map((error) => error.message).join("；")}`,
    );
  }
}

async function waitForAbort(operation, signal) {
  if (!signal) return operation;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new Error("initialization aborted"));
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

function ensureNewline(value) {
  return `${value.trimEnd()}\n`;
}

function help() {
  return `create-ai-native-sdlc\n\n用法：\n  create-ai-native-sdlc init [target] [--client <copilot|claude|codex>]\n\nCLI 会询问项目名称、项目简介、未显式指定的 AI 客户端，以及可选的 Designer 输入和组件清单模块。\n`;
}

const entryPath = process.argv[1];
const isDirect = entryPath && existsSync(entryPath) && realpathSync(entryPath) === fileURLToPath(import.meta.url);
if (isDirect) {
  const controller = new AbortController();
  const signalExitCodes = { SIGINT: 130, SIGTERM: 143 };
  let receivedSignal;
  const abortForSignal = (signalName) => {
    if (receivedSignal) return;
    receivedSignal = signalName;
    controller.abort(new Error(`收到 ${signalName}，初始化已取消`));
  };
  const onSigint = () => abortForSignal("SIGINT");
  const onSigterm = () => abortForSignal("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  run(process.argv.slice(2), { signal: controller.signal }).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`错误：${error.message}\n`);
    process.exitCode = receivedSignal ? signalExitCodes[receivedSignal] : 1;
  }).finally(() => {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  });
}
