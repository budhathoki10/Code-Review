/** Split at diff lines, rebuilding hunk coordinates so later sections retain real line numbers. */
export function splitPatchSections(patch: string, maxChars: number): string[] {
  if (patch.length <= maxChars) return [patch];
  const sections: string[] = [];
  let rows: string[] = [];
  let oldLine = 0;
  let newLine = 0;
  let oldStart = 0;
  let newStart = 0;
  let oldCount = 0;
  let newCount = 0;
  let chars = 0;
  let inHunk = false;
  const flush = () => {
    if (!rows.length) return;
    sections.push(`@@ -${oldCount ? oldStart : Math.max(0, oldStart - 1)},${oldCount} +${newCount ? newStart : Math.max(0, newStart - 1)},${newCount} @@\n${rows.join("\n")}\n`);
    rows = [];
    chars = oldCount = newCount = 0;
  };
  for (const row of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(row);
    if (header) {
      flush();
      oldLine = Number(header[1]) + (header[2] === "0" ? 1 : 0);
      newLine = Number(header[3]) + (header[4] === "0" ? 1 : 0);
      inHunk = true;
      continue;
    }
    if (!inHunk || !/^[ +\\-]/.test(row)) continue;
    // Keep a no-newline marker attached to its preceding line. A single
    // indivisible long line is retained whole, never silently truncated.
    if (!row.startsWith("\\") && rows.length && chars + row.length + 100 > maxChars) flush();
    if (!rows.length) { oldStart = oldLine; newStart = newLine; }
    rows.push(row);
    chars += row.length + 1;
    if (row[0] === " " || row[0] === "-") { oldLine++; oldCount++; }
    if (row[0] === " " || row[0] === "+") { newLine++; newCount++; }
  }
  flush();
  // Unknown patch syntax must remain visible, not disappear as an empty diff.
  if (!sections.length) return [patch];
  // A file can have hundreds of tiny hunks. Coalesce adjacent hunks/parts
  // within the same request budget instead of paying one model call per hunk.
  const packed: string[] = [];
  for (const section of sections) {
    const last = packed.length - 1;
    if (last >= 0 && packed[last].length + section.length <= maxChars) packed[last] += section;
    else packed.push(section);
  }
  return packed;
}
