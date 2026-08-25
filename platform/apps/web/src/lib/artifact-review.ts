import type { Artifact } from "@/lib/types";

export function currentArtifactHeadIds(artifacts: Artifact[]): string[] {
  return [...new Set(
    artifacts
      .filter((artifact) => !artifact.superseded && artifact.reviewStatus !== "superseded")
      .map((artifact) => artifact.id),
  )];
}

export function artifactReviewHeadKey(
  artifact: Pick<Artifact, "id" | "contentHash">,
): string | undefined {
  return artifact.id && artifact.contentHash
    ? `${artifact.id}:${artifact.contentHash}`
    : undefined;
}

export function unviewedCurrentArtifactHeads(
  artifacts: Artifact[],
  viewedHeadKeys: ReadonlySet<string>,
): Artifact[] {
  return artifacts.filter((artifact) => {
    if (artifact.superseded || artifact.reviewStatus === "superseded") return false;
    const headKey = artifactReviewHeadKey(artifact);
    return !headKey || !viewedHeadKeys.has(headKey);
  });
}

export function updateArchitectureSelectionMarker(comment: string, optionId: string): string {
  const marker = `Selected option: ${optionId}`;
  const markerPattern = /^\s*Selected option:\s*\S+\s*$/iu;
  let replaced = false;
  const lines = comment.split(/\r?\n/u).flatMap((line) => {
    if (!markerPattern.test(line)) return [line];
    if (replaced) return [];
    replaced = true;
    return [marker];
  });

  if (replaced) return lines.join("\n");
  if (comment.length === 0) return marker;
  return comment.endsWith("\n") ? `${comment}${marker}` : `${comment}\n${marker}`;
}

export function reviewExitPolicy({
  pending,
  dirty,
}: {
  pending: boolean;
  dirty: boolean;
}): "block" | "confirm" | "allow" {
  if (pending) return "block";
  return dirty ? "confirm" : "allow";
}

export function isArtifactHeadsChangedError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; code?: unknown };
  return candidate.status === 409 && candidate.code === "ARTIFACT_HEADS_CHANGED";
}

export function isArtifactRevisionRefreshError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; code?: unknown };
  return candidate.status === 409
    && (
      candidate.code === "ARTIFACT_REVISION_CONFLICT"
      || candidate.code === "ARTIFACT_WORKSPACE_DIVERGED"
    );
}

export function artifactRevisionContentInvalid(content: string, maxBytes = 2_000_000): boolean {
  return content.trim().length === 0 || artifactRevisionByteLength(content) > maxBytes;
}

export function artifactRevisionByteLength(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}
