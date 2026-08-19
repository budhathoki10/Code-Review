import "dotenv/config";
import { createReviewWorker, AI_RATE_LIMIT_MAX, AI_RATE_LIMIT_DURATION_MS } from "@/lib/queue/review-worker-factory";
import { logger } from "@/lib/logger";

createReviewWorker();

logger.info(
  { concurrency: 5, aiRateLimit: `${AI_RATE_LIMIT_MAX}/${AI_RATE_LIMIT_DURATION_MS}ms` },
  "review worker started, waiting for jobs...",
);
