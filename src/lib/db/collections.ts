import type { Collection } from "mongodb";
import getMongoClient from "@/lib/mongodb";

export interface InstallationDoc {
  _id?: string;
  githubInstallationId: number;
  githubUserId: string;
  accountLogin: string;
  createdAt: Date;
}

/**
 * Running AI token totals across the WHOLE app — every review by every user
 * `$inc`s this one shared document, so reading total consumption is a single
 * point lookup. Deliberately not split per user and not a per-call ledger:
 * it's one global cost counter, so it can't attribute usage to a user or a
 * specific review — add a separate collection if that's ever needed.
 */
export interface UsageDoc {
  _id?: string;
  /** Always GLOBAL_USAGE_KEY — the fixed key making this a single shared row. */
  key: string;
  /** Prompt tokens sent to the provider (system prompts + tool schemas + diff, re-sent each findings round). */
  inputTokens: number;
  /** Completion tokens returned. */
  outputTokens: number;
  totalTokens: number;
  /** Individual provider calls — up to 5 per review (see generateReview). */
  calls: number;
  /** Reviews contributing to these totals — `calls / reviews` gives average calls per review. */
  reviews: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface RepositoryDoc {
  _id?: string;
  installationId: string;
  githubInstallationId: number;
  githubRepoId: number;
  fullName: string;
  config?: {
    /** Minimum severity that gets posted to GitHub and can fail the check run. Unset = post everything. */
    severityThreshold?: "info" | "low" | "medium" | "high" | "critical";
    customInstructions?: string[];
  };
}

export interface PullRequestDoc {
  _id?: string;
  repositoryId: string;
  githubPrNumber: number;
  githubPrId: number;
  title: string;
  headSha: string;
  /** Kept in sync with the PR body on every push so a throttle-debounced trailing review (see throttle-worker-factory.ts) still has it for AI context. */
  body?: string | null;
}

export interface FindingDoc {
  severity: "critical" | "high" | "medium" | "low" | "info";
  category: "security" | "bug" | "performance" | "quality" | "testing";
  file: string;
  line?: number;
  title: string;
  explanation: string;
  suggestion?: string;
  confidence?: string;
  /** Absent means "ai" — only set for findings produced by the deterministic static-analysis stage. */
  source?: "ai" | "static-analysis";
}

export interface ReviewDoc {
  _id?: string;
  pullRequestId: string;
  headSha: string;
  status: "pending" | "completed" | "failed";
  verdict?: "approve" | "request_changes" | "comment";
  summary?: string;
  score?: number;
  findings: FindingDoc[];
  createdAt: Date;
  /** Files this specific round's diff actually covered (the incremental delta, or every file on a first review) — lets the dashboard show only what changed *this round*, even though `findings` also carries forward still-open findings from untouched files for gating purposes. Absent on reviews created before this field existed. */
  touchedFiles?: string[];
  /** Set only once the Phase 3 summary comment successfully posts. Its absence on a
   *  "completed" review means generation succeeded but posting to GitHub hasn't (yet). */
  githubCommentId?: number;
  /** Set once a GitHub check run is created, so a retried job PATCHes it instead of creating a duplicate. */
  checkRunId?: number;
  /** Populated once retries are exhausted — the durable dead-letter record for a failed review. */
  error?: { message: string; attempts: number; failedAt: Date };
}

async function db() {
  const client = await getMongoClient();
  return client.db(process.env.MONGODB_DB);
}

export async function installations(): Promise<Collection<InstallationDoc>> {
  return (await db()).collection<InstallationDoc>("installations");
}

export async function repositories(): Promise<Collection<RepositoryDoc>> {
  return (await db()).collection<RepositoryDoc>("repositories");
}

export async function pullRequests(): Promise<Collection<PullRequestDoc>> {
  return (await db()).collection<PullRequestDoc>("pull_requests");
}

export async function reviews(): Promise<Collection<ReviewDoc>> {
  return (await db()).collection<ReviewDoc>("reviews");
}

export async function usage(): Promise<Collection<UsageDoc>> {
  return (await db()).collection<UsageDoc>("usage");
}

let indexesEnsured: Promise<void> | undefined;

/** Idempotent — safe to call on every cold start. */
export function ensureIndexes(): Promise<void> {
  if (!indexesEnsured) {
    indexesEnsured = (async () => {
      const [installationsCol, repositoriesCol, pullRequestsCol, reviewsCol, usageCol] =
        await Promise.all([
          installations(),
          repositories(),
          pullRequests(),
          reviews(),
          usage(),
        ]);

      await Promise.all([
        installationsCol.createIndex({ githubInstallationId: 1 }, { unique: true }),
        repositoriesCol.createIndex({ githubRepoId: 1 }, { unique: true }),
        pullRequestsCol.createIndex({ githubPrId: 1 }, { unique: true }),
        reviewsCol.createIndex({ pullRequestId: 1, headSha: 1 }, { unique: true }),
        // Unique so the recordUsage upsert always accumulates into the single
        // global document instead of racing concurrent reviews into duplicates.
        usageCol.createIndex({ key: 1 }, { unique: true }),
      ]);
    })();
  }
  return indexesEnsured;
}
