import { describe, expect, it } from "vitest";
import { riskReasons } from "@/lib/review/risk";
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
