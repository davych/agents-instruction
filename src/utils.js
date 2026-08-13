import { createHash } from "node:crypto";
import path from "node:path";

export function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function ensureFinalNewline(value) {
  return `${value.replace(/\s+$/u, "")}\n`;
}

export function normalizeLineEndings(value) {
  return value.replace(/\r\n?/gu, "\n");
}

export function slugify(value) {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);
  return slug || "my-product";
}

export function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

export function stableJson(value) {
  return `${JSON.stringify(sortDeep(value), null, 2)}\n`;
}

function sortDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareCodeUnits)
        .map((key) => [key, sortDeep(value[key])])
    );
  }
  return value;
}

export function compareCodeUnits(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function formatList(items, fallback = "（待配置）") {
  if (!items || items.length === 0) {
    return fallback;
  }
  return items.map((item) => `- ${item}`).join("\n");
}
