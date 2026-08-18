#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const roleRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const referenceRoot = path.join(roleRoot, "references");
const relativePaths = [
  "architecture-rules.md",
  "rules/core.md",
  "rules/api.md",
  "rules/data.md",
  "rules/integration.md",
  "rules/security.md",
  "rules/observability.md",
  "rules/frontend.md",
];
const hash = createHash("sha256");
const configContent = await readFile(path.join(roleRoot, "config.yaml"), "utf8");
const projectMode = readProjectMode(configContent);

hash.update("config.project_mode", "utf8");
hash.update("\0", "utf8");
hash.update(projectMode, "utf8");
hash.update("\0", "utf8");

for (const relativePath of relativePaths) {
  const content = await readFile(path.join(referenceRoot, relativePath), "utf8");
  hash.update(relativePath, "utf8");
  hash.update("\0", "utf8");
  hash.update(content.replace(/\r\n?/gu, "\n"), "utf8");
  hash.update("\0", "utf8");
}

process.stdout.write(`${hash.digest("hex")}\n`);

function readProjectMode(content) {
  const lines = content.replace(/\r\n?/gu, "\n").split("\n");
  const rulebookIndex = lines.findIndex((line) => /^\s*rulebook:\s*(?:#.*)?$/u.test(line));
  if (rulebookIndex < 0) return "auto";
  const parentIndent = lines[rulebookIndex].match(/^\s*/u)?.[0].length ?? 0;
  for (let index = rulebookIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || /^\s*(?:#.*)?$/u.test(line)) continue;
    const indent = line.match(/^\s*/u)?.[0].length ?? 0;
    if (indent <= parentIndent) break;
    const match = line.match(/^\s*project_mode:\s*([^#]+?)(?:\s+#.*)?$/u);
    if (!match) continue;
    const value = match[1].trim().replace(/^(?:"([^"]*)"|'([^']*)')$/u, "$1$2").toLowerCase();
    if (["auto", "greenfield", "brownfield", "hybrid"].includes(value)) return value;
    throw new Error(`Unsupported rulebook.project_mode: ${value}`);
  }
  return "auto";
}
