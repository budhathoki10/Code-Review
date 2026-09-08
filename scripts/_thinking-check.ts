/**
 * Proves what the review call actually sends for reasoning, by inspecting the
 * params the real code builds rather than trusting the env value.
 *
 *   npx tsx scripts/_thinking-check.ts
 */
import "dotenv/config";
import { buildSharedParams } from "@/lib/ai/review";
import { PRIMARY_THINKING, VERIFIER_THINKING, ARBITER_THINKING, primaryStage, reasoningKwargs } from "@/lib/ai/models";

const shared = buildSharedParams();
console.log("review call (the one that runs by default):");
console.log(`  model            ${process.env.NVIDIA_MODEL}`);
console.log(`  sends            ${JSON.stringify(shared.chat_template_kwargs)}`);
console.log(`  request timeout  ${process.env.NVIDIA_REQUEST_TIMEOUT_MS}ms`);

console.log("\nstaged pipeline (only when REVIEW_MULTI_STAGE=true):");
console.log(`  primary   thinking=${PRIMARY_THINKING} sends ${JSON.stringify(reasoningKwargs(primaryStage().thinking))}`);
console.log(`  verifier  thinking=${VERIFIER_THINKING}`);
console.log(`  arbiter   thinking=${ARBITER_THINKING}`);

const ok = shared.chat_template_kwargs.thinking
  && shared.chat_template_kwargs.enable_thinking
  && PRIMARY_THINKING && VERIFIER_THINKING && ARBITER_THINKING;
console.log(`\nreasoning on everywhere: ${ok ? "YES" : "NO"}`);
process.exit(ok ? 0 : 1);
