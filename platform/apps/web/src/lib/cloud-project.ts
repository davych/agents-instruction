import type { Project } from "@/lib/types";

export interface ParsedRepositoryUrl {
  url: string;
  host: string;
  suggestedName: string;
}

export function parseRemoteRepositoryUrl(value: string): ParsedRepositoryUrl | null {
  const candidate = value.trim();
  if (!candidate || /[\u0000-\u001f\u007f]/u.test(candidate)) return null;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:") return null;
    if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
      return null;
    }
    const parts = parsed.pathname.split("/").filter(Boolean);
    const leaf = parts.at(-1)?.replace(/\.git$/iu, "").trim();
    if (!leaf) return null;
    return {
      url: parsed.toString(),
      host: parsed.hostname.toLowerCase(),
      suggestedName: leaf.slice(0, 160),
    };
  } catch {
    return null;
  }
}

export function shortRevision(revision: string | null | undefined): string {
  if (!revision) return "尚未生成";
  return revision.length > 12 ? revision.slice(0, 12) : revision;
}

export function projectStatusLabel(project: Project): string {
  const operation = project.repository?.operation;
  if (operation?.state === "failed") {
    return project.repository?.activeSnapshot ? "同步失败" : "导入失败";
  }
  if (operation?.kind === "sync") return "正在同步";
  if (operation) return "正在导入";
  if (project.knowledge?.status === "failed") return "知识处理失败";
  return project.availableActions.ask ? "已就绪" : "正在建立知识";
}

export function projectStatusVariant(
  project: Project,
): "success" | "warning" | "danger" | "info" {
  if (project.repository?.operation?.state === "failed" || project.knowledge?.status === "failed") {
    return "danger";
  }
  if (project.availableActions.ask) return "success";
  if (project.repository?.operation?.kind === "sync") return "info";
  return "warning";
}

export function projectRepositoryLabel(project: Project): string {
  if (project.repository) {
    const ref = project.repository.requestedRef || "默认分支";
    return `${project.repository.host} · ${ref}`;
  }
  return "兼容本地项目 · 仅此部署可用";
}
