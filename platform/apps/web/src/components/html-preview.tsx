import { useMemo, useState } from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const PREVIEW_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "child-src 'none'",
  "font-src data:",
  "form-action 'none'",
  "frame-src 'none'",
  "img-src data: blob:",
  "media-src data: blob:",
  "object-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
].join("; ");

export function HtmlPreview({ content }: { content: string }) {
  const [view, setView] = useState("preview");
  const previewDocument = useMemo(() => createPreviewDocument(content), [content]);

  return (
    <Tabs value={view} onValueChange={setView} className="flex min-h-[320px] flex-col sm:min-h-[420px]">
      <div className="mb-3 flex shrink-0 items-center justify-between gap-3">
        <p className="text-xs leading-5 text-slate-500">
          预览运行在隔离沙箱中；脚本、外部资源、表单提交、弹窗和顶层跳转均被禁用。
        </p>
        <TabsList className="shrink-0" aria-label="HTML 查看模式">
          <TabsTrigger value="preview">预览</TabsTrigger>
          <TabsTrigger value="source">源码</TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="preview" className="min-h-0 flex-1">
        <iframe
          title="HTML 原型安全预览"
          srcDoc={previewDocument}
          sandbox=""
          referrerPolicy="no-referrer"
          className="h-[50dvh] min-h-[300px] w-full rounded-xl border border-slate-200 bg-white sm:h-[56vh] sm:min-h-[420px]"
        />
      </TabsContent>

      <TabsContent value="source" className="min-h-0 flex-1">
        <pre className="scrollbar-thin h-[50dvh] min-h-[300px] overflow-auto rounded-xl bg-slate-950 p-5 text-xs leading-6 text-slate-100 sm:h-[56vh] sm:min-h-[420px]">
          <code>{content}</code>
        </pre>
      </TabsContent>
    </Tabs>
  );
}

function createPreviewDocument(content: string) {
  const protectedHead = [
    `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`,
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<style>html{color-scheme:light}body{margin:0;min-height:100vh}</style>",
  ].join("\n");
  // Put the policy before every untrusted byte. Regex-injecting into a user
  // supplied <head> can be bypassed by a matching string inside a comment.
  // The HTML parser creates the document head for these metadata elements and
  // then merges a following complete HTML document or fragment normally.
  return [
    "<!doctype html>",
    protectedHead,
    content,
  ].join("\n");
}
