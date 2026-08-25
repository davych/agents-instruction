import path from "node:path";

import { AppError } from "./errors.js";
import { isWithin } from "../services/project-paths.js";
import type {
  LoadedArtifactDefinition,
  LoadedDefinition
} from "../services/definition-loader.js";

export const TASK_SCOPED_ARTIFACT_KEYS: ReadonlySet<string> = new Set([
  "change-contract",
  "design-spec",
  "implementation-notes",
  "implementation-plan",
  "implementation-tasks",
  "engineering-session-log",
  "engineering-test-evidence",
  "engineering-review",
  "engineering-provenance",
  "test-report",
  "release-runbook",
]);
const TASK_SLUG_MAX_BYTES = 96;
const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface TaskArtifactIdentity {
  id: string;
  title: string;
}

export interface ExistingArtifactPath {
  artifactKey: string;
  filePath: string;
}

/**
 * Builds the stable, human-readable namespace shared by every rerun of one task.
 * The full run id is retained so equal titles can never select the same path.
 */
export function createTaskArtifactNamespace(task: TaskArtifactIdentity): string {
  const runId = task.id.toLowerCase();
  if (!runIdPattern.test(runId)) {
    throw new AppError("任务 run id 无效", 400, "INVALID_RUN_ID");
  }

  const normalizedTitle = task.title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  const slug = truncateUtf8(normalizedTitle, TASK_SLUG_MAX_BYTES).replace(/-+$/gu, "") || "task";
  return `${slug}--${runId}`;
}

/**
 * Returns a run-scoped definition without mutating the project definition.
 * Run-level contracts, feature-level design specs, engineering evidence,
 * verification reports, and release runbooks are task-scoped; project-wide
 * artifacts keep their configured paths.
 */
export function resolveTaskArtifactPaths(
  definition: LoadedDefinition,
  task: TaskArtifactIdentity
): LoadedDefinition {
  const namespace = createTaskArtifactNamespace(task);
  const artifacts = definition.artifacts.map((artifact) =>
    TASK_SCOPED_ARTIFACT_KEYS.has(artifact.id)
      ? taskScopedArtifact(artifact, namespace)
      : artifact
  );
  assertUniqueArtifactPaths(artifacts);
  return { ...definition, artifacts };
}

/**
 * Once a task has produced a run-scoped artifact revision, that registered path
 * is authoritative for every later rerun even if the live project config moves
 * or renames the default artifact.
 */
export function pinExistingTaskArtifactPaths(
  definition: LoadedDefinition,
  projectRoot: string,
  existingArtifacts: ExistingArtifactPath[],
): LoadedDefinition {
  const pinnedPaths = new Map<string, { relativePath: string; absolutePath: string }>();
  for (const existing of existingArtifacts) {
    if (!TASK_SCOPED_ARTIFACT_KEYS.has(existing.artifactKey)) continue;
    const relativePath = assertSafeStoredArtifactPath(existing.filePath);
    const absolutePath = path.resolve(projectRoot, ...relativePath.split("/"));
    if (!isWithin(projectRoot, absolutePath)) {
      throw new AppError("已保存的任务产物路径逃逸项目目录", 422, "UNSAFE_ARTIFACT_PATH");
    }
    pinnedPaths.set(existing.artifactKey, { relativePath, absolutePath });
  }
  if (pinnedPaths.size === 0) return definition;
  const artifacts = definition.artifacts.map((artifact) => {
    const pinned = pinnedPaths.get(artifact.id);
    return pinned ? { ...artifact, ...pinned } : artifact;
  });
  assertUniqueArtifactPaths(artifacts);
  return { ...definition, artifacts };
}

function taskScopedArtifact(
  artifact: LoadedArtifactDefinition,
  namespace: string
): LoadedArtifactDefinition {
  const configuredName = path.posix.basename(artifact.relativePath);
  if (configuredName.startsWith(`${namespace}-`)) return artifact;
  const taskFileName = `${namespace}-${configuredName}`;
  return {
    ...artifact,
    relativePath: path.posix.join(path.posix.dirname(artifact.relativePath), taskFileName),
    absolutePath: path.join(path.dirname(artifact.absolutePath), taskFileName)
  };
}

function assertUniqueArtifactPaths(artifacts: LoadedArtifactDefinition[]): void {
  const artifactByPath = new Map<string, string>();
  for (const artifact of artifacts) {
    const comparablePath = path.resolve(artifact.absolutePath).normalize("NFC").toLowerCase();
    const existing = artifactByPath.get(comparablePath);
    if (existing) {
      throw new AppError(
        `任务产物 ${existing} 与 ${artifact.id} 指向同一路径 ${artifact.relativePath}`,
        400,
        "TASK_ARTIFACT_PATH_CONFLICT"
      );
    }
    artifactByPath.set(comparablePath, artifact.id);
  }
  for (const [index, left] of artifacts.entries()) {
    for (const right of artifacts.slice(index + 1)) {
      if (
        isWithin(left.absolutePath, right.absolutePath)
        || isWithin(right.absolutePath, left.absolutePath)
      ) {
        throw new AppError(
          `任务产物 ${left.id} 与 ${right.id} 的路径不能互相嵌套`,
          400,
          "TASK_ARTIFACT_PATH_CONFLICT",
        );
      }
    }
  }
}

function assertSafeStoredArtifactPath(candidate: string): string {
  const segments = candidate.split("/");
  if (
    !candidate
    || path.posix.isAbsolute(candidate)
    || candidate.includes("\\")
    || segments.some((segment) => !segment || segment === "." || segment === "..")
    || path.posix.normalize(candidate) !== candidate
  ) {
    throw new AppError("已保存的任务产物路径无效", 422, "UNSAFE_ARTIFACT_PATH");
  }
  return candidate;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}
