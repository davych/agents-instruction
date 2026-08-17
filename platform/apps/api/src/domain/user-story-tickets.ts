import { createHash } from "node:crypto";

import { AppError } from "./errors.js";

export interface ParsedStoryTicket {
  storyKey: string;
  title: string;
  category: string;
  sourcePath: string;
  content: string;
  contentHash: string;
  acceptanceCriteriaCount: number;
  position: number;
}

interface SnapshotFileSection {
  sourcePath: string;
  contentStart: number;
  contentEnd: number;
}

const snapshotFileHeading = /^##[ \t]+((?:[^/\\\r\n]+[/\\])*[^/\\\r\n]+\.md)[ \t]*\r?$/gimu;
const storyHeading = /^#[ \t]+(US-(\d{3,}))[ \t]*[:：][ \t]*(.+?)[ \t]*#*[ \t]*$/iu;
const categoryLine = /^\*\*Category:\*\*[ \t]*(.+?)[ \t]*$/imu;

export function parseUserStoryTickets(snapshot: string): ParsedStoryTicket[] {
  const sections = snapshotSections(snapshot);
  const tickets: ParsedStoryTicket[] = [];
  const sourcePathByKey = new Map<string, string>();

  for (const section of sections) {
    if (!/(?:^|\/)story\.md$/iu.test(section.sourcePath)) continue;

    const content = snapshot.slice(section.contentStart, section.contentEnd).trim();
    const firstLine = content.replace(/^\uFEFF/u, "").split(/\r?\n/u, 1)[0] ?? "";
    const heading = storyHeading.exec(firstLine);
    if (!heading) continue;

    const storyKey = heading[1]?.toUpperCase();
    const positionText = heading[2];
    const title = heading[3]?.trim();
    if (!storyKey || !positionText || !title) continue;

    const previousSourcePath = sourcePathByKey.get(storyKey);
    if (previousSourcePath) {
      throw new AppError(
        `用户故事包含重复编号 ${storyKey}`,
        422,
        "INVALID_USER_STORIES",
        { storyKey, sourcePaths: [previousSourcePath, section.sourcePath] }
      );
    }

    const category = categoryLine.exec(content)?.[1]?.trim() || categoryFromPath(section.sourcePath);
    const acceptanceCriteriaCount = countAcceptanceCriteria(content, storyKey);
    sourcePathByKey.set(storyKey, section.sourcePath);
    tickets.push({
      storyKey,
      title,
      category,
      sourcePath: section.sourcePath,
      content,
      contentHash: createHash("sha256").update(content).digest("hex"),
      acceptanceCriteriaCount,
      position: Number.parseInt(positionText, 10)
    });
  }

  return tickets.sort((left, right) =>
    left.position - right.position
      || left.storyKey.localeCompare(right.storyKey)
      || left.sourcePath.localeCompare(right.sourcePath)
  );
}

function snapshotSections(snapshot: string): SnapshotFileSection[] {
  const matches = [...snapshot.matchAll(snapshotFileHeading)];
  return matches.map((match, index) => ({
    sourcePath: normalizeSourcePath(match[1] ?? ""),
    contentStart: (match.index ?? 0) + match[0].length,
    contentEnd: matches[index + 1]?.index ?? snapshot.length
  }));
}

function normalizeSourcePath(sourcePath: string): string {
  return sourcePath.replace(/\\/gu, "/").replace(/^\.\//u, "").trim();
}

function categoryFromPath(sourcePath: string): string {
  const parts = sourcePath.split("/").filter(Boolean);
  return parts.length > 2 ? parts.at(-3) ?? "uncategorized" : "uncategorized";
}

function countAcceptanceCriteria(content: string, storyKey: string): number {
  const escapedKey = storyKey.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const acceptanceHeading = new RegExp(
    `^###[ \\t]+${escapedKey}-AC-\\d+[ \\t]*(?:[:：]|$)`,
    "gimu"
  );
  return [...content.matchAll(acceptanceHeading)].length;
}
