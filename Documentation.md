# AI Code Review Platform — Project Documentation

**Author:** Kushal Budhathoki
**Document Type:** Technical reference + build history
**Primary Stack:** Next.js · MongoDB · Redis/BullMQ · NVIDIA NIM (OpenAI-compatible)
**Status:** Shipped and running. Phases 1–5 complete; Phase 6 largely complete (see §17).

> **How to read this document.** Part I describes the system **as it actually
> exists today** — schemas, pipeline stages, limits, and configuration, with
> file references you can open. Part II preserves the original build-order
> plan, which is now history: it explains *why* the system is shaped the way
> it is, and several of its Phase 6 items are still open.
>
> The original version of this document was written before development and
> described a plan. Where the plan and the code disagreed, the code won and
> this document was corrected.

---

## Table of Contents

**Part I — The system as built**

1. [Project Overview](#1-project-overview)
2. [System Architecture](#2-system-architecture)
3. [Technology Stack](#3-technology-stack)
4. [Data Model (MongoDB)](#4-data-model-mongodb)
5. [Authentication Model — GitHub App](#5-authentication-model--github-app)
6. [The Review Pipeline, Stage by Stage](#6-the-review-pipeline-stage-by-stage)
7. [The AI Call Architecture](#7-the-ai-call-architecture)
8. [Large-PR Handling](#8-large-pr-handling)
9. [Incremental Reviews](#9-incremental-reviews)
10. [Static Analysis](#10-static-analysis)
11. [Configuration — Two Surfaces](#11-configuration--two-surfaces)
12. [Replies and Chat](#12-replies-and-chat)
13. [Cost, Metrics and Observability](#13-cost-metrics-and-observability)
14. [Environment Variables](#14-environment-variables)
15. [Security and Reliability Principles](#15-security-and-reliability-principles)

**Part II — Build history**

16. [Build Order — Why This Sequence](#16-build-order--why-this-sequence)
17. [Phases 1–6 — Original Plan and Outcome](#17-phases-16--original-plan-and-outcome)
18. [What's Still Open](#18-whats-still-open)
19. [Learning Roadmap](#19-learning-roadmap)

---

# Part I — The system as built

## 1. Project Overview

A GitHub App that reviews pull requests automatically. When a PR is opened or
updated, the system fetches the diff, runs deterministic static analysis and a
bounded AI review over it, and posts structured feedback back to the pull
request — a summary comment, inline per-line comments, committable suggested
fixes, and a check run that can gate the merge.

> **Design principle:** AI is not the whole product. The backend receives
> events reliably, deduplicates them, decides what is worth reviewing, bounds
> what the review may cost, and safely publishes the result. The model is one
> component inside that system, and it is the component treated with the least
> trust — everything it returns is schema-validated, size-bounded, and
> reconciled against deterministic checks before anyone sees it.

Three properties the implementation holds to throughout, each of which cost
real design effort:

- **Nothing is silently dropped.** A file the budget could not reach, a chunk
  the model failed on, a finding that could not be mapped to a line — each is
  disclosed in the posted comment rather than quietly omitted.
- **Size never fails a review.** An oversized PR is filtered, ranked and
  chunked. It only bails out when a review would be actively *misleading*
  about what it examined, and it says so when it does.
- **Cost is bounded before it is spent, not measured after.** The size gate
  projects token spend from chunk sizes and refuses before the first call.

---

## 2. System Architecture

```
                    GitHub — OAuth login, App installation, PR + comment events
                                            │
                                            ▼
                    Next.js App — auth, dashboard, webhook endpoint
                                            │
                    ┌───────────────────────┼───────────────────────┐
                    ▼                       ▼                       ▼
             MongoDB                Redis / BullMQ            Dashboard UI
          (persistence)        review · reply · throttle    (history, stats,
                                      queues + PR lock         settings)
                                            │
                                            ▼
                          Worker  (src/worker/review-worker.ts)
                                            │
              ┌─────────────────────────────┼─────────────────────────────┐
              ▼                             ▼                             ▼
      Static analysis              AI review engine              GitHub publishing
   (9 linters + secret scan)   (2-call split, tool loop,      (summary comment, inline
                             chunking, bisect retry)        comments, suggestions,
                                                                  check run)
```

**Three BullMQ queues, not one:**

| Queue | File | Purpose |
|---|---|---|
| `review` | `src/lib/queue/review-queue.ts` | The main review job, one per PR head SHA |
| `reply` | `src/lib/queue/reply-queue.ts` | Answering a developer's reply to a finding |
| `throttle` | `src/lib/queue/throttle-queue.ts` | Debounces rapid pushes to one PR into a single trailing review |

Plus a Redis-backed **per-PR lock** (`src/lib/queue/pr-lock.ts`) that
serializes reviews of the same PR. Without it, two pushes could be reviewed
concurrently and race the incremental path's "find the last completed review"
lookup. The lock renews itself while a review is genuinely running, so the TTL
is only a ceiling for a crashed holder.

---

## 3. Technology Stack

| Layer | Choice | Notes |
|---|---|---|
| Application framework | Next.js (App Router) | Dashboard, auth, and the webhook endpoint in one app |
| Database | MongoDB | Five collections; findings embedded in reviews |
| Authentication | GitHub App (user-to-server OAuth) | Login and repo access are the same identity |
| Queue / background jobs | Redis + BullMQ | Three queues plus a distributed per-PR lock |
| AI provider | **NVIDIA NIM**, OpenAI-compatible chat completions | Default model `nvidia/nemotron-3-ultra-550b-a55b`; accessed through the `openai` SDK pointed at `NVIDIA_BASE_URL`. *(The original plan named Claude; the implementation uses NVIDIA NIM.)* |
| Structured output | OpenAI-style tool calling + Zod | The model never returns free JSON — it calls a typed tool, and the arguments are Zod-parsed |
| GitHub integration | GitHub App via Octokit | Installation-scoped tokens |
| Static analysis | ESLint (+typescript-eslint), Biome, oxlint, markdownlint, Stylelint, HTMLHint, actionlint, Squawk, Buf, plus a regex secret scan | All in-process or npm-shipped launchers — no OS-level binaries in the deploy image |
| Logging | pino | Structured, with `reviewId` traceable end to end |

---

## 4. Data Model (MongoDB)

Five collections. Findings are **embedded** in their parent review since they
are always read and written together; installations, repositories and pull
requests are referenced separately because dashboard views query them
independently.

Source of truth: `src/lib/db/collections.ts`.

### `installations`

```js
{ _id, githubInstallationId, githubUserId, accountLogin, createdAt }
```

### `repositories`

```js
{
  _id,
  installationId,          // ref → installations._id
  githubInstallationId,
  githubRepoId,
  fullName,
  config: {                                  // set from the dashboard
    severityThreshold,                       // info | low | medium | high | critical
    customInstructions: [],                  // free-text lines injected into the prompt
    disabledCategories: []                   // security | bug | performance | quality | testing
  }
}
```

### `pull_requests`

```js
{
  _id,
  repositoryId,            // ref → repositories._id
  githubPrNumber,
  githubPrId,
  title,
  headSha,
  body,                    // kept in sync so a debounced trailing review still has PR context
  lastReviewedSha          // base of the next incremental diff — see §9
}
```

### `reviews`

The document that grew the most beyond the original plan. Everything below
`findings` exists to answer a question the first version could not.

```js
{
  _id,
  pullRequestId,
  headSha,                 // idempotency key, with pullRequestId
  status,                  // pending | completed | failed
  verdict,                 // approve | request_changes | comment
  summary,
  score,
  createdAt,

  findings: [{
    severity, category, file, line,
    title, explanation, suggestion, confidence,
    source,                // absent = "ai"; set only for static-analysis findings
    githubCommentId,       // the inline comment this was posted as
    originalLine,          // the "before" text, for committable suggestions
    originalContext        // surrounding lines, for the dashboard's diff view
  }],

  touchedFiles: [],        // what THIS round's diff covered (the incremental delta)
  filteredFiles: [{ file, reason }],
                           // touched but never reviewed — noise, triage skip, or unobtainable.
                           // Not derivable from findings: "reviewed, clean" and
                           // "never reviewed" look identical without it.

  githubCommentId,         // set only once the summary comment posts
  checkRunId,              // so a retry PATCHes instead of creating a duplicate
  inlineCommentsPostedAt,  // so a retry doesn't post inline comments twice

  metrics: { … },          // what THIS review cost and covered — see §13
  aiCheckpoint: { … },     // the model's output, persisted before anything that can fail
  error: { message, attempts, failedAt },     // dead-letter record
  incomplete: { reason, detail, … }           // why a review stopped short — see §8
}
```

**Idempotency index (in `ensureIndexes`, called on cold start):**

```js
db.reviews.createIndex({ pullRequestId: 1, headSha: 1 }, { unique: true })
```

Insert-and-catch-duplicate-key is the dedup strategy, enforced at the database
layer rather than assumed away.

**`aiCheckpoint` deserves its own note.** BullMQ retries a failed job up to
three times and a retry re-runs the pipeline from the top. Without the
checkpoint, a Mongo blip *after* the model calls would re-spend the entire
token budget, making the true worst case per PR event three times the
per-attempt ceiling. It is keyed implicitly by `(pullRequestId, headSha)` — the
same pair as the unique index — so it can only ever be reused for the commit
that produced it.

### `usage`

Global and per-period token counters, plus `estimateCost()` against
`AI_INPUT_COST_PER_MTOK` / `AI_OUTPUT_COST_PER_MTOK`.

---

## 5. Authentication Model — GitHub App

A single **GitHub App** handles both login and repository access.

| Token type | Used for | Obtained via |
|---|---|---|
| User-to-server | Dashboard login — who is this user, which installations can they see | "Sign in with GitHub" |
| Installation | Server-to-server — fetching diffs and file contents, posting comments, check runs | App ID + private key + `installation_id` |

**Required repository permissions:**

- Contents: **Read-only** — diffs, file contents for `fetch_file` and static analysis, `.prsentry.yaml`
- Pull requests: **Read & write** — summary comment, inline review comments, replies
- Checks: **Read & write** — the check run that can gate a merge
- Metadata: Read-only

**Subscribed webhook events** (all three are required; the app degrades
silently without the last two):

| Event | Why |
|---|---|
| `pull_request` | Opens, pushes, and completed merges — the main review trigger |
| `issue_comment` | The `@prsentry review --force` override on a bailed-out PR |
| `pull_request_review_comment` | Replies to an inline finding — see §12 |

> **Deployment note.** `@prsentry review --force` requires the `issue_comment`
> subscription. Without it the command is silently inert — nothing in the code
> can detect a webhook that was never delivered.

Multiple GitHub accounts can be linked to one dashboard user, and repos added
to an installation after setup are tracked automatically.

---

## 6. The Review Pipeline, Stage by Stage

`src/lib/review/pipeline.ts` — the orchestrator. A single job runs these in
order.

```
 1. Webhook: verify HMAC signature → rate-limit → enqueue → respond 200
 2. Throttle: debounce rapid pushes to one PR into a single trailing review
 3. Worker picks up the job → acquires the per-PR lock
 4. Load repo config (Mongo) and .prsentry.yaml (head commit)
 5. Fetch the diff — incremental from lastReviewedSha if a previous review exists
 6. Filter + triage + rank + chunk  (selectDiffForReview)
 7. Size gate: coverage and projected cost. Bail out with an explanation, or continue
 8. Create the check run early, so the PR shows "review in progress"
 9. Start static analysis; bounded-race it (8s) so the AI gets its findings as context
10. AI review — chunked, two concurrent call types, bounded tool loop
11. Persist aiCheckpoint immediately — everything after this point is now cheap to retry
12. Merge findings: carried-forward + AI + static, minus disabled categories
13. Detect resolved findings from the previous round
14. Write the review; update lastReviewedSha
15. Post/edit the summary comment; post inline comments and suggestions
16. Complete the check run
17. Record metrics and usage
```

Stages 15–17 are wrapped so a posting failure never triggers a BullMQ retry —
the expensive work is already done and durable by stage 11.

---

## 7. The AI Call Architecture

`src/lib/ai/review.ts`.

### Two call types, run concurrently

A single call producing findings *and* a prose summary is roughly as slow as
the sum of both, because an autoregressive model's latency scales with total
output tokens. Splitting them collapses wall-clock time toward the max instead
of the sum.

| Tool | Produces | Shape |
|---|---|---|
| `submit_findings` | The findings array | A bounded multi-turn loop |
| `submit_verdict` | `verdict` + prose summary | One forced call |

Both receive the same user message, built by `buildDiffBlock`: the diff, the PR
title and description, the static-analysis findings ("already reported, do not
repeat these"), any disabled categories, and the repo's custom instructions.

### `reconcileVerdict` — the safety net

The verdict call never sees the findings list; it reads the diff itself. So if
it independently says `approve` while the findings call surfaced a
critical/high finding, the verdict is **deterministically** upgraded to
`request_changes`. The posted comment can never contradict itself.

### The bounded investigation loop

The findings side can call `fetch_file(path)` to read a file's full content at
the PR head — a function's whole body, a type it references — when the diff
hunk alone isn't enough to confirm a finding.

| Bound | Value | Why |
|---|---|---|
| `MAX_FINDINGS_TOOL_ROUNDS` | 3 | The 4th round forces `submit_findings`, so termination is structural, not hoped for |
| `MAX_FETCH_FILE_CALLS` | 5 distinct files **per review** | A failed attempt still counts, so a bad guess can't be retry-spammed |
| `MAX_FETCHED_FILE_CHARS` | 20,000 per file | Truncated beyond that |

It is fail-safe by construction: `getFileContent` returns `undefined` rather
than throwing, so a nonexistent path becomes an error string the model can
adapt to, never a crash. Path traversal (`..`, leading `/`) is rejected. The
file cache is shared across every chunk and every bisect retry of one review —
it is a per-review budget, as the prompt promises, not a per-chunk one.

**Cost:** up to 4 findings calls + 1 verdict call = **5 provider calls** for a
single-diff review, up from 2. The chunked path's arithmetic ceiling is 65, and
`tests/unit/chunked-review.test.ts` asserts it rather than trusting the
estimate.

Deliberately *not* built: a `search_repo` tool. GitHub's code-search API has a
strict rate limit and lags newly-pushed commits, so a search right after a PR's
head commit can return stale, misleading results.

---

## 8. Large-PR Handling

`src/lib/review/diff-selection.ts`, `triage.ts`, `gate.ts`.

Size never fails a review. Four mechanisms run before the model is called.

### 1. Noise filtering

Lockfiles, `node_modules`/`dist`/`build`/`vendor`, minified bundles, source
maps, generated files, test snapshots, and binary assets are dropped before any
size is measured. A 100-file PR is frequently ~60 real files afterwards, and
removing them improves review quality at *every* size.

### 2. Cheap triage

Files whose diff is only whitespace, only comments, only import reordering, or
that carry a `@generated` marker are skipped without a model call. Documentation
is kept but deprioritized.

### 3. Ranking and chunking

What survives is ranked source-first (tests second, docs/config last) and
packed into chunks:

| Constant | Value |
|---|---|
| `MAX_DIFF_FILES` (per chunk) | 40 |
| `MAX_DIFF_CHARS` (per chunk) | 100,000 |
| `MAX_REVIEW_CHUNKS` | 4 |
| **`REVIEW_CAPACITY`** | **160 files / 400,000 chars** |

Chunking rather than one-call-per-file is the cheaper design: a chunk amortizes
the ~1,000 tokens of system prompt, tool schemas and PR metadata across up to 40
files. On a 100-file PR that is ~3 prompts' overhead instead of ~100.

Only the **first** chunk pays for a verdict call — the summary describes the PR
as a whole, so running it per chunk would buy N near-duplicate summaries and
throw away all but one. The verdict is then re-reconciled against the *merged*
findings, so a critical bug found in chunk 3 still overrides chunk 1's
"approve".

### 4. Failure isolation by bisecting

A chunk is up to 40 files in one prompt, and the findings pass either validates
for the whole chunk or throws. `runFindingsWithBisect` splits a failed chunk in
half and retries each half, halving again until it reaches single files.

Splitting is **by file, never by text offset** — half a unified diff is not a
diff, and a patch cut mid-hunk would produce confident findings about lines
that don't exist. A single file that still fails is named in `unreviewedFiles`
and disclosed in the comment. `REVIEW_MAX_BISECT_ATTEMPTS` (12) is shared across
the whole review, so a provider outage can't walk the entire tree.

### 5. The size gate — the only thing that bails

`evaluateSizeGate` refuses a review in exactly these cases:

| Reason | Trigger |
|---|---|
| `un-enumerable` | GitHub can't list the PR's files — its endpoint stops at 3,000 (`GITHUB_MAX_PR_FILES`), so nothing downstream can be trusted to be complete |
| `coverage-too-low` | File coverage below `REVIEW_MIN_COVERAGE` (0.5) or char coverage below `REVIEW_MIN_CHAR_COVERAGE` (0.1) |
| `cost-ceiling` | Projected tokens above `REVIEW_MAX_ESTIMATED_TOKENS` (250,000), warned at 60% |
| `too-many-files` / `too-many-changed-lines` | The repo's own stricter `.prsentry.yaml` cutoffs |
| `rate-limited` | GitHub rate limit didn't clear — retryable, unlike the others |

The two coverage dimensions are gated separately on purpose: a file never
*reached* is a lie about what was reviewed, while a file *opened and truncated*
is a disclosable limitation. Holding both to 50% refused single enormous files
the pipeline handles fine.

A bail-out posts a comment explaining the real numbers and offers the override:

```
@prsentry review --force
```

> **A correction worth preserving.** This originally gated on a fixed 8,000
> changed-line default applied to every repo. That was wrong and measurably so:
> it refused a 100-file / 20,000-line PR of entirely real code — the PR most
> worth reviewing — while passing a same-sized PR that was 95% lockfile churn,
> because it measured the diff GitHub reported instead of the work this
> pipeline can actually do. `max_files` and `max_changed_lines` now have **no
> default**; they exist only to be *stricter* than `REVIEW_CAPACITY`.

---

## 9. Incremental Reviews

Every push used to re-review the entire diff from scratch. Now:

1. `PullRequestDoc.lastReviewedSha` records how far the PR has been reviewed.
2. On a new push, `getIncrementalDiff` diffs from that SHA forward rather than
   from the PR base.
3. `filterCarriedForwardFindings` keeps still-open findings from files this
   push did **not** touch — they remain in the stored review and can still fail
   the check run, but are not re-announced in the comment every round.
4. `findResolvedFindings` reports what the previous round flagged and this round
   no longer does, so a review that says nothing about a fixed issue is
   distinguishable from one that forgot about it.

Carried-forward findings are deliberately **not** re-mapped to line numbers:
they were resolved against an earlier commit's diff, and looking them up in
this one would pair a suggestion with whatever text now occupies that number. A
confidently wrong "before" line is worse than none.

---

## 10. Static Analysis

`src/lib/review/static-analysis.ts`. Runs on files fetched at `headSha` — the
diff patch alone isn't parseable source.

| File type | Tools |
|---|---|
| `.js .jsx .ts .tsx .mjs .cjs` | ESLint + typescript-eslint, Biome, **and** oxlint — three linters, results deduplicated |
| `.json` | Biome |
| `.md .mdx` | markdownlint |
| `.css .scss .less` | Stylelint |
| `.html .htm` | HTMLHint |
| `.github/workflows/*.yml` | actionlint |
| `.sql` | Squawk |
| `.proto` | Buf |
| *every* supported file | Regex secret scan |

Three JS linters run because each has rules the others lack; ESLint runs
in-process while Biome and oxlint spawn subprocesses concurrently, halving the
blocked window. Overlap is the price, so the merged list is deduplicated rather
than concatenated — otherwise one bad escape posts three times.

**Bounds and guarantees:**

- `MAX_FILES` = 15, `MAX_FINDINGS` = 10 per review.
- Findings are restricted to lines **actually in the diff**, so pre-existing
  issues outside the PR's changes are never flagged.
- Every failure mode — fetch error, parse error, a misbehaving external binary —
  is swallowed per file. Static analysis is a bonus signal, never a reason to
  fail a review.
- Static analysis reads `analyzableFiles`, **not** the chunk selection: linters
  have no context window and no per-token cost, so the AI's size budget must
  never shrink their coverage. A file the AI had no room for still gets linted.
- Its findings are fed to the model as "already reported — don't repeat these",
  bounded by `STATIC_ANALYSIS_CONTEXT_TIMEOUT_MS` (8s) so a slow run degrades
  to "the AI didn't see them this once" rather than blocking. The final posted
  list always waits for the real result regardless.

Several plausible npm packages were deliberately **rejected** rather than
wired in — `shellcheck` (a critical vuln in its postinstall dependency),
`prisma-lint` (unfixed lodash vuln), and a set of name-squatted packages
(`clippy`, `pmd`, `regal`, `golangci-lint`) that are unrelated to the tools they
appear to be. The reasoning is recorded in the file's header comment.

---

## 11. Configuration — Two Surfaces

A repo can be configured from the dashboard or from a file in the repo. **The
two combine; neither overrides the other.**

### Dashboard — Review settings

`RepositoryDoc.config`, edited at `/dashboard/repos/[id]`, stored in Mongo,
applied from the very next review.

| Setting | Effect |
|---|---|
| `severityThreshold` | A **floor**. Findings below it aren't posted to GitHub (they still show on the dashboard). Also gates the check run — unset, posting defaults to `info` and the gate to `high` |
| `customInstructions` | Free-text lines injected into the prompt |
| `disabledCategories` | Per-category on/off switches |

### Repo file — `.prsentry.yaml`

Read from the head commit. Absent is the normal case.

```yaml
version: 1
reviews:
  path_filters:
    - "!**/generated/**"
  disabled_categories:
    - testing
  max_files: 150
  max_changed_lines: 8000
```

| Key | Effect |
|---|---|
| `path_filters` | Globs; leading `!` excludes. **Merged** with the built-in noise list, never replacing it — excluding your generated directory shouldn't opt you back into reviewing lockfiles |
| `disabled_categories` | Same five categories as the dashboard |
| `max_files`, `max_changed_lines` | Optional, no default. Only ever *stricter* than `REVIEW_CAPACITY` |

A malformed file **never fails a review.** Problems are collected, each naming
the offending key, and appended to the posted PR comment so the author can see
exactly what to fix. Unknown keys are reported, not fatal.

### Severity and category are independent axes

Severity answers *"how bad is it"*; category answers *"what kind of thing is
it"*. Neither can express the other — a repo that wants security findings and
nothing else can't get there by raising `severityThreshold`, because that drops
critical bugs along with the testing nits.

They also behave differently on purpose:

| | `severityThreshold` | `disabledCategories` |
|---|---|---|
| Applied | at posting time | **before the review is stored** |
| Hidden finding can still fail the check run | yes, deliberately | **no** |

A stale critical finding below the posting threshold must still be able to fail
a check. A category the repo switched off must not be able to fail anything.
Off means off, not hidden.

The two `disabled_categories` sources are **unioned** — a category either
surface turns off stays off. A precedence rule would mean one config silently
re-enabling what the other disabled, which is the exact surprise the control
exists to prevent. Disabling all five is rejected: that is a review that costs
full price and returns nothing.

---

## 12. Replies and Chat

A developer can reply to an inline finding and get an answer in the same
thread.

- `pull_request_review_comment` webhook → `reply` queue → `reply-pipeline.ts`.
- `findFindingByCommentId` maps a thread back to the finding it is about, via
  `FindingDoc.githubCommentId`. It searches **all** of the PR's reviews, not
  just the newest, because a thread stays open across later pushes — the
  question may be about a finding from two commits ago.
- `src/lib/ai/reply.ts` runs a separate, windowed AI call — not the review path.
- Bot-authored comments are excluded, or the app would answer itself forever.

---

## 13. Cost, Metrics and Observability

| Mechanism | What it answers |
|---|---|
| `usage` collection | "What have we spent in total?" |
| `ReviewMetrics` on each review | "What did **this** review spend, and on how much work?" — the question you need to find the review that burned 400k tokens |
| `REVIEW_TOKEN_CEILING` (300,000) | Logs a warning when a single review exceeds it |
| `incomplete.reason` | Why a review stopped short, answerable from the database rather than only from logs |
| `error` | Durable dead-letter record once retries are exhausted |
| `aiCheckpoint` | Makes a retry after the model calls nearly free |
| `filteredFiles` | Distinguishes "reviewed, clean" from "never reviewed" |
| `npm run usage` | CLI cost report (`scripts/usage.ts`) |

Every log line carries `reviewId`, so one review is traceable from webhook to
check run.

---

## 14. Environment Variables

`.env.example` documents the essentials. The full set read by the code:

**Required**

| Variable | Purpose |
|---|---|
| `AUTH_SECRET`, `AUTH_URL` | Auth.js |
| `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET` | Sign in with GitHub |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET` | Server-to-server + webhook verification |
| `MONGODB_URI`, `MONGODB_DB` | Database |
| `REDIS_URL` | BullMQ |
| `NVIDIA_API_KEY` | AI provider |

**Model**

`NVIDIA_BASE_URL`, `NVIDIA_MODEL`, `NVIDIA_TEMPERATURE` (0.7), `NVIDIA_TOP_P`
(0.95), `NVIDIA_MAX_TOKENS` (4096)

**Review sizing and cost**

`MAX_REVIEW_CHUNKS` (4), `REVIEW_CHUNK_CONCURRENCY` (2),
`REVIEW_MAX_BISECT_ATTEMPTS` (12), `REVIEW_MIN_COVERAGE` (0.5),
`REVIEW_MIN_CHAR_COVERAGE` (0.1), `REVIEW_MAX_ESTIMATED_TOKENS` (250,000),
`REVIEW_COST_WARN_RATIO` (0.6), `REVIEW_TOKEN_CEILING` (300,000),
`STATIC_ANALYSIS_CONTEXT_TIMEOUT_MS` (8000), `MAX_INLINE_COMMENTS` (25),
`MAX_GENERATED_PATCH_CHARS`, `MAX_PATCH_FALLBACKS`

**Concurrency and rate limiting**

`WEBHOOK_RATE_LIMIT_MAX` (20 — deliveries accepted per **repository** per
window, shared across every event type; a 429 drops the event),
`WEBHOOK_RATE_LIMIT_WINDOW_SECONDS` (60),
`AI_RATE_LIMIT_MAX` (10), `AI_RATE_LIMIT_DURATION_MS` (60000),
`REPLY_ACCEPT_RATE_LIMIT_MAX` (10) and `REPLY_ACCEPT_RATE_LIMIT_WINDOW_SECONDS`
(600) — questions *accepted* per PR at the webhook door;
`REPLY_WORKER_RATE_LIMIT_MAX` (20) and `REPLY_WORKER_RATE_LIMIT_DURATION_MS`
(60000) — how fast accepted jobs are *drained*;
`PR_REVIEW_LOCK_TTL_MS` (300000),
`PR_REVIEW_LOCK_RETRY_DELAY_MS` (3000), `PR_REVIEW_THROTTLE_WINDOW_MS` (60000),
`MAX_RATE_LIMIT_WAIT_MS`

> `AI_RATE_LIMIT_MAX` counts review **jobs started**, not provider calls. One
> job can make up to 5 calls on the single-diff path, so the effective call rate
> can reach 5× this value. Divide a provider RPM cap by 5 before tuning.

**Cost reporting, caching, cron, misc**

`AI_INPUT_COST_PER_MTOK`, `AI_OUTPUT_COST_PER_MTOK` (both default 0, which is
deliberate: a fabricated price looks authoritative on a dashboard, so the cost
cell is **hidden** rather than showing `$0.00` until real rates are set — see
`review-card.tsx`'s `estimatedCostUsd > 0` guard), `FILE_CONTENT_CACHE_BYTES`, `FILE_CONTENT_CACHE_ENTRIES`,
`CRON_SECRET`, `CRON_MAX_DURATION_MS`, `LOG_LEVEL`, `GITHUB_APP_SLUG`,
`DEV_TUNNEL_ORIGIN`

> **Reply limiting has two stages**, and they are named apart on purpose. The
> *accept* limit decides whether a question is queued at all; the *worker*
> limit decides how fast queued questions are answered. They previously shared
> the name `REPLY_RATE_LIMIT_MAX` while carrying different defaults in each
> place (10 and 20), so setting it moved both knobs and neither to the value
> the operator had read. The old names are still honoured as a fallback.

---

## 15. Security and Reliability Principles

Each of these is implemented, not aspirational.

- **Prompt injection defense.** Every prompt opens by declaring the diff to be
  data, not instructions (`INJECTION_DEFENSE`). Custom instructions are
  explicitly subordinated to that rule so a repo's own config can't be used to
  override it either.
- **AI output validation.** The model never returns free JSON — it calls a
  typed tool whose arguments are Zod-parsed. A known provider quirk
  (double-encoding an array argument as a JSON *string*) is unwrapped
  defensively, because it was deterministic per response and dead-lettered
  reviews that a retry could never fix.
- **Webhook verification.** HMAC-SHA256 on every payload before any processing.
- **Least privilege.** Contents read-only; no admin scope.
- **Idempotency.** Unique index on `(pullRequestId, headSha)`, plus BullMQ job
  IDs, plus `inlineCommentsPostedAt` and `checkRunId` so a retry edits rather
  than duplicates.
- **No repo clones.** Only individual files whose paths are already known are
  fetched, through the API.
- **Bounded everything.** Tool rounds, fetched files, chunks, bisect attempts,
  inline comments, projected tokens — each has a ceiling, and exceeding one is
  disclosed rather than silently truncated.
- **Failures are durable, not lost.** `error` and `incomplete` make "why did
  this PR never get a real review?" answerable from the database.

---

# Part II — Build history

## 16. Build Order — Why This Sequence

The project was built **UI-first, intelligence-last** — the reverse of a
typical backend-heavy order:

- Something visibly working and demoable exists after Phase 1, which gives a
  real shell to test everything else against.
- Auth and data modeling are foundational; every later phase depends on them.
- The AI and async pieces (Phases 2, 5) were the highest-uncertainty parts.
  Building the shell first meant friction with prompt design or BullMQ was
  isolated, not tangled up with debugging OAuth at the same time.
- A single summary comment (Phase 3) before inline comments (Phase 4) validated
  output quality against the simplest possible publishing target before adding
  line-mapping complexity.

That reasoning held up. The one thing the plan got wrong was scale: it assumed
a review was one model call on one diff, and most of the engineering since has
been about what happens when that assumption breaks.

## 17. Phases 1–6 — Original Plan and Outcome

| Phase | Delivered | Status |
|---|---|---|
| 1 | UI, GitHub login, App connect, MongoDB, dashboard shell | ✅ Shipped |
| 2 | AI generates validated findings | ✅ Shipped, then substantially rebuilt — see §7 |
| 3 | Findings posted as one summary comment | ✅ Shipped; the comment is now edited in place by ID |
| 4 | Inline, per-line comments | ✅ Shipped; plus committable suggestions and an overflow section |
| 5 | Processing moved to BullMQ | ✅ Shipped; grew to three queues plus a per-PR lock |
| 6 | Static analysis, config, analytics, hardening | ◐ Largely shipped — see below |

**Phase 6, item by item:**

| Item | Status |
|---|---|
| Static analysis merged with AI findings | ✅ 9 tools plus a secret scan, far past the planned "ESLint, Semgrep, npm audit" |
| Repository-level configuration | ✅ Two surfaces — §11 |
| Dependency-aware context retrieval | ✅ Shipped as the `fetch_file` tool loop — §7 |
| Structured logging, traceable job IDs | ✅ pino with `reviewId` throughout |
| Dead-letter handling | ✅ `error` + `incomplete` on the review doc |
| Rate limiting on webhook + AI | ✅ Both, plus reply and per-PR throttling |
| Repository analytics dashboard | ✅ `repo-stats.ts` — summaries, trends, overview |
| Usage tracking / AI cost | ✅ `usage` collection, `ReviewMetrics`, `npm run usage` |
| GitHub Checks API gating | ✅ Check run with severity-gated conclusion |
| Organizations/teams, billing, notifications | ❌ Not built |
| "Learning mode" explanations | ❌ Not built |
| Data retention settings | ❌ Not built |

## 18. What's Still Open

Three things, in the order they are worth doing:

1. **Judge pass.** A third, cost-gated model call that verifies findings
   against the diff before posting — keep only what the diff clearly supports,
   drop the speculative, add nothing. Gated to fire only on critical/high
   severity or more than 5 findings, so a clean review costs nothing extra. It
   would also strengthen `reconcileVerdict`, which would then escalate on a
   *verified* finding rather than a possibly-hallucinated one. Two known
   complications: a whole-PR judge call re-creates the context-size problem
   chunking exists to solve, and evidence gathered via `fetch_file` is invisible
   to a judge that only sees the diff, so it would delete correct findings
   unless the file cache is passed through.

2. **`.env.example` completeness.** Several variables the code reads are
   undocumented there — see §14.

3. **Memory / feedback learning.** Recording whether findings were fixed or
   dismissed, and feeding that back into future prompts. Deliberately
   **deprioritized**: the config surface in §11 already solves the same problem
   directly and instantly, and the hard part of memory is not storage but
   reliably distinguishing "the team rejected this advice" from "they shipped a
   real bug under deadline". Getting that wrong teaches the reviewer to stop
   reporting real bugs, which is worse than the noise it removes. Revisit only
   if noise persists after the judge pass, and only at a scale where nobody
   owns the tuning.

## 19. Learning Roadmap

| Level | Topics | Where it shows up |
|---|---|---|
| 1 | GitHub Apps vs OAuth Apps, installations, webhooks, signature verification | `github/app.ts`, `github/webhook.ts` |
| 2 | MongoDB schema design, embedding vs referencing | `db/collections.ts` |
| 3 | Git diff structure — hunks, line mapping | `github/diff-lines.ts`, `patch-fallback.ts` |
| 4 | Prompt design, tool calling, structured output, injection defense | `ai/review.ts` |
| 5 | GitHub Review/Comments API, diff-to-line mapping, suggestions | `github/inline-comments.ts`, `review-comments.ts` |
| 6 | Redis, BullMQ, workers, retries, distributed locks, idempotency | `queue/*` |
| 7 | Static analysis integration, aggregation pipelines, multi-tenancy | `review/static-analysis.ts`, `db/repo-stats.ts` |
| 8 | Cost control as a design constraint — budgets, gates, checkpoints, bisecting retries | `review/gate.ts`, `diff-selection.ts`, `ai/review.ts` |

> Level 8 wasn't in the original plan, and it is the part of this project that
> turned out to be most worth being able to explain. Anyone can call an LLM API.
> Deciding what *not* to send it, proving a worst case is bounded, and making a
> retry cheap are the parts that make it a system rather than a script.

---
