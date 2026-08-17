import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

const markdownComponents: Components = {
  table: ({ node: _node, ...props }) => (
    <div className="markdown-table-wrapper scrollbar-thin">
      <table {...props} />
    </div>
  ),
};

export function MarkdownPreview({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <article className={cn("markdown-body", className)}>
      <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]} skipHtml>
        {content}
      </ReactMarkdown>
    </article>
  );
}
