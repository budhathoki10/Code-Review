import "dotenv/config";
import { createReviewWorker, AI_RATE_LIMIT_MAX, AI_RATE_LIMIT_DURATION_MS } from "@/lib/queue/review-worker-factory";
import { logger } from "@/lib/logger";

// npm run worker......it creates a worker from review factory and wait for the job 
createReviewWorker();

logger.info(
  { concurrency: 5, aiRateLimit: `${AI_RATE_LIMIT_MAX}/${AI_RATE_LIMIT_DURATION_MS}ms` },
  "review worker started, waiting for jobs...",
);
