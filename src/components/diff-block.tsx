import { highlightDiffLines } from "@/lib/highlight";
import { CopyButton } from "@/components/copy-button";

const GUTTER_TONE: Record<"add" | "del" | "ctx", string> = {
  add: "bg-success/10",
  del: "bg-danger/10",
  ctx: "",
};

const MARKER_TONE: Record<"add" | "del" | "ctx", string> = {
  add: "text-success",
  del: "text-danger",
  ctx: "text-subtle",
};

const MARKER: Record<"add" | "del" | "ctx", string> = { add: "+", del: "-", ctx: " " };

/**
 * Syntax-highlighted suggestion diff — file-scoped so language detection and
 * copy-to-clipboard both know what they're looking at. Highlighting runs
 * server-side (Shiki); this stays a server component so nothing ships to the
 * client beyond the small CopyButton island.
 */
export async function DiffBlock({ diff, file, className }: { diff: string; file: string; className?: string }) {
  const lines = await highlightDiffLines(diff, file);
  const fileName = file.split("/").pop() ?? file;

  return (
    <div className={`overflow-hidden rounded-lg border border-border ${className ?? ""}`}>
      <div className="flex items-center justify-between gap-2 border-b border-border bg-card px-3 py-1.5">
        <span className="truncate font-mono text-[11px] text-subtle" title={file}>
          {fileName}
        </span>
        <CopyButton text={diff.replace(/^[+\- ]/gm, "")} label="Copy suggestion" />
      </div>
      <pre className="overflow-x-auto bg-background py-2 font-mono text-xs leading-relaxed sm:text-[13px]">
        {lines.map((line, i) => (
          <span key={i} className={`flex ${GUTTER_TONE[line.kind]}`}>
            <span className={`w-6 shrink-0 pl-2.5 select-none ${MARKER_TONE[line.kind]}`} aria-hidden="true">
              {MARKER[line.kind]}
            </span>
            <span className="min-w-0 flex-1 pr-4 whitespace-pre" dangerouslySetInnerHTML={{ __html: line.html }} />
          </span>
        ))}
      </pre>
    </div>
  );
}
