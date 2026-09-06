import { describe, expect, it } from "vitest";
import { codeWindow, riskReasons } from "@/lib/review/risk";
import { selectDiffForReview } from "@/lib/review/diff-selection";
import { triageFile } from "@/lib/review/triage";

describe("risk-based attention", () => {
  it.each(["src/auth.ts", "src/permissions/check.ts", "src/api/users.ts", "db/migrations/001.sql", "src/billing.ts"])("flags sensitive path %s", (filename) => {
    expect(riskReasons({ filename, status: "modified" }).length).toBeGreaterThan(0);
  });
  it("also detects sensitive operations outside named folders", () => {
    expect(riskReasons({ filename: "src/ordinary.ts", status: "modified", patch: "+await db.deleteMany({});" })).toContain("data / migrations");
  });
  it("does not flag ordinary presentation changes", () => {
    expect(riskReasons({ filename: "src/button.tsx", status: "modified", patch: "+return <button>Save</button>;" })).toEqual([]);
  });
  it("keeps sensitive deletions and whitespace-looking changes for review", () => {
    expect(triageFile({ filename: "src/auth.ts", status: "removed", patch: "-requireAuth();" }).skip).toBeUndefined();
    expect(triageFile({ filename: "src/auth.ts", status: "modified", patch: '-const role = "super user";\n+const role = "superuser";' }).skip).toBeUndefined();
  });
  it("prioritizes sensitive code within the same bounded review capacity", () => {
    const files = ["src/button.tsx", "src/auth.ts"].map((filename) => ({ filename, status: "modified", patch: "@@ -1 +1 @@\n-const x = 1;\n+const x = 2;" }));
    const selected = selectDiffForReview(files);
    expect(selected.chunks[0].files[0].filename).toBe("src/auth.ts");
    expect(selected.coveredCount).toBe(2);
  });
});

describe("codeWindow", () => {
  // 40 chars of content per line; the numbered prefix pushes each rendered
  // line past 44, so a 400-char cap holds roughly 8 of them.
  const content = Array.from({ length: 61 }, (_, index) => `line${index + 1}`.padEnd(40, "-")).join("\n");

  it("keeps the lines after the anchor when the window does not fit", () => {
    // The bug: the window was rendered whole and then cut with slice(0, max),
    // which removes only the TAIL — so every line after the finding vanished,
    // and that is exactly where a guard, an early return or a catch block that
    // would refute the finding lives.
    const window = codeWindow(content, 31, 30, 400);
    const numbers = window.split("\n").map((line) => Number(line.split(":")[0]));
    expect(numbers).toContain(31);
    expect(numbers.some((n) => n > 31)).toBe(true);
    expect(numbers.some((n) => n < 31)).toBe(true);
    expect(window.length).toBeLessThanOrEqual(400);
  });

  it("emits only whole numbered lines", () => {
    // A mid-line cut produced a fragment the verifier could read but never
    // quote: the evidence check compares each numbered line against canonical
    // source, so a truncated line is context spent for nothing.
    for (const line of codeWindow(content, 31, 30, 400).split("\n")) {
      const [number, ...rest] = line.split(": ");
      expect(rest.join(": ")).toBe(`line${number}`.padEnd(40, "-"));
    }
  });

  it("returns the end of the file for a line number past its end", () => {
    // Previously sliced an empty range and returned "" — a hallucinated line
    // number or a file that changed between fetches silently produced no
    // context at all rather than the closest thing to it.
    expect(codeWindow(content, 5000, 3, 6000)).toContain("61: ");
  });

  it("still centres on the anchor when everything fits", () => {
    const numbers = codeWindow(content, 31, 3, 6000).split("\n").map((line) => Number(line.split(":")[0]));
    expect(numbers).toEqual([28, 29, 30, 31, 32, 33, 34]);
  });
});
