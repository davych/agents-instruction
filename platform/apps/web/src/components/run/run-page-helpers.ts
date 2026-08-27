import type { Artifact, CodexCapabilities, CodexReasoningEffort } from "@/lib/types";

export function keyForArtifact(artifact: Artifact) {
  return artifact.artifactKey || artifact.artifactId || artifact.type || artifact.name || artifact.id;
}

export function safeHttpUrl(candidate?: string | null) {
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function isOfficialFigmaFileUrl(candidate: string) {
  if (!candidate || candidate.length > 2_048) return false;
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== "https:"
      || (url.hostname !== "figma.com" && url.hostname !== "www.figma.com")
      || url.port !== ""
      || url.username !== ""
      || url.password !== ""
      || /%2f|%5c/iu.test(url.pathname)
    ) {
      return false;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    const kind = segments[0];
    const fileKey = segments[1];
    if (
      (kind !== "design" && kind !== "file")
      || typeof fileKey !== "string"
      || !/^[a-zA-Z0-9_-]{2,256}$/u.test(fileKey)
      || segments.slice(2).some((segment) => {
        try {
          return decodeURIComponent(segment).toLowerCase() === "branch";
        } catch {
          return true;
        }
      })
    ) {
      return false;
    }
    const nodeIds = url.searchParams.getAll("node-id");
    return (
      nodeIds.length <= 1
      && (nodeIds[0] === undefined || /^\d+(?:-|:)\d+$/u.test(nodeIds[0]))
    );
  } catch {
    return false;
  }
}

export function defaultEffortForModel(
  capabilities: CodexCapabilities | undefined,
  modelId: string,
): CodexReasoningEffort | "" {
  const model = capabilities?.models.find((item) => item.id === modelId);
  if (!capabilities || !model) return "";
  if (
    modelId === capabilities.defaultModel
    && model.reasoningEfforts.includes(capabilities.defaultReasoningEffort)
  ) {
    return capabilities.defaultReasoningEffort;
  }
  return model.reasoningEfforts.includes(model.defaultReasoningEffort)
    ? model.defaultReasoningEffort
    : model.reasoningEfforts[0] ?? "";
}

export function reasoningEffortLabel(effort: string) {
  const labels: Record<string, string> = {
    none: "无（none）",
    minimal: "最小（minimal）",
    low: "低（low）",
    medium: "中（medium）",
    high: "高（high）",
    xhigh: "很高（xhigh）",
    max: "最大（max）",
    ultra: "极致（ultra）",
  };
  return labels[effort] ?? effort;
}
