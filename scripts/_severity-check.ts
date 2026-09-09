/**
 * Severity calibration check: one diff carrying defects of deliberately
 * different consequence. A reviewer that labels all of them the same is not
 * calibrating, and every high fails the author's build.
 *
 *   npx tsx scripts/_severity-check.ts
 */
import "dotenv/config";
import { generateChunkedReview } from "@/lib/ai/review";
import type { PullRequestFile } from "@/lib/github/diff";

const files: PullRequestFile[] = [
  // Severe: any caller can now read another tenant's invoice.
  {
    filename: "src/server/invoices.ts",
    status: "modified",
    changes: 8,
    patchSource: "github",
    patch: `@@ -22,8 +22,7 @@ export async function getInvoice(req: Request, id: string) {
   const invoice = await db.invoice.findUnique({ where: { id } });
   if (!invoice) return notFound();
-  if (invoice.orgId !== req.session.orgId) return forbidden();
   return json(invoice);
 }`,
  },
  // Middling: only wrong on the retry path, and only for the count.
  {
    filename: "src/server/sync.ts",
    status: "modified",
    changes: 6,
    patchSource: "github",
    patch: `@@ -40,7 +40,7 @@ export async function syncBatch(rows: Row[]) {
   for (const row of rows) {
     try {
       await push(row);
-      synced += 1;
+      attempted += 1;
     } catch (err) {
       failed.push(row.id);
     }
   }
-  return { synced, failed };
+  return { synced: attempted, failed };
 }`,
  },
  // Minor: the message names the wrong field. Nothing breaks.
  {
    filename: "src/server/validate.ts",
    status: "modified",
    changes: 4,
    patchSource: "github",
    patch: `@@ -11,7 +11,7 @@ export function validateProfile(input: Profile) {
   if (!input.displayName) {
-    return { ok: false, error: "displayName is required" };
+    return { ok: false, error: "username is required" };
   }
   return { ok: true };
 }`,
  },
];

const result = await generateChunkedReview([files], {
  prTitle: "Invoice lookup cleanup, sync counters, validation messages",
  prBody: "Small maintenance pass across the server helpers.",
  deadlineAt: Date.now() + 300_000,
});

const spread = result.findings.reduce<Record<string, number>>((acc, f) => {
  acc[f.severity] = (acc[f.severity] ?? 0) + 1;
  return acc;
}, {});

console.log(`\nfindings=${result.findings.length}  spread=${JSON.stringify(spread)}\n`);
for (const f of result.findings) {
  console.log(`[${f.severity.toUpperCase()}] ${f.file}:${f.line ?? "?"} — ${f.title}`);
}

const distinct = Object.keys(spread).length;
const blocking = (spread.high ?? 0) + (spread.critical ?? 0);
console.log(`\ndistinct severity levels: ${distinct}`);
console.log(`would fail the build: ${blocking} finding(s)`);
console.log(distinct >= 2
  ? "PASS: severities are spread, not flattened to one level"
  : "FAIL: every finding got the same severity");
