import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AppError } from "../domain/errors.js";
import { isWithin } from "./project-paths.js";

export interface ProtectedArtifactPath {
  id: string;
  absolutePath: string;
}

interface ArtifactPathSnapshot extends ProtectedArtifactPath {
  backupPath: string;
  stateHash: string | null;
}

export interface PreparedArtifactRevision {
  content: string;
  contentHash: string;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/**
 * Runs work while preserving every protected path exactly. If the work touches
 * one of those paths, its byte-level tree is restored before control returns.
 */
export async function withProtectedArtifactPaths<T>(
  projectRoot: string,
  artifacts: ProtectedArtifactPath[],
  maxBytes: number,
  operation: () => Promise<T>,
): Promise<T> {
  if (artifacts.length === 0) return operation();
  assertNonOverlappingPaths(artifacts);

  const backupRoot = await mkdtemp(path.join(tmpdir(), "ai-sdlc-protected-artifacts-"));
  const snapshots: ArtifactPathSnapshot[] = [];
  try {
    for (const [index, artifact] of artifacts.entries()) {
      await assertRuntimePath(projectRoot, artifact.absolutePath);
      const stateHash = await hashArtifactTree(artifact.absolutePath, maxBytes);
      const backupPath = path.join(backupRoot, String(index));
      if (stateHash !== null) {
        await cp(artifact.absolutePath, backupPath, {
          recursive: true,
          force: false,
          errorOnExist: true,
          dereference: false,
          preserveTimestamps: true,
        });
      }
      snapshots.push({ ...artifact, backupPath, stateHash });
    }

    let result: T | undefined;
    let operationError: unknown;
    try {
      result = await operation();
    } catch (error) {
      operationError = error;
    }

    const changed: string[] = [];
    let restoreError: unknown;
    for (const snapshot of snapshots) {
      let currentHash: string | null;
      try {
        currentHash = await hashArtifactTree(snapshot.absolutePath, maxBytes);
      } catch {
        currentHash = "unsafe-or-unreadable";
      }
      if (currentHash === snapshot.stateHash) continue;
      changed.push(snapshot.id);
      try {
        await restoreArtifactSnapshot(projectRoot, snapshot);
      } catch (error) {
        restoreError ??= error;
      }
    }

    if (restoreError) {
      throw new AppError(
        "局部重跑修改了未选产物，且平台无法完整还原工作区",
        500,
        "UNSELECTED_OUTPUTS_RESTORE_FAILED",
        {
          changed,
          restoreError: restoreError instanceof Error ? restoreError.message : String(restoreError),
          operationError: operationError instanceof Error ? operationError.message : undefined,
        },
      );
    }
    if (operationError) throw operationError;
    if (changed.length > 0) {
      throw new AppError(
        `局部重跑修改了未选中的产物，平台已还原：${changed.join(", ")}`,
        422,
        "UNSELECTED_OUTPUTS_CHANGED",
        { changed, restored: true },
      );
    }
    return result as T;
  } finally {
    await rm(backupRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Keeps selected output writes only when the wrapped runner operation and its
 * workspace validations succeed. This covers runner-level exit and validation
 * failures; database persistence is coordinated separately by the caller.
 */
export async function withArtifactPathsRollbackOnError<T>(
  projectRoot: string,
  artifacts: ProtectedArtifactPath[],
  maxBytes: number,
  operation: () => Promise<T>,
): Promise<T> {
  if (artifacts.length === 0) return operation();
  assertNonOverlappingPaths(artifacts);

  const backupRoot = await mkdtemp(path.join(tmpdir(), "ai-sdlc-selected-artifacts-"));
  const snapshots: ArtifactPathSnapshot[] = [];
  try {
    for (const [index, artifact] of artifacts.entries()) {
      await assertRuntimePath(projectRoot, artifact.absolutePath);
      const stateHash = await hashArtifactTree(artifact.absolutePath, maxBytes);
      const backupPath = path.join(backupRoot, String(index));
      if (stateHash !== null) {
        await cp(artifact.absolutePath, backupPath, {
          recursive: true,
          force: false,
          errorOnExist: true,
          dereference: false,
          preserveTimestamps: true,
        });
      }
      snapshots.push({ ...artifact, backupPath, stateHash });
    }

    try {
      return await operation();
    } catch (operationError) {
      const changed: string[] = [];
      let restoreError: unknown;
      for (const snapshot of snapshots) {
        let currentHash: string | null;
        try {
          currentHash = await hashArtifactTree(snapshot.absolutePath, maxBytes);
        } catch {
          currentHash = "unsafe-or-unreadable";
        }
        if (currentHash === snapshot.stateHash) continue;
        changed.push(snapshot.id);
        try {
          await restoreArtifactSnapshot(projectRoot, snapshot);
        } catch (error) {
          restoreError ??= error;
        }
      }
      if (restoreError) {
        throw new AppError(
          "Codex 执行失败，且平台无法完整还原本次已选产物",
          500,
          "SELECTED_OUTPUTS_RESTORE_FAILED",
          {
            changed,
            restoreError: restoreError instanceof Error ? restoreError.message : String(restoreError),
            operationError: operationError instanceof Error ? operationError.message : String(operationError),
          },
        );
      }
      throw operationError;
    }
  } finally {
    await rm(backupRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Atomically swaps a human-edited revision into the registered workspace path.
 * The caller commits the DB revision and then calls commit(), or calls
 * rollback() if the DB transaction fails.
 */
export async function prepareArtifactRevision(input: {
  projectRoot: string;
  absolutePath: string;
  previousContentHash: string;
  nextContent: string;
  maxBytes: number;
}): Promise<PreparedArtifactRevision> {
  const { projectRoot, absolutePath, previousContentHash, nextContent, maxBytes } = input;
  await assertRuntimePath(projectRoot, absolutePath);
  const stats = await lstatOrNull(absolutePath);
  if (!stats) {
    throw new AppError(
      "项目中的产物文件已不存在，请先恢复或重新运行该产物",
      409,
      "ARTIFACT_WORKSPACE_DIVERGED",
    );
  }
  if (!stats.isFile() && !stats.isDirectory()) {
    throw new AppError("产物必须是普通文件或目录", 422, "INVALID_ARTIFACT");
  }

  const physicalContent = await readArtifactContent(absolutePath, maxBytes);
  const physicalHash = sha256(physicalContent);
  if (physicalHash !== previousContentHash) {
    throw new AppError(
      "项目文件已在平台外发生变化，请刷新或重新运行后再保存人工版本",
      409,
      "ARTIFACT_WORKSPACE_DIVERGED",
      { expectedContentHash: previousContentHash, currentContentHash: physicalHash },
    );
  }

  const parent = path.dirname(absolutePath);
  await assertRuntimePath(projectRoot, parent);
  const token = randomUUID();
  const baseName = path.basename(absolutePath);
  const stagedPath = path.join(parent, `.${baseName}.ai-sdlc-stage-${token}`);
  const backupPath = path.join(parent, `.${baseName}.ai-sdlc-backup-${token}`);
  let swapped = false;

  try {
    if (stats.isFile()) {
      await writeFile(stagedPath, nextContent, { encoding: "utf8", flag: "wx" });
      await chmod(stagedPath, stats.mode & 0o777);
    } else {
      const relativeFiles = (await listArtifactFiles(absolutePath))
        .map((file) => path.relative(absolutePath, file).split(path.sep).join("/"));
      const files = parseDirectoryRevision(nextContent, relativeFiles);
      await mkdir(stagedPath);
      for (const file of files) {
        const destination = path.join(stagedPath, ...file.relativePath.split("/"));
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, file.content, { encoding: "utf8", flag: "wx" });
      }
    }

    await rename(absolutePath, backupPath);
    try {
      await rename(stagedPath, absolutePath);
      swapped = true;
    } catch (error) {
      await rename(backupPath, absolutePath).catch(() => undefined);
      throw error;
    }

    const materializedContent = await readArtifactContent(absolutePath, maxBytes);
    if (materializedContent !== nextContent) {
      throw new AppError(
        "目录产物的编辑格式无效，无法无损写回各文件",
        422,
        "ARTIFACT_DIRECTORY_FORMAT_INVALID",
      );
    }
  } catch (error) {
    if (swapped) {
      await rm(absolutePath, { recursive: true, force: true }).catch(() => undefined);
      await rename(backupPath, absolutePath).catch(() => undefined);
    }
    await rm(stagedPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  let settled = false;
  return {
    content: nextContent,
    contentHash: sha256(nextContent),
    async commit() {
      if (settled) return;
      settled = true;
      await rm(backupPath, { recursive: true, force: true }).catch(() => undefined);
    },
    async rollback() {
      if (settled) return;
      settled = true;
      const failedPath = path.join(parent, `.${baseName}.ai-sdlc-failed-${token}`);
      try {
        if (await lstatOrNull(absolutePath)) await rename(absolutePath, failedPath);
        await rename(backupPath, absolutePath);
        await rm(failedPath, { recursive: true, force: true });
      } catch (error) {
        throw new AppError(
          "数据库保存失败，且项目文件无法自动回滚",
          500,
          "ARTIFACT_WORKSPACE_ROLLBACK_FAILED",
          { cause: error instanceof Error ? error.message : String(error) },
        );
      }
    },
  };
}

export async function readArtifactContent(target: string, maxBytes: number): Promise<string> {
  const stats = await lstat(target);
  if (stats.isSymbolicLink()) throw new AppError("产物不能是符号链接", 422, "UNSAFE_ARTIFACT");
  if (stats.isFile()) {
    if (stats.size > maxBytes) {
      throw new AppError(`产物超过 ${maxBytes} 字节限制`, 422, "ARTIFACT_TOO_LARGE");
    }
    return readFile(target, "utf8");
  }
  if (!stats.isDirectory()) throw new AppError("产物必须是普通文件或目录", 422, "INVALID_ARTIFACT");
  const files = await listArtifactFiles(target);
  let consumed = 0;
  const parts: string[] = [];
  for (const file of files) {
    const fileStats = await lstat(file);
    if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
      throw new AppError("产物目录只能包含普通文件", 422, "UNSAFE_ARTIFACT");
    }
    consumed += fileStats.size;
    if (consumed > maxBytes) {
      throw new AppError(`产物目录超过 ${maxBytes} 字节限制`, 422, "ARTIFACT_TOO_LARGE");
    }
    const relativePath = path.relative(target, file).split(path.sep).join("/");
    parts.push(`## ${relativePath}\n\n${await readFile(file, "utf8")}`);
  }
  return parts.join("\n\n");
}

export async function assertRuntimePath(projectRoot: string, target: string): Promise<void> {
  if (!isWithin(projectRoot, target)) {
    throw new AppError("产物路径逃逸项目目录", 422, "UNSAFE_ARTIFACT_PATH");
  }
  const canonicalRoot = await realpath(projectRoot);
  const relative = path.relative(projectRoot, target);
  let cursor = projectRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      const stats = await lstat(cursor);
      if (stats.isSymbolicLink()) {
        throw new AppError(
          `产物路径不能经过符号链接：${path.relative(projectRoot, cursor)}`,
          422,
          "UNSAFE_ARTIFACT_PATH",
        );
      }
      const canonical = await realpath(cursor);
      if (!isWithin(canonicalRoot, canonical)) {
        throw new AppError("产物真实路径逃逸项目目录", 422, "UNSAFE_ARTIFACT_PATH");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
}

async function listArtifactFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new AppError("产物目录不能包含符号链接", 422, "UNSAFE_ARTIFACT");
    }
    if (entry.isDirectory()) result.push(...await listArtifactFiles(target));
    else if (entry.isFile()) result.push(target);
    else throw new AppError("产物目录只能包含普通文件", 422, "INVALID_ARTIFACT");
  }
  return result;
}

async function hashArtifactTree(target: string, maxBytes: number): Promise<string | null> {
  const stats = await lstatOrNull(target);
  if (!stats) return null;
  const hash = createHash("sha256");
  let consumed = 0;

  const visit = async (candidate: string, relativePath: string): Promise<void> => {
    const candidateStats = await lstat(candidate);
    if (candidateStats.isSymbolicLink()) {
      throw new AppError("受保护产物不能包含符号链接", 422, "UNSAFE_ARTIFACT");
    }
    if (candidateStats.isFile()) {
      consumed += candidateStats.size;
      if (consumed > maxBytes) {
        throw new AppError(`产物超过 ${maxBytes} 字节限制`, 422, "ARTIFACT_TOO_LARGE");
      }
      const bytes = await readFile(candidate);
      hash.update("file\0").update(relativePath).update("\0").update(String(bytes.length)).update("\0").update(bytes);
      return;
    }
    if (!candidateStats.isDirectory()) {
      throw new AppError("产物必须是普通文件或目录", 422, "INVALID_ARTIFACT");
    }
    hash.update("directory\0").update(relativePath).update("\0");
    const entries = await readdir(candidate, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      await visit(
        path.join(candidate, entry.name),
        relativePath ? `${relativePath}/${entry.name}` : entry.name,
      );
    }
  };

  await visit(target, ".");
  return hash.digest("hex");
}

async function restoreArtifactSnapshot(
  projectRoot: string,
  snapshot: ArtifactPathSnapshot,
): Promise<void> {
  const parent = path.dirname(snapshot.absolutePath);
  await assertRuntimePath(projectRoot, parent);
  await mkdir(parent, { recursive: true });
  const token = randomUUID();
  const baseName = path.basename(snapshot.absolutePath);
  const stagedPath = path.join(parent, `.${baseName}.ai-sdlc-restore-${token}`);
  const changedPath = path.join(parent, `.${baseName}.ai-sdlc-changed-${token}`);

  if (snapshot.stateHash !== null) {
    await cp(snapshot.backupPath, stagedPath, {
      recursive: true,
      force: false,
      errorOnExist: true,
      dereference: false,
      preserveTimestamps: true,
    });
  }
  if (await lstatOrNull(snapshot.absolutePath)) {
    await rename(snapshot.absolutePath, changedPath);
  }
  try {
    if (snapshot.stateHash !== null) await rename(stagedPath, snapshot.absolutePath);
  } catch (error) {
    await rename(changedPath, snapshot.absolutePath).catch(() => undefined);
    throw error;
  }
  await rm(changedPath, { recursive: true, force: true });
}

function parseDirectoryRevision(
  content: string,
  relativeFiles: string[],
): Array<{ relativePath: string; content: string }> {
  if (relativeFiles.length === 0) {
    throw new AppError(
      "空目录产物不支持在聚合编辑器中保存",
      422,
      "ARTIFACT_DIRECTORY_FORMAT_INVALID",
    );
  }
  for (const relativePath of relativeFiles) assertSafeRelativeFile(relativePath);

  const markers = relativeFiles.map((relativePath) => `## ${relativePath}\n\n`);
  for (const marker of markers) {
    if (countOccurrences(content, marker) !== 1) {
      throw new AppError(
        "目录产物必须完整保留每个文件的唯一 `## 相对路径` 标题",
        422,
        "ARTIFACT_DIRECTORY_FORMAT_INVALID",
        { marker: marker.trim() },
      );
    }
  }
  if (!content.startsWith(markers[0]!)) {
    throw new AppError(
      "目录产物的第一个文件标题无效",
      422,
      "ARTIFACT_DIRECTORY_FORMAT_INVALID",
    );
  }

  const parsed: Array<{ relativePath: string; content: string }> = [];
  let cursor = markers[0]!.length;
  for (let index = 0; index < relativeFiles.length; index += 1) {
    const nextMarker = markers[index + 1];
    const boundary = nextMarker ? `\n\n${nextMarker}` : undefined;
    const end = boundary ? content.indexOf(boundary, cursor) : content.length;
    if (end < 0) {
      throw new AppError(
        "目录产物的文件标题顺序或分隔符已损坏",
        422,
        "ARTIFACT_DIRECTORY_FORMAT_INVALID",
      );
    }
    parsed.push({ relativePath: relativeFiles[index]!, content: content.slice(cursor, end) });
    cursor = boundary ? end + boundary.length : end;
  }
  return parsed;
}

function assertSafeRelativeFile(relativePath: string): void {
  const segments = relativePath.split("/");
  if (
    !relativePath
    || path.posix.isAbsolute(relativePath)
    || relativePath.includes("\\")
    || segments.some((segment) => !segment || segment === "." || segment === "..")
    || path.posix.normalize(relativePath) !== relativePath
  ) {
    throw new AppError("目录产物包含不安全的文件路径", 422, "UNSAFE_ARTIFACT_PATH");
  }
}

function assertNonOverlappingPaths(artifacts: ProtectedArtifactPath[]): void {
  const resolved = artifacts.map((artifact) => ({ ...artifact, path: path.resolve(artifact.absolutePath) }));
  for (const [index, left] of resolved.entries()) {
    for (const right of resolved.slice(index + 1)) {
      if (isWithin(left.path, right.path) || isWithin(right.path, left.path)) {
        throw new AppError(
          `受保护产物路径互相嵌套：${left.id}, ${right.id}`,
          422,
          "OVERLAPPING_ARTIFACT_PATHS",
        );
      }
    }
  }
}

async function lstatOrNull(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function countOccurrences(value: string, needle: string): number {
  let count = 0;
  let cursor = 0;
  while (true) {
    const index = value.indexOf(needle, cursor);
    if (index < 0) return count;
    count += 1;
    cursor = index + needle.length;
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
