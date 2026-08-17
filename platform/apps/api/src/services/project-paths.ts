import { existsSync, realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";

import { AppError } from "../domain/errors.js";

export class ProjectPathPolicy {
  readonly allowedRoots: string[];

  constructor(allowedRoots: string[]) {
    if (allowedRoots.length === 0) throw new Error("至少需要一个允许的项目根目录");
    this.allowedRoots = allowedRoots.map((root) => canonicalizeMissingPathSync(path.resolve(root)));
  }

  async resolveProjectPath(candidate: string, allowMissing = false): Promise<string> {
    const resolved = path.resolve(candidate);
    const canonical = existsSync(resolved)
      ? await realpath(resolved)
      : await canonicalizeMissingPath(resolved);
    const allowed = this.allowedRoots.some((root) => isWithin(root, canonical));
    if (!allowed) {
      throw new AppError(
        "项目目录不在 AI_SDLC_ALLOWED_PROJECT_ROOTS 允许范围内",
        403,
        "PROJECT_PATH_FORBIDDEN"
      );
    }
    if (!allowMissing && !existsSync(canonical)) {
      throw new AppError("项目目录不存在", 400, "PROJECT_PATH_MISSING");
    }
    return canonical;
  }
}

async function canonicalizeMissingPath(candidate: string): Promise<string> {
  const missing: string[] = [];
  let cursor = candidate;
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.join(await realpath(cursor), ...missing);
}

function canonicalizeMissingPathSync(candidate: string): string {
  const missing: string[] = [];
  let cursor = candidate;
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.join(realpathSync(cursor), ...missing);
}

export function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
