/** Unified-diff lines with GitHub-style per-line +/- coloring — no outer wrapper, so callers can compose their own container. */
export function DiffLines({ diff }: { diff: string }) {
  const lines = diff.replace(/\n$/, "").split("\n");

  return (
    <>
      {lines.map((line, i) => {
        const prefix = line[0];
        const tone =
          prefix === "+"
            ? "bg-success/10 text-success"
            : prefix === "-"
              ? "bg-danger/10 text-danger"
              : "text-foreground";
        return (
          <span key={i} className={`block px-4 ${tone}`}>
            {line || " "}
          </span>
        );
      })}
    </>
  );
}

/** A standalone bordered diff viewer — DiffLines wrapped in the standard card treatment. Used for AI-suggested fixes. */
export function DiffBlock({ diff, className }: { diff: string; className?: string }) {
  return (
    <pre
      className={`overflow-x-auto rounded-lg border border-border bg-card py-3 font-mono text-xs leading-relaxed sm:text-sm ${className ?? ""}`}
    >
      <DiffLines diff={diff} />
    </pre>
  );
}
