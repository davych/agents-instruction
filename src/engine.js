import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";

import { BLOCK_MARKERS, MANIFEST_PATH } from "./constants.js";
import { ConflictError, ConfigError } from "./errors.js";
import { assertNoSymlinkInPath, assertSafeRelativePath } from "./fs-safety.js";
import { buildManifest, serializeManifest } from "./manifest.js";
import {
  compareCodeUnits,
  ensureFinalNewline,
  normalizeLineEndings,
  sha256
} from "./utils.js";

export async function createPlan({
  root,
  entries,
  previousManifest,
  previousManifestSource,
  force = false,
  prune = false,
  protectedPaths = []
}) {
  const actions = [];
  const conflicts = [];
  const desiredPaths = new Set(entries.map((entry) => entry.path));
  const desiredPathsByKey = new Map(entries.map((entry) => [pathKey(entry.path), entry.path]));
  const protectedPathKeys = new Set([MANIFEST_PATH, ...protectedPaths].map(pathKey));
  const prunedPaths = new Set();

  for (const entry of entries) {
    let existing;
    try {
      await assertNoSymlinkInPath(root, entry.path);
      existing = await readTextFile(root, entry.path);
    } catch (error) {
      if (error instanceof ConfigError && prune && findOwnedStaleAncestor(entry.path, desiredPaths, previousManifest)) {
        throw new ConfigError(`${entry.path} 需要把旧 generated 文件改成目录，不支持一次同步完成`, [
          "请先把 output 改到临时同级路径并运行 sync --prune，再改到最终子路径；或备份后手动移除旧文件"
        ]);
      }
      if (error instanceof ConfigError && prune && findStaleDescendant(entry.path, desiredPaths, previousManifest)) {
        throw new ConfigError(`${entry.path} 需要把旧 generated 目录改成文件，不支持一次同步完成`, [
          "请先把 output 改到临时同级路径并运行 sync --prune，确认目录中无用户文件后手动删除空目录，再完成迁移"
        ]);
      }
      throw error;
    }
    if (!["config"].includes(entry.mode)) {
      const previousRecord = previousManifest.files?.[entry.path];
      entry.pathCreatedByGenerator = existing === null || previousRecord?.pathCreatedByGenerator === true;
    }
    const previousRecord = previousManifest.files?.[entry.path];
    planDesiredEntry({ entry, existing, previousRecord, force, actions, conflicts });
  }

  for (const [filePath, previousRecord] of Object.entries(previousManifest.files ?? {})) {
    if (protectedPathKeys.has(pathKey(filePath))) {
      throw new ConfigError(`manifest 不得管理保留文件: ${filePath}`);
    }
    if (desiredPaths.has(filePath)) {
      continue;
    }
    const caseCollision = desiredPathsByKey.get(pathKey(filePath));
    if (caseCollision) {
      throw new ConfigError(`不支持仅修改生成路径的大小写: ${filePath} -> ${caseCollision}`);
    }
    assertSafeRelativePath(filePath, "manifest path");
    await assertNoSymlinkInPath(root, filePath);
    const existing = await readTextFile(root, filePath);
    await planStaleEntry({
      filePath,
      previousRecord,
      existing,
      force,
      prune,
      actions,
      conflicts,
      prunedPaths
    });
  }

  if (conflicts.length > 0) {
    throw new ConflictError("检测到用户文件冲突；未写入任何文件", conflicts);
  }

  const nextManifest = buildManifest(entries, previousManifest, { prunedPaths });
  const nextManifestSource = serializeManifest(nextManifest);
  const normalizedPreviousManifestSource = previousManifestSource
    ? ensureFinalNewline(normalizeLineEndings(previousManifestSource))
    : null;

  if (normalizedPreviousManifestSource !== nextManifestSource) {
    await assertNoSymlinkInPath(root, MANIFEST_PATH);
    actions.push({
      kind: normalizedPreviousManifestSource === null ? "create" : "update",
      mode: "manifest",
      path: MANIFEST_PATH,
      before: previousManifestSource,
      after: nextManifestSource,
      backup: false
    });
  }

  actions.sort((left, right) => {
    if (left.mode === "manifest") return 1;
    if (right.mode === "manifest") return -1;
    return compareCodeUnits(left.path, right.path);
  });

  return {
    actions,
    counts: summarizeActions(actions),
    drift: actions.some((action) => action.kind !== "skip"),
    root
  };
}

export async function applyPlan(plan, { beforeAction = async () => {} } = {}) {
  const writeActions = plan.actions.filter((action) => !["skip", "stale"].includes(action.kind));
  if (writeActions.length === 0) {
    return { backupDirectory: null, written: 0 };
  }

  const backupActions = writeActions.filter((action) => action.backup && action.before !== null);
  for (const action of writeActions) {
    action.originalMode = await assertActionPrecondition(plan.root, action);
  }
  let backupDirectory = null;
  if (backupActions.length > 0) {
    const runId = `${new Date().toISOString().replace(/\D/gu, "").slice(0, 17)}-${process.pid}-${randomUUID().slice(0, 8)}`;
    backupDirectory = `.ai-sdlc/backups/${runId}`;
    const absoluteBackupDirectory = path.join(plan.root, backupDirectory);
    await assertNoSymlinkInPath(plan.root, backupDirectory);
    await mkdir(absoluteBackupDirectory, { recursive: true, mode: 0o700 });
    await assertNoSymlinkInPath(plan.root, backupDirectory);
    await chmod(absoluteBackupDirectory, 0o700);
    for (const action of backupActions) {
      const backupPath = `${backupDirectory}/${action.path}`;
      await writeTextFile(plan.root, backupPath, action.before, action.originalMode);
    }
  }

  const completed = [];
  try {
    for (const [index, action] of writeActions.entries()) {
      await beforeAction(action, index);
      await assertNoSymlinkInPath(plan.root, action.path);
      await assertActionPrecondition(plan.root, action);
      if (action.kind === "delete") {
        await unlink(path.join(plan.root, action.path));
        action.appliedState = { content: null, mode: null };
      } else {
        const appliedMode = action.originalMode ?? 0o644;
        await atomicWriteTextFile(plan.root, action.path, action.after, appliedMode);
        action.appliedState = { content: action.after, mode: appliedMode };
      }
      completed.push(action);
      action.appliedIdentity = await capturePathIdentity(plan.root, action.path);
    }
  } catch (error) {
    const rollbackFailures = await rollback(plan.root, completed);
    if (rollbackFailures.length > 0) {
      const details = rollbackFailures.map((failure) => `回滚未覆盖已变化的文件: ${failure}`);
      if (Array.isArray(error.details)) {
        error.details.push(...details);
      } else {
        error.message = `${error.message}; ${details.join("; ")}`;
      }
    }
    throw error;
  }

  return { backupDirectory, written: writeActions.length };
}

function planDesiredEntry({ entry, existing, previousRecord, force, actions, conflicts }) {
  if (entry.mode === "config") {
    if (existing !== null) {
      conflicts.push(`${entry.path}: 配置已存在；请使用 sync`);
      return;
    }
    actions.push(fileAction("create", entry, existing, entry.content));
    return;
  }

  if (entry.mode === "seed") {
    if (existing === null) {
      actions.push(fileAction("create", entry, existing, entry.content));
    } else {
      actions.push({ kind: "skip", mode: "seed", path: entry.path });
    }
    return;
  }

  if (entry.mode === "managed") {
    if (existing === null) {
      actions.push(fileAction("create", entry, existing, entry.content));
      return;
    }
    if (sameText(existing, entry.content)) {
      actions.push({ kind: "skip", mode: "managed", path: entry.path });
      return;
    }

    const owned = previousRecord?.mode === "managed" && previousRecord.hash === contentHash(existing);
    if (!owned && !force) {
      conflicts.push(`${entry.path}: 已有内容不是生成器上次写入的版本`);
      return;
    }
    actions.push(fileAction("update", entry, existing, entry.content, !owned));
    return;
  }

  if (entry.mode === "block") {
    planBlockEntry({ entry, existing, previousRecord, force, actions, conflicts });
    return;
  }

  throw new ConfigError(`未知文件模式: ${entry.mode}`);
}

function planBlockEntry({ entry, existing, previousRecord, force, actions, conflicts }) {
  const markers = BLOCK_MARKERS[entry.markerStyle];
  if (!markers) {
    throw new ConfigError(`未知区块标记类型: ${entry.markerStyle}`);
  }
  const desiredBlock = ensureFinalNewline(entry.block);
  const wrapped = wrapBlock(desiredBlock, markers);

  if (existing === null) {
    actions.push(fileAction("create", entry, existing, `${wrapped}\n`));
    return;
  }

  const parsed = parseBlock(existing, markers);
  if (parsed.status === "missing") {
    if (previousRecord?.mode === "block") {
      conflicts.push(`${entry.path}: 已登记的生成器区块标记被删除`);
      return;
    }
    const separator = existing.length === 0 ? "" : existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    actions.push(fileAction("update", entry, existing, `${existing}${separator}${wrapped}\n`));
    return;
  }
  if (parsed.status === "malformed") {
    conflicts.push(`${entry.path}: 生成器区块标记缺失、重复或顺序错误`);
    return;
  }
  if (sameText(parsed.block, desiredBlock)) {
    actions.push({ kind: "skip", mode: "block", path: entry.path });
    return;
  }

  const owned = previousRecord?.mode === "block" && previousRecord.blockHash === contentHash(parsed.block);
  if (!owned && !force) {
    conflicts.push(`${entry.path}: 生成器管理区块已被人工修改`);
    return;
  }

  const updated = `${parsed.before}${wrapped}${parsed.after}`;
  actions.push(fileAction("update", entry, existing, updated, !owned));
}

async function planStaleEntry({
  filePath,
  previousRecord,
  existing,
  force,
  prune,
  actions,
  conflicts,
  prunedPaths
}) {
  if (!prune) {
    actions.push({
      kind: "stale",
      mode: previousRecord.mode,
      path: filePath,
      reason: "run sync --prune to remove"
    });
    return;
  }

  if (previousRecord.mode === "seed") {
    if (existing === null) {
      prunedPaths.add(filePath);
    } else {
      actions.push({
        kind: "stale",
        mode: "seed",
        path: filePath,
        reason: "seed files are user-owned; delete manually, then run sync --prune"
      });
    }
    return;
  }

  if (existing === null) {
    prunedPaths.add(filePath);
    return;
  }

  if (previousRecord.mode === "managed") {
    const owned = previousRecord.hash === contentHash(existing);
    if (!owned && !force) {
      conflicts.push(`${filePath}: 陈旧 managed 文件已被人工修改，无法清理`);
      return;
    }
    if (previousRecord.pathCreatedByGenerator !== true && !force) {
      actions.push({
        kind: "stale",
        mode: "managed",
        path: filePath,
        reason: "pre-existing file; use --force --prune after review"
      });
      return;
    }
    actions.push({
      kind: "delete",
      mode: "managed",
      path: filePath,
      before: existing,
      after: null,
      backup: true
    });
    prunedPaths.add(filePath);
    return;
  }

  if (previousRecord.mode === "block") {
    const markers = BLOCK_MARKERS[previousRecord.markerStyle];
    if (!markers) {
      conflicts.push(`${filePath}: manifest 中的区块类型无效`);
      return;
    }
    const parsed = parseBlock(existing, markers);
    if (parsed.status === "missing") {
      actions.push({
        kind: "stale",
        mode: "block",
        path: filePath,
        reason: "registered markers are missing; restore them or clean the file manually"
      });
      return;
    }
    if (parsed.status === "malformed") {
      conflicts.push(`${filePath}: 陈旧区块标记格式无效`);
      return;
    }
    const owned = previousRecord.blockHash === contentHash(parsed.block);
    if (!owned && !force) {
      conflicts.push(`${filePath}: 陈旧生成器区块已被人工修改，无法清理`);
      return;
    }
    const remaining = `${parsed.before}${parsed.after}`;
    const onlyWhitespace = remaining.trim().length === 0;
    const deleteHost = onlyWhitespace && previousRecord.pathCreatedByGenerator === true;
    actions.push({
      kind: deleteHost ? "delete" : "update",
      mode: "block",
      path: filePath,
      before: existing,
      after: deleteHost ? null : remaining,
      backup: deleteHost || !owned
    });
    prunedPaths.add(filePath);
  }
}

function parseBlock(source, markers) {
  const starts = allIndexes(source, markers.start);
  const ends = allIndexes(source, markers.end);
  if (starts.length === 0 && ends.length === 0) {
    return { status: "missing" };
  }
  if (starts.length !== 1 || ends.length !== 1 || starts[0] >= ends[0]) {
    return { status: "malformed" };
  }

  const contentStart = starts[0] + markers.start.length;
  const contentEnd = ends[0];
  let block = source.slice(contentStart, contentEnd);
  block = block.replace(/^\r?\n/u, "").replace(/\r?\n$/u, "");
  block = ensureFinalNewline(block);

  return {
    status: "valid",
    before: source.slice(0, starts[0]),
    block,
    after: source.slice(ends[0] + markers.end.length)
  };
}

function wrapBlock(block, markers) {
  return `${markers.start}\n${block.replace(/\n$/u, "")}\n${markers.end}`;
}

function allIndexes(source, needle) {
  const indexes = [];
  let cursor = 0;
  while (cursor <= source.length) {
    const index = source.indexOf(needle, cursor);
    if (index === -1) break;
    indexes.push(index);
    cursor = index + needle.length;
  }
  return indexes;
}

function fileAction(kind, entry, before, after, backup = false) {
  return {
    kind,
    mode: entry.mode,
    path: entry.path,
    before,
    after,
    backup
  };
}

async function readTextFile(root, relativePath) {
  const absolutePath = path.join(root, relativePath);
  let stats;
  try {
    stats = await lstat(absolutePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (!stats.isFile()) {
    throw new ConfigError(`目标不是普通文件: ${relativePath}`);
  }
  return readFile(absolutePath, "utf8");
}

async function writeTextFile(root, relativePath, content, mode = null) {
  assertSafeRelativePath(relativePath);
  await assertNoSymlinkInPath(root, relativePath);
  const absolutePath = path.join(root, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, { encoding: "utf8", ...(mode === null ? {} : { mode }) });
  if (mode !== null) {
    await chmod(absolutePath, mode);
  }
}

async function atomicWriteTextFile(root, relativePath, content, mode = null) {
  assertSafeRelativePath(relativePath);
  await assertNoSymlinkInPath(root, relativePath);
  const absolutePath = path.join(root, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temporaryPath, content, { encoding: "utf8", ...(mode === null ? {} : { mode }) });
  if (mode !== null) {
    await chmod(temporaryPath, mode);
  }
  try {
    await rename(temporaryPath, absolutePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function assertActionPrecondition(root, action) {
  const current = await readFileState(root, action.path);
  if (
    current.content !== action.before ||
    (Object.hasOwn(action, "originalMode") && current.mode !== action.originalMode)
  ) {
    throw new ConflictError("文件系统在规划后发生变化；已回滚本次写入", [action.path]);
  }
  return current.mode;
}

async function rollback(root, completed) {
  const failures = [];
  for (const action of [...completed].reverse()) {
    try {
      await assertNoSymlinkInPath(root, action.path);
      const identity = await capturePathIdentity(root, action.path);
      if (!action.appliedIdentity || !samePathIdentity(identity, action.appliedIdentity)) {
        failures.push(action.path);
        continue;
      }
      const current = await readFileState(root, action.path);
      if (!sameFileState(current, action.appliedState)) {
        failures.push(action.path);
        continue;
      }
      await assertNoSymlinkInPath(root, action.path);
      if (!samePathIdentity(await capturePathIdentity(root, action.path), action.appliedIdentity)) {
        failures.push(action.path);
        continue;
      }
      if (action.before === null) {
        await unlink(path.join(root, action.path));
      } else {
        await atomicWriteTextFile(root, action.path, action.before, action.originalMode);
      }
    } catch (error) {
      failures.push(`${action.path} (${error.message})`);
    }
  }
  return failures;
}

async function readFileState(root, relativePath) {
  const absolutePath = path.join(root, relativePath);
  let stats;
  try {
    stats = await lstat(absolutePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { content: null, mode: null };
    }
    throw error;
  }
  if (!stats.isFile()) {
    throw new ConfigError(`目标不是普通文件: ${relativePath}`);
  }
  return {
    content: await readFile(absolutePath, "utf8"),
    mode: stats.mode & 0o777
  };
}

function summarizeActions(actions) {
  const counts = { create: 0, update: 0, delete: 0, skip: 0, stale: 0 };
  for (const action of actions) {
    counts[action.kind] = (counts[action.kind] ?? 0) + 1;
  }
  return counts;
}

function pathKey(filePath) {
  return filePath.normalize("NFC").toLocaleLowerCase("en-US");
}

function findOwnedStaleAncestor(filePath, desiredPaths, manifest) {
  const segments = filePath.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    const candidate = segments.slice(0, index).join("/");
    if (!desiredPaths.has(candidate) && manifest.files?.[candidate]?.mode === "managed") {
      return candidate;
    }
  }
  return null;
}

function findStaleDescendant(filePath, desiredPaths, manifest) {
  const prefix = `${filePath}/`;
  return Object.keys(manifest.files ?? {}).find(
    (candidate) => !desiredPaths.has(candidate) && candidate.startsWith(prefix)
  ) ?? null;
}

function contentHash(value) {
  return sha256(normalizeLineEndings(value));
}

function sameText(left, right) {
  return normalizeLineEndings(left) === normalizeLineEndings(right);
}

function sameFileState(left, right) {
  return left.content === right.content && left.mode === right.mode;
}

async function capturePathIdentity(root, relativePath) {
  const identities = [];
  const segments = relativePath.split("/");
  let cursor = root;

  for (let index = -1; index < segments.length; index += 1) {
    if (index >= 0) {
      cursor = path.join(cursor, segments[index]);
    }
    let stats;
    try {
      stats = await lstat(cursor, { bigint: true });
    } catch (error) {
      if (error.code === "ENOENT" && index === segments.length - 1) {
        identities.push({ type: "missing" });
        return identities;
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new ConfigError(`拒绝通过符号链接写入: ${relativePath}`);
    }
    if (index < segments.length - 1 && !stats.isDirectory()) {
      throw new ConfigError(`目标路径的父级不是目录: ${relativePath}`);
    }
    identities.push({
      dev: stats.dev,
      ino: stats.ino,
      type: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other"
    });
  }
  return identities;
}

function samePathIdentity(left, right) {
  return left.length === right.length && left.every((identity, index) => {
    const expected = right[index];
    return identity.type === expected.type &&
      identity.dev === expected.dev &&
      identity.ino === expected.ino;
  });
}
