import pino from "pino";

/**
 * Server-only structured logger. Never import this from a Client Component —
 * pino must not ship in the browser bundle. `.child({ requestId })` at each
 * process boundary (webhook, worker, pipeline) keeps one review traceable
 * end to end through the logs.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } }
      : undefined,
});
