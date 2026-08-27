import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const runUiSourcePaths = [
  "../../src/pages/run-page.tsx",
  "../../src/components/run/e2e-workspace-dialog.tsx",
  "../../src/components/run/e2e-script-review-dialog.tsx",
  "../../src/components/run/execute-dialog.tsx",
  "../../src/components/run/review-dialog.tsx",
  "../../src/components/run/phase-flow-guides.tsx",
  "../../src/components/run/run-page-helpers.ts",
].map((relativePath) => fileURLToPath(new URL(relativePath, import.meta.url)));

export async function readRunUiSource(): Promise<string> {
  return (await Promise.all(
    runUiSourcePaths.map((sourcePath) => readFile(sourcePath, "utf8")),
  )).join("\n");
}
