/**
 * Runs the real review path (generateChunkedReview, real prompt, real model
 * config from .env) against a real hunk, and prints the findings as the
 * author would receive them. Verifies tone and shape, not detection rates.
 *
 *   npx tsx scripts/_voice-check.ts
 */
import "dotenv/config";
import { generateChunkedReview } from "@/lib/ai/review";
import type { PullRequestFile } from "@/lib/github/diff";

const files: PullRequestFile[] = [
  {
    filename: "src/lib/cart/pricing.ts",
    status: "modified",
    changes: 12,
    patchSource: "github",
    patch: `@@ -14,10 +14,12 @@ export function applyDiscount(items: CartItem[], code: string) {
   const rule = DISCOUNT_RULES[code];
-  if (!rule) return items;
-  if (rule.expiresAt < Date.now()) return items;
+  if (!rule) return items;

   return items.map((item) => ({
     ...item,
-    price: Math.round(item.price * (1 - rule.percent / 100)),
+    price: item.price * (1 - rule.percent / 100),
   }));
 }`,
  },
];

const result = await generateChunkedReview([files], {
  prTitle: "Simplify discount application",
  prBody: "Cleaning up the pricing helper.",
  deadlineAt: Date.now() + 300_000,
});

console.log(`\ncalls=${result.usage.calls} tokens=${result.usage.totalTokens} findings=${result.findings.length}\n`);
for (const finding of result.findings) {
  console.log(`--- [${finding.severity}/${finding.category}] ${finding.file}:${finding.line ?? "?"}`);
  console.log(`TITLE: ${finding.title}`);
  console.log(`BODY:  ${finding.explanation}`);
  if (finding.suggestion) console.log(`FIX:   ${finding.suggestion}`);
  console.log();
}
