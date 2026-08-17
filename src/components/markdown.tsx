import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Renders AI-authored review text (headings, emphasis, lists, fenced code) with the app's own type and color tokens instead of react-markdown's unstyled defaults. */
export function Markdown({ content }: { content: string }) {
  return (
    <div className="text-sm leading-relaxed text-muted">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (props) => (
            <h3 className="mt-5 mb-2 text-base font-semibold text-foreground first:mt-0" {...props} />
          ),
          h2: (props) => (
            <h3 className="mt-5 mb-2 text-base font-semibold text-foreground first:mt-0" {...props} />
          ),
          h3: (props) => (
            <h4 className="mt-4 mb-1.5 text-sm font-semibold text-foreground first:mt-0" {...props} />
          ),
          p: (props) => <p className="mt-2.5 first:mt-0" {...props} />,
          ul: (props) => <ul className="mt-2.5 list-disc space-y-1 pl-5 first:mt-0" {...props} />,
          ol: (props) => <ol className="mt-2.5 list-decimal space-y-1 pl-5 first:mt-0" {...props} />,
          li: (props) => <li className="leading-relaxed" {...props} />,
          strong: (props) => <strong className="font-semibold text-foreground" {...props} />,
          em: (props) => <em className="text-foreground" {...props} />,
          a: (props) => (
            <a className="text-foreground underline underline-offset-2 hover:text-muted" {...props} />
          ),
          code: ({ className, children, ...props }) => {
            if (className?.includes("language-")) {
              return (
                <code className={className} {...props}>
                  {children}
                </code>
              );
            }
            return (
              <code
                className="rounded border border-border bg-card px-1 py-0.5 font-mono text-xs text-foreground"
                {...props}
              >
                {children}
              </code>
            );
          },
          pre: (props) => (
            <pre
              className="mt-2.5 overflow-x-auto rounded-lg border border-border bg-card p-3 font-mono text-xs leading-relaxed first:mt-0"
              {...props}
            />
          ),
          blockquote: (props) => (
            <blockquote className="mt-2.5 border-l-2 border-border pl-3 first:mt-0" {...props} />
          ),
          hr: () => <hr className="my-4 border-border" />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
