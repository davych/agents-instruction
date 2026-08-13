import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { ConfigError } from "./errors.js";

export function assertSafeRelativePath(relativePath, label = "output path") {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new ConfigError(`${label} 不能为空`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(relativePath) || relativePath.includes("\\")) {
    throw new ConfigError(`${label} 必须使用安全的 POSIX 相对路径: ${relativePath}`);
  }
  if (path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw new ConfigError(`${label} 不能是绝对路径: ${relativePath}`);
  }

  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new ConfigError(`${label} 不能包含空段、. 或 ..: ${relativePath}`);
  }
  if (segments.some((segment) => /[:*?"<>|]/u.test(segment) || /[. ]$/u.test(segment))) {
    throw new ConfigError(`${label} 包含跨平台不安全的文件名字符: ${relativePath}`);
  }
  if (segments.some((segment) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment))) {
    throw new ConfigError(`${label} 包含 Windows 保留文件名: ${relativePath}`);
  }
  if (segments[0].toLowerCase() === ".git") {
    throw new ConfigError(`${label} 不能写入 .git: ${relativePath}`);
  }
  return relativePath;
}

export async function assertNoSymlinkInPath(root, relativePath) {
  const safePath = assertSafeRelativePath(relativePath);
  const canonicalRoot = await realpath(root).catch((error) => {
    if (error.code === "ENOENT") {
      return path.resolve(root);
    }
    throw error;
  });
  const segments = safePath.split("/");
  let cursor = canonicalRoot;

  for (const [index, segment] of segments.entries()) {
    cursor = path.join(cursor, segment);
    let stats;
    try {
      stats = await lstat(cursor);
    } catch (error) {
      if (error.code === "ENOENT") {
        return;
      }
      if (error.code === "ENOTDIR") {
        throw new ConfigError(`目标路径的父级不是目录: ${safePath}`);
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new ConfigError(`拒绝通过符号链接写入: ${safePath}`);
    }
    if (index < segments.length - 1 && !stats.isDirectory()) {
      throw new ConfigError(`目标路径的父级不是目录: ${safePath}`);
    }
  }
}
