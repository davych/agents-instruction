import type { Artifact } from "@/lib/types";

export function currentArtifactHeadIds(artifacts: Artifact[]): string[] {
  return [...new Set(
    artifacts
      .filter((artifact) => !artifact.superseded && artifact.reviewStatus !== "superseded")
      .map((artifact) => artifact.id),
  )];
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
