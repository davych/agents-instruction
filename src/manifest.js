import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  GENERATOR_NAME,
  MANIFEST_PATH,
  TEMPLATE_SET
} from "./constants.js";
import { ConfigError } from "./errors.js";
import { assertSafeRelativePath } from "./fs-safety.js";
import { normalizeLineEndings, sha256, stableJson } from "./utils.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageJsonPath = path.resolve(moduleDirectory, "../package.json");
const { version: GENERATOR_VERSION } = JSON.parse(await readFile(packageJsonPath, "utf8"));

export async function loadManifest(root) {
  const absolutePath = path.join(root, MANIFEST_PATH);
  let source;
  try {
    source = await readFile(absolutePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return { manifest: emptyManifest(), source: null };
    }
    throw error;
  }

  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch (error) {
    throw new ConfigError(`${MANIFEST_PATH} 不是有效 JSON`, [error.message]);
  }

  if (
    manifest?.schemaVersion !== 1 ||
    manifest?.generator?.name !== GENERATOR_NAME ||
    manifest?.generator?.templateSet !== TEMPLATE_SET ||
    typeof manifest?.generator?.version !== "string" ||
    !manifest.files ||
    typeof manifest.files !== "object" ||
    Array.isArray(manifest.files)
  ) {
    throw new ConfigError(`${MANIFEST_PATH} 不是受支持的生成清单`);
  }

  for (const [filePath, record] of Object.entries(manifest.files)) {
    assertSafeRelativePath(filePath, "manifest path");
    if (!record || !["managed", "seed", "block"].includes(record.mode)) {
      throw new ConfigError(`${MANIFEST_PATH} 包含无效记录: ${filePath}`);
    }
    const keys = Object.keys(record).sort();
    if (record.mode === "managed" || record.mode === "seed") {
      const allowed = record.stale === true
        ? ["hash", "mode", "pathCreatedByGenerator", "stale"]
        : ["hash", "mode", "pathCreatedByGenerator"];
      if (
        !isSha256(record.hash) ||
        typeof record.pathCreatedByGenerator !== "boolean" ||
        !sameKeys(keys, allowed)
      ) {
        throw new ConfigError(`${MANIFEST_PATH} 包含无效 ${record.mode} 记录: ${filePath}`);
      }
    }
    if (record.mode === "block") {
      const allowed = record.stale === true
        ? ["blockHash", "markerStyle", "mode", "pathCreatedByGenerator", "stale"]
        : ["blockHash", "markerStyle", "mode", "pathCreatedByGenerator"];
      if (
        !isSha256(record.blockHash) ||
        typeof record.pathCreatedByGenerator !== "boolean" ||
        !["markdown", "hash"].includes(record.markerStyle) ||
        !sameKeys(keys, allowed)
      ) {
        throw new ConfigError(`${MANIFEST_PATH} 包含无效 block 记录: ${filePath}`);
      }
    }
  }

  return { manifest, source };
}

export function buildManifest(entries, previousManifest, { prunedPaths = new Set() } = {}) {
  const files = Object.create(null);
  const desiredPaths = new Set();

  for (const entry of entries) {
    if (entry.tracked === false || entry.mode === "config") {
      continue;
    }
    desiredPaths.add(entry.path);
    if (entry.mode === "block") {
      files[entry.path] = {
        blockHash: contentHash(entry.block),
        markerStyle: entry.markerStyle,
        mode: "block",
        pathCreatedByGenerator: entry.pathCreatedByGenerator === true
      };
    } else {
      files[entry.path] = {
        hash: contentHash(entry.content),
        mode: entry.mode,
        pathCreatedByGenerator: entry.pathCreatedByGenerator === true
      };
    }
  }

  for (const [filePath, record] of Object.entries(previousManifest.files ?? {})) {
    if (!desiredPaths.has(filePath) && !prunedPaths.has(filePath)) {
      files[filePath] = { ...record, stale: true };
    }
  }

  return {
    schemaVersion: 1,
    generator: {
      name: GENERATOR_NAME,
      templateSet: TEMPLATE_SET,
      version: GENERATOR_VERSION
    },
    files
  };
}

export function serializeManifest(manifest) {
  return stableJson(manifest);
}

function emptyManifest() {
  return {
    schemaVersion: 1,
    generator: {
      name: GENERATOR_NAME,
      templateSet: TEMPLATE_SET,
      version: GENERATOR_VERSION
    },
    files: {}
  };
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function sameKeys(actual, expected) {
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function contentHash(value) {
  return sha256(normalizeLineEndings(value));
}
