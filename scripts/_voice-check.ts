/**
 * Runs the real review path (generateChunkedReview, real prompt, real model
 * config from .env) against a real hunk, and prints the findings as the
 * author would receive them. Verifies tone, severity calibration and the
 * false-positive guards — not detection rates.
 *
 *   npx tsx scripts/_voice-check.ts
 */
import "dotenv/config";
import { generateChunkedReview } from "@/lib/ai/review";
import type { PullRequestFile } from "@/lib/github/diff";

const files: PullRequestFile[] = [
  // Real bug: the expiry guard and the rounding are both gone.
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
  // Not a bug: a long prose string literal. This is the exact shape that made
  // the reviewer report "PR description accidentally committed into source
  // code" as a blocking HIGH on PR #99.
  {
    filename: "src/lib/ai/prompt.ts",
    status: "modified",
    changes: 14,
    patchSource: "github",
    patch: `@@ -3,6 +3,20 @@ export const SUPPORT_PROMPT = \`You are a support agent.
+
+Answer the customer's question directly in the first sentence. Do not open
+with pleasantries or restate their question back to them.
+
+Never do any of the following:
+- promise a refund you have not confirmed is available
+- speculate about when a shipment will arrive
+- share another customer's order details
+
+If you cannot answer from the order record you were given, say so and hand
+off to a human rather than guessing. A confident wrong answer costs more
+than an admitted gap.
+
+Keep replies under four sentences unless the customer asked for detail.
+\`;`,
  },
];

const result = await generateChunkedReview([files], {
  prTitle: "Simplify discount application, tune support prompt",
  prBody: "Cleaning up the pricing helper and rewriting the support agent prompt.",
  deadlineAt: Date.now() + 300_000,
});

const bySeverity = result.findings.reduce<Record<string, number>>((acc, f) => {
  acc[f.severity] = (acc[f.severity] ?? 0) + 1;
  return acc;
}, {});

console.log(`\ncalls=${result.usage.calls} tokens=${result.usage.totalTokens} findings=${result.findings.length}`);
console.log(`severity spread: ${JSON.stringify(bySeverity)}\n`);
for (const finding of result.findings) {
  console.log(`--- [${finding.severity}/${finding.category}] ${finding.file}:${finding.line ?? "?"}`);
  console.log(`TITLE: ${finding.title}`);
  console.log(`BODY:  ${finding.explanation}`);
  if (finding.suggestion) console.log(`FIX:   ${finding.suggestion}`);
  console.log();
}

const promptFalsePositive = result.findings.filter((f) => f.file.includes("prompt.ts"));
console.log(promptFalsePositive.length === 0
  ? "PASS: no finding invented against the prose string literal"
  : `FAIL: ${promptFalsePositive.length} finding(s) against the prose string literal`);
