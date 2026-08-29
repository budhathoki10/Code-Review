import { highlightDiffLines } from "@/lib/highlight";
import { CopyButton } from "@/components/copy-button";

/**
 * A committable suggestion shown the way GitHub shows it: the line being
 * replaced beside the line replacing it.
 *
 * GitHub can render this on a PR because the diff is right there on the page.
 * The dashboard has no diff at render time, so the "before" side comes from
 * `FindingDoc.originalLine`, captured during the review (see
 * computeLineContents). Without both halves there is nothing to compare, so
 * the caller falls back to DiffBlock.
 *
 * Columns side by side from `sm` up, stacked below it — two columns of code
 * on a phone would force each into a few unreadable characters. Each side
 * scrolls independently so a long line never widens the page.
 */
export async function SuggestionBlock({
  originalLine,
  suggestion,
  file,
  className,
}: {
  originalLine: string;
  suggestion: string;
  file: string;
  className?: string;
}) {
  // Reuses the diff highlighter by describing the change as a diff: one
  // removed line, then the replacement's lines.
  const suggestionLines = suggestion.replace(/\n$/, "").split("\n");
  const synthetic = [`-${originalLine}`, ...suggestionLines.map((l) => `+${l}`)].join("\n");
  const lines = await highlightDiffLines(synthetic, file);

  const removed = lines.filter((l) => l.kind === "del");
  const added = lines.filter((l) => l.kind === "add");
  const fileName = file.split("/").pop() ?? file;

  return (
    <div className={`overflow-hidden rounded-lg border border-border ${className ?? ""}`}>
      <div className="flex items-center justify-between gap-2 border-b border-border bg-card px-3 py-1.5">
        <span className="truncate font-mono text-[11px] text-subtle" title={file}>
          {fileName}
        </span>
        <CopyButton text={suggestion} label="Copy suggestion" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2">
        <Side label="Current" tone="del" lines={removed} className="border-b border-border sm:border-r sm:border-b-0" />
        <Side label="Suggested" tone="add" lines={added} />
      </div>
    </div>
  );
}

function Side({
  label,
  tone,
  lines,
  className,
}: {
  label: string;
  tone: "add" | "del";
  lines: { html: string }[];
  className?: string;
}) {
  const bg = tone === "add" ? "bg-success/10" : "bg-danger/10";
  const marker = tone === "add" ? "text-success" : "text-danger";

  return (
    <div className={`min-w-0 ${className ?? ""}`}>
      <p className={`border-b border-border px-3 py-1 text-[10px] font-semibold tracking-wide uppercase ${marker}`}>
        {label}
      </p>
      <pre className={`overflow-x-auto py-2 font-mono text-xs leading-relaxed sm:text-[13px] ${bg}`}>
        {lines.map((line, i) => (
          <span key={i} className="flex">
            <span className={`w-5 shrink-0 pl-2 select-none ${marker}`} aria-hidden="true">
              {tone === "add" ? "+" : "-"}
            </span>
            <span className="min-w-0 flex-1 pr-3 whitespace-pre" dangerouslySetInnerHTML={{ __html: line.html }} />
          </span>
        ))}
      </pre>
    </div>
  );
}
