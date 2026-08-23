import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AppError } from "../domain/errors.js";
import { assertRuntimePath } from "./artifact-workspace.js";
import { isWithin } from "./project-paths.js";

export const VERIFICATION_WORKSPACE_POLICY_VERSION = "verification-workspace-v2";

/**
 * These are the only project-root subtrees in which Verification may retain
 * generated runner evidence. They are deliberately not basename exclusions:
 * `packages/example/test-results` remains protected.
 */
export const VERIFICATION_RUNTIME_EVIDENCE_PATHS = [
  "test-results",
  "playwright-report",
  "blob-report",
] as const;

/**
 * Directory components excluded from byte snapshots because they are
 * dependency stores, virtual environments, caches, or build output.
 * The match is exact and case-sensitive at any depth. Authoritative source,
 * tests, workflow control, and role resources must not live in these trees.
 */
export const VERIFICATION_SNAPSHOT_EXCLUDED_DIRECTORY_NAMES = [
  "node_modules",
  ".pnpm-store",
  ".cache",
  ".next",
  ".nuxt",
  ".turbo",
  "dist",
  "build",
  "target",
  "coverage",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "__pycache__",
  ".gradle",
  ".venv",
  "venv",
] as const;

/** Exact relative directory prefixes excluded in addition to basename rules. */
export const VERIFICATION_SNAPSHOT_EXCLUDED_RELATIVE_DIRECTORIES = [
  ".yarn/cache",
  ".yarn/unplugged",
] as const;

export interface VerificationWorkspaceRevision {
  policyVersion: typeof VERIFICATION_WORKSPACE_POLICY_VERSION;
  token: string;
  protectedPathCount: number;
  protectedBytes: number;
}

export interface VerificationWorkspaceProtectionInput {
  projectRoot: string;
  selectedOutputPaths: string[];
  /** Canonical in-project git-dir/common-dir values resolved before the guard. */
  protectedGitMetadataPaths?: string[];
  maxBytes?: number;
  maxEntries?: number;
}

type WorkspaceEntryKind = "directory" | "file" | "symlink";

interface WorkspaceEntry {
  relativePath: string;
  kind: WorkspaceEntryKind;
  mode: number;
  size: number;
  allowedAncestor?: boolean;
  contentHash?: string;
  linkTarget?: string;
  backupPath?: string;
}

interface WorkspaceSnapshot {
  entries: Map<string, WorkspaceEntry>;
  revision: VerificationWorkspaceRevision;
}

interface WorkspaceScanPolicy {
  projectRoot: string;
  selectedOutputPaths: string[];
  runtimeEvidenceRoots: string[];
  allowedRoots: string[];
  allowedAncestors: Set<string>;
  excludedRelativeDirectories: string[];
  maxBytes: number;
  maxEntries: number;
}

const DEFAULT_MAX_VERIFICATION_SNAPSHOT_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_VERIFICATION_SNAPSHOT_ENTRIES = 200_000;
const excludedDirectoryNames = new Set<string>(VERIFICATION_SNAPSHOT_EXCLUDED_DIRECTORY_NAMES);

/**
 * Calculates the exact revision token used by the Verification mutation guard.
 * The selected report and explicit runtime-evidence roots are intentionally
 * outside the digest so test execution can update them without changing the
 * approved implementation/workspace revision.
 */
export async function captureVerificationWorkspaceRevision(
  input: VerificationWorkspaceProtectionInput,
): Promise<VerificationWorkspaceRevision> {
  try {
    const policy = await resolveWorkspacePolicy(input);
    return (await scanWorkspace(policy)).revision;
  } catch (error) {
    throw snapshotFailure("Verification 工作区 revision 扫描失败", error);
  }
}

/**
 * Compares the synchronous runner window against one full-workspace baseline.
 * Protected changes observed by the end scan are restored, re-verified, and
 * rejected. This is a mutation detector/rollback layer, not a process sandbox:
 * an escaped detached descendant can write after the end scan. Callers must
 * prohibit background work and use a disposable or otherwise recoverable tree.
 * The operation receives the same revision token that the guard later checks.
 */
export async function withVerificationWorkspaceProtected<T>(
  input: VerificationWorkspaceProtectionInput,
  operation: (revision: VerificationWorkspaceRevision) => Promise<T>,
): Promise<T> {
  let policy: WorkspaceScanPolicy;
  try {
    policy = await resolveWorkspacePolicy(input);
  } catch (error) {
    throw snapshotFailure("Verification 工作区保护策略解析失败，执行已被阻止", error);
  }
  const backupRoot = await mkdtemp(path.join(tmpdir(), "ai-sdlc-verification-workspace-"));
  let baseline: WorkspaceSnapshot;
  try {
    baseline = await scanWorkspace(policy, backupRoot);
  } catch (error) {
    await rm(backupRoot, { recursive: true, force: true }).catch(() => undefined);
    throw snapshotFailure("Verification 工作区基线扫描失败，执行已被阻止", error);
  }

  try {
    let result: T | undefined;
    let operationError: unknown;
    try {
      result = await operation(baseline.revision);
    } catch (error) {
      operationError = error;
    }

    let current: WorkspaceSnapshot;
    try {
      current = await scanWorkspace(policy);
    } catch (error) {
      const restoreError = await restoreWorkspaceSnapshot(policy, baseline, undefined);
      throw new AppError(
        "Verification 工作区结束扫描失败；平台按失败关闭并尝试恢复基线",
        restoreError ? 500 : 422,
        restoreError
          ? "UNSELECTED_OUTPUTS_RESTORE_FAILED"
          : "VERIFICATION_WORKSPACE_SNAPSHOT_FAILED",
        {
          restored: !restoreError,
          cause: error instanceof Error ? error.message : String(error),
          restoreError: restoreError instanceof Error ? restoreError.message : undefined,
        },
      );
    }

    const changed = changedWorkspacePaths(baseline.entries, current.entries);
    if (changed.length > 0) {
      const restoreError = await restoreWorkspaceSnapshot(policy, baseline, current);
      if (restoreError) {
        throw new AppError(
          "Verification 修改了受保护的项目文件，且平台无法完整还原工作区",
          500,
          "UNSELECTED_OUTPUTS_RESTORE_FAILED",
          {
            changed: changed.map(verificationWorkspaceId),
            restored: false,
            restoreError: restoreError instanceof Error ? restoreError.message : String(restoreError),
            operationError: operationError instanceof Error ? operationError.message : undefined,
          },
        );
      }
      if (operationError) throw operationError;
      throw new AppError(
        `Verification 修改了受保护的项目文件，平台已还原：${changed.join(", ")}`,
        422,
        "UNSELECTED_OUTPUTS_CHANGED",
        { changed: changed.map(verificationWorkspaceId), restored: true },
      );
    }

    if (operationError) throw operationError;
    return result as T;
  } finally {
    await rm(backupRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function resolveWorkspacePolicy(
  input: VerificationWorkspaceProtectionInput,
): Promise<WorkspaceScanPolicy> {
  const requestedProjectRoot = path.resolve(input.projectRoot);
  await assertRuntimePath(requestedProjectRoot, requestedProjectRoot);
  const projectRoot = await realpath(requestedProjectRoot);
  const selectedOutputPaths = await Promise.all(input.selectedOutputPaths.map((candidate) =>
    resolveProtectedCandidate(requestedProjectRoot, projectRoot, candidate)));
  const runtimeEvidenceRoots = VERIFICATION_RUNTIME_EVIDENCE_PATHS.map((relativePath) =>
    path.join(projectRoot, relativePath));
  const protectedGitMetadataPaths = await Promise.all(
    (input.protectedGitMetadataPaths ?? []).map((candidate) =>
      resolveProtectedCandidate(requestedProjectRoot, projectRoot, candidate)),
  );
  const allowedRoots = [...selectedOutputPaths, ...runtimeEvidenceRoots];
  for (const candidate of allowedRoots) {
    if (!isWithin(projectRoot, candidate) || candidate === projectRoot) {
      throw new AppError(
        "Verification 可写路径必须是项目目录内的具体文件或子目录",
        422,
        "UNSAFE_ARTIFACT_PATH",
        { candidate },
      );
    }
    await assertRuntimePath(projectRoot, candidate);
  }
  await assertSelectedOutputPolicy({
    projectRoot,
    selectedOutputPaths,
    runtimeEvidenceRoots,
    protectedGitMetadataPaths,
  });

  const allowedAncestors = new Set<string>();
  for (const allowedRoot of allowedRoots) {
    let cursor = path.dirname(allowedRoot);
    while (cursor !== projectRoot && isWithin(projectRoot, cursor)) {
      allowedAncestors.add(cursor);
      cursor = path.dirname(cursor);
    }
  }

  return {
    projectRoot,
    selectedOutputPaths,
    runtimeEvidenceRoots,
    allowedRoots,
    allowedAncestors,
    excludedRelativeDirectories: VERIFICATION_SNAPSHOT_EXCLUDED_RELATIVE_DIRECTORIES.map(
      (relativePath) => path.resolve(projectRoot, ...relativePath.split("/")),
    ),
    maxBytes: input.maxBytes ?? DEFAULT_MAX_VERIFICATION_SNAPSHOT_BYTES,
    maxEntries: input.maxEntries ?? DEFAULT_MAX_VERIFICATION_SNAPSHOT_ENTRIES,
  };
}

async function resolveProtectedCandidate(
  requestedProjectRoot: string,
  canonicalProjectRoot: string,
  candidate: string,
): Promise<string> {
  const resolved = path.resolve(candidate);
  if (!isWithin(requestedProjectRoot, resolved)) return resolved;
  await assertRuntimePath(requestedProjectRoot, resolved);
  const relativePath = path.relative(requestedProjectRoot, resolved);
  return canonicalizeMissingPath(path.join(canonicalProjectRoot, relativePath));
}

async function canonicalizeMissingPath(candidate: string): Promise<string> {
  const missing: string[] = [];
  let cursor = candidate;
  while (true) {
    try {
      const canonical = await realpath(cursor);
      return path.join(canonical, ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missing.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function assertSelectedOutputPolicy(input: {
  projectRoot: string;
  selectedOutputPaths: string[];
  runtimeEvidenceRoots: string[];
  protectedGitMetadataPaths: string[];
}): Promise<void> {
  const staticControlRoots = [
    "ai-native.yaml",
    "AGENTS.md",
    "CLAUDE.md",
    ".ai-sdlc",
    ".codex",
    ".claude",
    ".github",
  ].map((relativePath) => path.join(input.projectRoot, relativePath));
  const exactExcludedRoots = VERIFICATION_SNAPSHOT_EXCLUDED_RELATIVE_DIRECTORIES.map(
    (relativePath) => path.join(input.projectRoot, ...relativePath.split("/")),
  );

  for (const selectedOutput of input.selectedOutputPaths) {
    const relativePath = path.relative(input.projectRoot, selectedOutput);
    const components = relativePath.split(path.sep).filter(Boolean);
    const rootName = components[0] ?? "";
    const conflict = [
      ...input.runtimeEvidenceRoots.map((candidate) => ({ candidate, label: "runtime evidence" })),
      ...input.protectedGitMetadataPaths.map((candidate) => ({ candidate, label: "Git metadata" })),
      ...staticControlRoots.map((candidate) => ({ candidate, label: "project control" })),
      ...exactExcludedRoots.map((candidate) => ({ candidate, label: "snapshot exclusion" })),
    ].find(({ candidate }) => pathsOverlap(selectedOutput, candidate));
    const forbiddenComponent = components.find((component) =>
      component === ".git" || excludedDirectoryNames.has(component));
    const protectedEnvironment = components.length > 0
      && /^\.env(?:\.|$)/u.test(rootName);
    const existingStats = await lstatOrNull(selectedOutput);
    const nonMarkdownOutput = path.extname(selectedOutput).toLowerCase() !== ".md";
    if (
      conflict
      || forbiddenComponent
      || protectedEnvironment
      || existingStats?.isDirectory()
      || nonMarkdownOutput
    ) {
      throw new AppError(
        "Verification selected output 必须是独立 Markdown 报告文件，不能与 Git 元数据、项目控制、运行证据或快照排除目录重叠",
        422,
        "UNSAFE_ARTIFACT_PATH",
        {
          selectedOutput,
          conflict: conflict?.label
            ?? (forbiddenComponent ? `forbidden component ${forbiddenComponent}` : undefined)
            ?? (protectedEnvironment ? "root environment control" : undefined)
            ?? (existingStats?.isDirectory() ? "directory output" : undefined)
            ?? "non-Markdown output",
        },
      );
    }
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
}

async function scanWorkspace(
  policy: WorkspaceScanPolicy,
  backupRoot?: string,
): Promise<WorkspaceSnapshot> {
  const entries = new Map<string, WorkspaceEntry>();
  let protectedBytes = 0;

  const rootStats = await lstat(policy.projectRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new AppError(
      "Verification 项目根目录必须是普通目录",
      422,
      "VERIFICATION_WORKSPACE_SNAPSHOT_FAILED",
    );
  }
  storeWorkspaceEntry(entries, {
    relativePath: ".",
    kind: "directory",
    mode: rootStats.mode & 0o7777,
    size: 0,
  }, policy.maxEntries);

  const visit = async (absolutePath: string): Promise<void> => {
    if (isRuntimeEvidencePath(policy, absolutePath)) return;

    const relativePath = toRelativePath(policy.projectRoot, absolutePath);
    const stats = await lstat(absolutePath);
    if (isSelectedOutputPath(policy, absolutePath)) {
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new AppError(
          `Verification selected output 必须保持为普通文件：${relativePath}`,
          422,
          "UNSAFE_ARTIFACT_PATH",
        );
      }
      return;
    }
    if (isExcludedPath(policy, absolutePath, stats.isDirectory())) return;
    const mode = stats.mode & 0o7777;
    const allowedAncestor = policy.allowedAncestors.has(absolutePath) || undefined;
    if (stats.isSymbolicLink()) {
      const linkTarget = await readlink(absolutePath);
      const entry: WorkspaceEntry = {
        relativePath,
        kind: "symlink",
        mode,
        size: Buffer.byteLength(linkTarget),
        allowedAncestor,
        linkTarget,
      };
      protectedBytes += entry.size;
      assertSnapshotCapacity(policy.maxBytes, protectedBytes);
      if (backupRoot) entry.backupPath = await backupWorkspaceEntry(absolutePath, relativePath, backupRoot);
      storeWorkspaceEntry(entries, entry, policy.maxEntries);
      return;
    }
    if (stats.isFile()) {
      const bytes = await readFile(absolutePath);
      protectedBytes += bytes.length;
      assertSnapshotCapacity(policy.maxBytes, protectedBytes);
      const entry: WorkspaceEntry = {
        relativePath,
        kind: "file",
        mode,
        size: bytes.length,
        allowedAncestor,
        contentHash: createHash("sha256").update(bytes).digest("hex"),
      };
      if (backupRoot) entry.backupPath = await backupWorkspaceEntry(absolutePath, relativePath, backupRoot);
      storeWorkspaceEntry(entries, entry, policy.maxEntries);
      return;
    }
    if (!stats.isDirectory()) {
      throw new AppError(
        `Verification 工作区包含不支持的文件类型：${relativePath}`,
        422,
        "VERIFICATION_WORKSPACE_SNAPSHOT_FAILED",
      );
    }

    // Existing allowed ancestors remain protected (including type and mode),
    // while an absent ancestor may later be created as a directory solely to
    // materialize the selected output. Siblings are always traversed.
    storeWorkspaceEntry(entries, {
      relativePath,
      kind: "directory",
      mode,
      size: 0,
      allowedAncestor,
    }, policy.maxEntries);
    const children = await readdir(absolutePath, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) await visit(path.join(absolutePath, child.name));
  };

  const rootEntries = await readdir(policy.projectRoot, { withFileTypes: true });
  rootEntries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of rootEntries) await visit(path.join(policy.projectRoot, entry.name));

  return {
    entries,
    revision: {
      policyVersion: VERIFICATION_WORKSPACE_POLICY_VERSION,
      token: workspaceDigest(policy, entries),
      protectedPathCount: entries.size,
      protectedBytes,
    },
  };
}

function isSelectedOutputPath(policy: WorkspaceScanPolicy, candidate: string): boolean {
  return policy.selectedOutputPaths.includes(candidate);
}

function isRuntimeEvidencePath(policy: WorkspaceScanPolicy, candidate: string): boolean {
  return policy.runtimeEvidenceRoots.some((allowedRoot) => isWithin(allowedRoot, candidate));
}

function isExcludedPath(
  policy: WorkspaceScanPolicy,
  absolutePath: string,
  isDirectory: boolean,
): boolean {
  const name = path.basename(absolutePath);
  if (isDirectory && excludedDirectoryNames.has(name)) return true;
  return isDirectory && policy.excludedRelativeDirectories.some(
    (excludedRoot) => isWithin(excludedRoot, absolutePath),
  );
}

async function backupWorkspaceEntry(
  source: string,
  relativePath: string,
  backupRoot: string,
): Promise<string> {
  const backupPath = path.join(backupRoot, ...relativePath.split("/"));
  await mkdir(path.dirname(backupPath), { recursive: true });
  await cp(source, backupPath, {
    recursive: false,
    force: false,
    errorOnExist: true,
    dereference: false,
    preserveTimestamps: true,
  });
  return backupPath;
}

function workspaceDigest(
  policy: WorkspaceScanPolicy,
  entries: Map<string, WorkspaceEntry>,
): string {
  const hash = createHash("sha256");
  hash.update(`${VERIFICATION_WORKSPACE_POLICY_VERSION}\0`);
  for (const allowedRoot of policy.allowedRoots
    .map((candidate) => toRelativePath(policy.projectRoot, candidate))
    .sort((left, right) => left.localeCompare(right))) {
    hash.update("allowed\0").update(allowedRoot).update("\0");
  }
  for (const entry of [...entries.values()]
    // Selected-output ancestors are protected when they already exist, but
    // their creation is a necessary materialization detail. Omitting them from
    // the approval token keeps first-run pre/post captures equivalent.
    .filter((candidate) => !candidate.allowedAncestor)
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    hash.update(entry.kind)
      .update("\0")
      .update(entry.relativePath)
      .update("\0")
      .update(String(entry.mode))
      .update("\0")
      .update(String(entry.size))
      .update("\0")
      .update(entry.allowedAncestor ? "allowed-ancestor" : "protected")
      .update("\0")
      .update(entry.contentHash ?? entry.linkTarget ?? "")
      .update("\0");
  }
  return hash.digest("hex");
}

function changedWorkspacePaths(
  baseline: Map<string, WorkspaceEntry>,
  current: Map<string, WorkspaceEntry>,
): string[] {
  const paths = new Set([...baseline.keys(), ...current.keys()]);
  return [...paths]
    .filter((relativePath) => {
      const before = baseline.get(relativePath);
      const after = current.get(relativePath);
      if (!before && after?.allowedAncestor && after.kind === "directory") return false;
      return !sameWorkspaceEntry(before, after);
    })
    .sort((left, right) => left.localeCompare(right));
}

function sameWorkspaceEntry(left: WorkspaceEntry | undefined, right: WorkspaceEntry | undefined): boolean {
  return left?.kind === right?.kind
    && left?.mode === right?.mode
    && left?.size === right?.size
    && left?.allowedAncestor === right?.allowedAncestor
    && left?.contentHash === right?.contentHash
    && left?.linkTarget === right?.linkTarget;
}

async function restoreWorkspaceSnapshot(
  policy: WorkspaceScanPolicy,
  baseline: WorkspaceSnapshot,
  knownCurrent: WorkspaceSnapshot | undefined,
): Promise<unknown | undefined> {
  try {
    if (!knownCurrent) {
      await restoreWorkspaceSnapshotBlindly(policy, baseline);
      const restored = await scanWorkspace(policy);
      const remainingChanges = changedWorkspacePaths(baseline.entries, restored.entries);
      if (remainingChanges.length > 0) {
        throw new Error(
          `blind-restored workspace still differs at ${remainingChanges.join(", ")}`,
        );
      }
      return undefined;
    }
    const current = knownCurrent;
    const added = [...current.entries.keys()]
      .filter((relativePath) => {
        if (baseline.entries.has(relativePath)) return false;
        const entry = current.entries.get(relativePath);
        return !(entry?.allowedAncestor && entry.kind === "directory");
      })
      .sort(compareDeepestFirst)
      .filter((relativePath, index, paths) =>
        !paths.some((other, otherIndex) => otherIndex !== index && isRelativeAncestor(other, relativePath)));
    for (const relativePath of added) {
      const target = fromRelativePath(policy.projectRoot, relativePath);
      await assertRuntimePath(policy.projectRoot, path.dirname(target));
      await removeTreeEvenIfUnreadable(target);
    }

    const directories = [...baseline.entries.values()]
      .filter((entry) => entry.kind === "directory"
        && !sameWorkspaceEntry(entry, current.entries.get(entry.relativePath)))
      .sort((left, right) => compareShallowestFirst(left.relativePath, right.relativePath));
    for (const entry of directories) {
      const target = fromRelativePath(policy.projectRoot, entry.relativePath);
      if (target !== policy.projectRoot) {
        await assertRuntimePath(policy.projectRoot, path.dirname(target));
      }
      const currentStats = await lstatOrNull(target);
      if (currentStats && !currentStats.isDirectory()) await removeTreeEvenIfUnreadable(target);
      await mkdir(target, { recursive: true, mode: 0o700 });
    }

    const leafEntries = [...baseline.entries.values()]
      .filter((entry) => entry.kind !== "directory")
      .sort((left, right) => compareShallowestFirst(left.relativePath, right.relativePath));
    for (const entry of leafEntries) {
      const currentEntry = current.entries.get(entry.relativePath);
      if (sameWorkspaceEntry(entry, currentEntry)) continue;
      const target = fromRelativePath(policy.projectRoot, entry.relativePath);
      await assertRuntimePath(policy.projectRoot, path.dirname(target));
      await mkdir(path.dirname(target), { recursive: true });
      await replaceFromBackup(target, entry);
    }

    for (const entry of [...directories].sort((left, right) =>
      compareDeepestFirst(left.relativePath, right.relativePath))) {
      await chmod(fromRelativePath(policy.projectRoot, entry.relativePath), entry.mode);
    }

    const restored = await scanWorkspace(policy);
    const remainingChanges = changedWorkspacePaths(baseline.entries, restored.entries);
    if (remainingChanges.length > 0) {
      throw new Error(
        `restored workspace still differs at ${remainingChanges.join(", ")}`,
      );
    }
    return undefined;
  } catch (error) {
    return error;
  }
}

async function restoreWorkspaceSnapshotBlindly(
  policy: WorkspaceScanPolicy,
  baseline: WorkspaceSnapshot,
): Promise<void> {
  // Restore traversal rights first. A chmod(000) mutation must not prevent the
  // platform from reaching the very path it needs to repair.
  await chmod(policy.projectRoot, 0o700);
  const directories = [...baseline.entries.values()]
    .filter((entry) => entry.kind === "directory")
    .sort((left, right) => compareShallowestFirst(left.relativePath, right.relativePath));
  for (const entry of directories) {
    const target = fromRelativePath(policy.projectRoot, entry.relativePath);
    if (target !== policy.projectRoot) {
      await assertRuntimePath(policy.projectRoot, path.dirname(target));
      const currentStats = await lstatOrNull(target);
      if (currentStats && !currentStats.isDirectory()) await removeTreeEvenIfUnreadable(target);
      await mkdir(target, { recursive: true, mode: 0o700 });
    }
    await chmod(target, 0o700);
  }

  const leaves = [...baseline.entries.values()]
    .filter((entry) => entry.kind !== "directory")
    .sort((left, right) => compareShallowestFirst(left.relativePath, right.relativePath));
  for (const entry of leaves) {
    const target = fromRelativePath(policy.projectRoot, entry.relativePath);
    await assertRuntimePath(policy.projectRoot, path.dirname(target));
    await mkdir(path.dirname(target), { recursive: true });
    await replaceFromBackup(target, entry);
  }

  await removeUnexpectedWorkspacePaths(policy, baseline.entries, policy.projectRoot);

  for (const entry of [...directories]
    .sort((left, right) => compareDeepestFirst(left.relativePath, right.relativePath))) {
    await chmod(fromRelativePath(policy.projectRoot, entry.relativePath), entry.mode);
  }
}

async function removeUnexpectedWorkspacePaths(
  policy: WorkspaceScanPolicy,
  baseline: Map<string, WorkspaceEntry>,
  directory: string,
): Promise<void> {
  await chmod(directory, 0o700);
  const children = await readdir(directory, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    const target = path.join(directory, child.name);
    if (isRuntimeEvidencePath(policy, target)) continue;
    const relativePath = toRelativePath(policy.projectRoot, target);
    const stats = await lstat(target);
    if (isSelectedOutputPath(policy, target) && stats.isFile() && !stats.isSymbolicLink()) {
      continue;
    }
    if (isExcludedPath(policy, target, stats.isDirectory())) continue;

    const baselineEntry = baseline.get(relativePath);
    if (baselineEntry?.kind === "directory") {
      await removeUnexpectedWorkspacePaths(policy, baseline, target);
      continue;
    }
    if (baselineEntry) continue;

    if (policy.allowedAncestors.has(target)) {
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        await removeTreeEvenIfUnreadable(target);
        await mkdir(target, { recursive: true, mode: 0o700 });
      }
      await removeUnexpectedWorkspacePaths(policy, baseline, target);
      continue;
    }
    await removeTreeEvenIfUnreadable(target);
  }
}

async function removeTreeEvenIfUnreadable(target: string): Promise<void> {
  const stats = await lstatOrNull(target);
  if (!stats) return;
  if (stats.isDirectory() && !stats.isSymbolicLink()) {
    await chmod(target, 0o700).catch(() => undefined);
    const children = await readdir(target, { withFileTypes: true });
    for (const child of children) {
      await removeTreeEvenIfUnreadable(path.join(target, child.name));
    }
  }
  await rm(target, { recursive: true, force: true });
}

async function replaceFromBackup(target: string, entry: WorkspaceEntry): Promise<void> {
  if (!entry.backupPath) throw new Error(`missing backup for ${entry.relativePath}`);
  const token = randomUUID();
  const stagedPath = `${target}.ai-sdlc-restore-${token}`;
  const changedPath = `${target}.ai-sdlc-changed-${token}`;
  await cp(entry.backupPath, stagedPath, {
    recursive: false,
    force: false,
    errorOnExist: true,
    dereference: false,
    preserveTimestamps: true,
  });
  const currentStats = await lstatOrNull(target);
  if (currentStats) await rename(target, changedPath);
  try {
    await rename(stagedPath, target);
    await removeTreeEvenIfUnreadable(changedPath);
  } catch (error) {
    await rename(changedPath, target).catch(() => undefined);
    await rm(stagedPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function verificationWorkspaceId(relativePath: string): string {
  return `verification-workspace:${relativePath}`;
}

function compareDeepestFirst(left: string, right: string): number {
  return pathDepth(right) - pathDepth(left) || right.localeCompare(left);
}

function compareShallowestFirst(left: string, right: string): number {
  return pathDepth(left) - pathDepth(right) || left.localeCompare(right);
}

function pathDepth(relativePath: string): number {
  if (relativePath === ".") return 0;
  return relativePath.split("/").length;
}

function isRelativeAncestor(ancestor: string, candidate: string): boolean {
  return candidate.startsWith(`${ancestor}/`);
}

function toRelativePath(projectRoot: string, absolutePath: string): string {
  return path.relative(projectRoot, absolutePath).split(path.sep).join("/");
}

function fromRelativePath(projectRoot: string, relativePath: string): string {
  return path.join(projectRoot, ...relativePath.split("/"));
}

function assertSnapshotCapacity(maxBytes: number, consumed: number): void {
  if (consumed <= maxBytes) return;
  throw new AppError(
    `Verification 工作区受保护内容超过 ${maxBytes} 字节限制，无法建立安全快照`,
    422,
    "VERIFICATION_WORKSPACE_SNAPSHOT_FAILED",
    { maxBytes, consumed },
  );
}

function storeWorkspaceEntry(
  entries: Map<string, WorkspaceEntry>,
  entry: WorkspaceEntry,
  maxEntries: number,
): void {
  entries.set(entry.relativePath, entry);
  if (entries.size <= maxEntries) return;
  throw new AppError(
    `Verification 工作区受保护路径超过 ${maxEntries} 项限制，无法建立安全快照`,
    422,
    "VERIFICATION_WORKSPACE_SNAPSHOT_FAILED",
    { maxEntries, consumed: entries.size },
  );
}

function snapshotFailure(message: string, error: unknown): AppError {
  if (error instanceof AppError && error.code === "VERIFICATION_WORKSPACE_SNAPSHOT_FAILED") {
    return error;
  }
  return new AppError(
    message,
    422,
    "VERIFICATION_WORKSPACE_SNAPSHOT_FAILED",
    { cause: error instanceof Error ? error.message : String(error) },
  );
}

async function lstatOrNull(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
