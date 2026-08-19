import { useEffect, useId, useState } from "react";
import mermaid from "mermaid";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: "neutral",
  suppressErrorRendering: true,
  flowchart: {
    htmlLabels: false,
    useMaxWidth: true,
  },
});

export function MermaidPreview({ content }: { content: string }) {
  const reactId = useId();
  const renderId = `mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/gu, "")}`;
  const [view, setView] = useState("diagram");
  const [svg, setSvg] = useState("");
  const [renderError, setRenderError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setSvg("");
    setRenderError(undefined);

    void mermaid.render(renderId, content)
      .then((result) => {
        if (!cancelled) setSvg(result.svg);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setRenderError(mermaidErrorMessage(error));
        setView("source");
      });

    return () => {
      cancelled = true;
    };
  }, [content, renderId]);

  return (
    <Tabs value={view} onValueChange={setView} className="flex min-h-[320px] flex-col sm:min-h-[420px]">
      <div className="mb-3 flex shrink-0 items-start justify-between gap-3">
        <div className="min-w-0 text-xs leading-5 text-slate-500">
          <p>Mermaid 在当前浏览器中渲染；图表内容不会发送到额外的预览服务。</p>
          {renderError ? (
            <p role="alert" className="mt-1 font-medium text-rose-700">
              图形渲染失败，已切换到源码：{renderError}
            </p>
          ) : null}
        </div>
        <TabsList className="shrink-0" aria-label="Mermaid 查看模式">
          <TabsTrigger value="diagram">图形</TabsTrigger>
          <TabsTrigger value="source">源码</TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="diagram" className="min-h-0 flex-1">
        {svg ? (
          <div
            role="img"
            aria-label="Mermaid C4 图预览"
            className="scrollbar-thin h-[50dvh] min-h-[300px] overflow-auto rounded-xl border border-slate-200 bg-white p-4 sm:h-[56vh] sm:min-h-[420px] sm:p-6 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <div className="flex h-[50dvh] min-h-[300px] items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-sm text-slate-500 sm:h-[56vh] sm:min-h-[420px]">
            正在浏览器中渲染 Mermaid 图…
          </div>
        )}
      </TabsContent>

      <TabsContent value="source" className="min-h-0 flex-1">
        <pre className="scrollbar-thin h-[50dvh] min-h-[300px] overflow-auto rounded-xl bg-slate-950 p-5 text-xs leading-6 text-slate-100 sm:h-[56vh] sm:min-h-[420px]">
          <code>{content}</code>
        </pre>
      </TabsContent>
    </Tabs>
  );
}

function mermaidErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n").find((line) => line.trim())?.trim() || "无法解析 Mermaid 源码";
}
