import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

const markdownComponents: Components = {
  table: ({ node: _node, ...props }) => (
    <div className="markdown-table-wrapper scrollbar-thin max-w-full">
      <table {...props} />
    </div>
  ),
};

const untrustedMarkdownComponents: Components = {
  ...markdownComponents,
  // Ask answers are influenced by untrusted repository text. Their verified
  // evidence lives in a separate citation panel, so model-authored links and
  // images must neither navigate nor trigger browser network requests.
  a: ({ node: _node, children }) => <span>{children}</span>,
  img: ({ node: _node, alt }) => (
    <span className="text-slate-500">[外部图片已省略{alt ? `：${alt}` : ""}]</span>
  ),
};

export function MarkdownPreview({
  content,
  className,
  mode = "trusted",
}: {
  content: string;
  className?: string;
  mode?: "trusted" | "untrusted";
}) {
  return (
    <article className={cn("markdown-body min-w-0 max-w-full", className)}>
      <ReactMarkdown
        components={mode === "untrusted" ? untrustedMarkdownComponents : markdownComponents}
        remarkPlugins={[remarkGfm]}
        skipHtml
      >
        {content}
      </ReactMarkdown>
    </article>
  );
}
