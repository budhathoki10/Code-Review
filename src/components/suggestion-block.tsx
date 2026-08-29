import { highlightDiffLines } from "@/lib/highlight";
import { CopyButton } from "@/components/copy-button";

/** One rendered row: a line of code, or a break where the captured lines skip. */
type Row =
  | { kind: "code"; tone: "ctx" | "add" | "del"; number: number; html: string }
  | { kind: "gap" };

/**
 * A committable suggestion shown the way GitHub shows it: the code being
 * replaced beside the code replacing it, each with the unchanged lines around
 * it so the change can be read in place rather than in isolation.
 *
 * GitHub can render this on a PR because the diff is right there on the page.
 * The dashboard has no diff at render time, so both the replaced line and its
 * surroundings come from the finding — `originalLine` and `originalContext`,
 * captured during the review (see computeLineContents/computeContextLines).
 * A finding stored before context existed still renders: with no context the
 * block degrades to the single before/after pair it used to show.
 *
 * Columns side by side from `sm` up, stacked below it — two columns of code
 * on a phone would force each into a few unreadable characters. Each side
 * scrolls independently so a long line never widens the page, and the line
 * numbers stay pinned while it does.
 */
export async function SuggestionBlock({
  line,
  originalLine,
  originalContext,
  suggestion,
  file,
  className,
}: {
  line: number;
  originalLine: string;
  originalContext?: { line: number; text: string }[];
  suggestion: string;
  file: string;
  className?: string;
}) {
  const suggestionLines = suggestion.replace(/\n$/, "").split("\n");

  // Sorted rather than trusted: the field is stored data, and a caller-visible
  // ordering bug here would render the context scrambled around the change.
  const context = [...(originalContext ?? [])].sort((a, b) => a.line - b.line);
  const before = context.filter((c) => c.line < line);
  const after = context.filter((c) => c.line > line);

  // The replacement occupies as many lines as it has, so everything below it
  // shifts on the "suggested" side — the same renumbering GitHub does.
  const shift = suggestionLines.length - 1;

  const [leftRows, rightRows] = await Promise.all([
    buildRows(file, [
      ...before.map((c) => ({ tone: "ctx" as const, number: c.line, text: c.text })),
      { tone: "del" as const, number: line, text: originalLine },
      ...after.map((c) => ({ tone: "ctx" as const, number: c.line, text: c.text })),
    ]),
    buildRows(file, [
      ...before.map((c) => ({ tone: "ctx" as const, number: c.line, text: c.text })),
      ...suggestionLines.map((text, i) => ({ tone: "add" as const, number: line + i, text })),
      ...after.map((c) => ({ tone: "ctx" as const, number: c.line + shift, text: c.text })),
    ]),
  ]);

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
        <Side
          label="Current"
          tone="del"
          rows={leftRows}
          className="border-b border-border sm:border-r sm:border-b-0"
        />
        <Side label="Suggested" tone="add" rows={rightRows} />
      </div>
    </div>
  );
}

/**
 * Highlights one column's lines and inserts a break wherever their numbers
 * jump — a removed line or a hunk edge means the captured window isn't
 * contiguous, and running the two sides together would imply the code is
 * adjacent when it isn't.
 */
async function buildRows(
  file: string,
  entries: { tone: "ctx" | "add" | "del"; number: number; text: string }[],
): Promise<Row[]> {
  const marker = { ctx: " ", add: "+", del: "-" };
  const highlighted = await highlightDiffLines(entries.map((e) => `${marker[e.tone]}${e.text}`).join("\n"), file);

  const rows: Row[] = [];
  entries.forEach((entry, i) => {
    const previous = entries[i - 1];
    if (previous && entry.number > previous.number + 1) rows.push({ kind: "gap" });
    rows.push({ kind: "code", tone: entry.tone, number: entry.number, html: highlighted[i]?.html ?? "" });
  });
  return rows;
}

function Side({
  label,
  tone,
  rows,
  className,
}: {
  label: string;
  tone: "add" | "del";
  rows: Row[];
  className?: string;
}) {
  const accent = tone === "add" ? "text-success" : "text-danger";

  return (
    <div className={`min-w-0 ${className ?? ""}`}>
      <p
        className={`border-b border-border px-3 py-1 text-[10px] font-semibold tracking-wide uppercase ${accent}`}
      >
        {label}
      </p>
      <pre className="overflow-x-auto py-2 font-mono text-xs leading-relaxed sm:text-[13px]">
        {rows.map((row, i) =>
          row.kind === "gap" ? (
            <span key={i} className="flex select-none text-subtle" aria-hidden="true">
              <span className="sticky left-0 w-10 shrink-0 bg-card pr-2 text-right">⋯</span>
            </span>
          ) : (
            <Line key={i} row={row} />
          ),
        )}
      </pre>
    </div>
  );
}

function Line({ row }: { row: Extract<Row, { kind: "code" }> }) {
  // Context keeps the page background so the changed line is the only thing
  // carrying colour — the point of showing context is to recede behind it.
  const background = row.tone === "add" ? "bg-success/10" : row.tone === "del" ? "bg-danger/10" : "";
  const accent = row.tone === "add" ? "text-success" : row.tone === "del" ? "text-danger" : "text-subtle";
  const sign = row.tone === "add" ? "+" : row.tone === "del" ? "-" : " ";

  return (
    <span className={`flex ${background}`}>
      <span
        className={`sticky left-0 w-10 shrink-0 pr-2 text-right tabular-nums select-none ${accent} ${background || "bg-card"}`}
        aria-hidden="true"
      >
        {row.number}
      </span>
      <span className={`w-4 shrink-0 select-none ${accent}`} aria-hidden="true">
        {sign}
      </span>
      <span className="min-w-0 flex-1 pr-3 whitespace-pre" dangerouslySetInnerHTML={{ __html: row.html }} />
    </span>
  );
}
