# Large-PR verification runbook

End-to-end verification for the large-PR pipeline (Phases 1–5 of `handlelargepr.md`).

**Why this exists:** unit tests missed three real bugs in this area — a `paginate` call that returns one object per page rather than concatenated rows, an `@octokit/plugin-paginate-rest` that was never wired in so `octokit.paginate` did not exist at all, and a "diff unavailable" path that reported to the logs but never to the author. All three passed a green suite. Mocks encode what we *believe* GitHub does; this runbook checks what it *actually* does.

Re-run this after any change to `diff.ts`, `file-content.ts`, `patch-fallback.ts`, `diff-selection.ts`, `triage.ts`, `gate.ts`, `config.ts`, or `pipeline.ts`.

---

## What is automated vs. manual

| Step | Automated? | How |
| --- | --- | --- |
| Environment preflight | Yes | `probe-env.mjs` |
| Webhook reachability | Yes | `probe-webhook.mjs` |
| Predicting expected numbers | Yes | `predict.ts` — runs the **real** selection/gate code |
| Creating fixture branches + PR | Yes | `create-pr.ts` (GitHub Git Data API, no clone) |
| **Triggering the review** | **No** | The PR *is* the trigger, but it needs a live webhook — see Step 0 |
| Waiting for the review | Yes | `run-scenario.ts` polls Mongo |
| Checking DB + comments + counts | Yes | `verify-review.ts` |
| Failure injection | Partly | Script arms it; killing the worker is manual (Scenario 7) |
| Reading the comment for tone/clarity | No | Human judgement — Scenario 6 especially |

Predictions come from importing `selectDiffForReview` / `evaluateSizeGate` directly. If you tune `MAX_DIFF_CHARS` or `REVIEW_MIN_COVERAGE`, the expected values move with it — nothing here restates those numbers as constants.

---

## Step 0 — Prerequisites (the part that actually breaks)

The review is triggered by a GitHub webhook, so **GitHub must be able to reach your webhook endpoint.** This is the single most common reason a scenario appears to "do nothing".

```bash
node tests/manual/scripts/probe-env.mjs        # credentials, Mongo, Redis
node tests/manual/scripts/probe-webhook.mjs    # webhook URL + reachability
```

`probe-webhook.mjs` also prints recent delivery statuses. If you see `failed to connect to host (502)`, nothing downstream will run.

Bring up all three processes:

```bash
# 1. public tunnel to localhost:3000
cloudflared tunnel --url http://localhost:3000

# 2. set the App's webhook URL to <tunnel>/api/github/webhook
#    (GitHub → Settings → Developer settings → GitHub Apps → your app)

# 3. web + worker
npm run dev          # Next.js, serves the webhook route
npm run worker       # BullMQ worker — the reviews actually run here
```

Watch the worker's logs throughout; they carry `diff fetched`, `diff selected for review`, `projected review cost`, and `review metrics`.

**Known gap:** the App is currently subscribed only to `pull_request`. `@prsentry review --force` needs **Issue comments** added to the subscription, or the command is silently inert — no code path can detect a webhook that was never delivered.

### Choose a target repo

Use a throwaway repo the App is installed on. **Do not** point this at a repo whose PR list you care about: each scenario opens a real PR and pushes two branches.

```bash
export VERIFY_REPO=budhathoki10/Test
```

### Cost warning

These are real model calls against real tokens. Run `predict.ts` first — it prints projected token spend per scenario. Scenario 1 is the expensive one.

---

## Running a scenario

```bash
# See what should happen, before spending anything
npx tsx tests/manual/scripts/predict.ts 1

# Create the PR (this triggers the review, if the webhook is live)
npx tsx tests/manual/scripts/create-pr.ts 1 $VERIFY_REPO

# Check everything once the comment appears
npx tsx tests/manual/scripts/verify-review.ts 1 $VERIFY_REPO <prNumber>
```

`verify-review.ts` exits non-zero on any failed check, so it can gate CI later.

### What every scenario checks

`verify-review.ts` asserts all of these automatically:

- **Inline comment count ≤ 25**, with `<details>` overflow in the summary when the cap was hit.
- **Gaps stated plainly** — if anything was filtered, truncated, budget-skipped, or unreviewable, the summary must say so in words. Checked against the phrases the code actually emits.
- **One review event**, not one per comment.
- **DB record vs. chunk math** — `metrics.calls` within the predicted range, `metrics.totalTokens` within 3× the projection, `filesSeen` exact, `commentsPosted` matching GitHub's actual count.
- **Wall clock** — pipeline `durationMs` plus queued-to-comment elapsed time.
- **Bail expectation** — `incomplete.reason` present or absent as the scenario requires.

A **call-count or token mismatch is the signal to investigate**, not a rounding artifact. The prediction comes from the same code the pipeline runs; a divergence means the pipeline took a path the selection logic did not anticipate.

---

## Scenario 1 — 90 files, entirely legitimate code

The case the old fixed 8,000-changed-line cutoff wrongly refused. Nothing filters out.

**Expect:** review proceeds, 100% coverage, 3 chunks, ~4 LLM calls (up to 13), ~82k tokens.

Additional manual checks:
- Open the PR. Are inline comments attached to sensible lines, or clustered on line 1? Mis-anchored comments mean the hunk parser drifted.
- Does the summary read like a review, or like a size report?

## Scenario 2 — same size, noise mixed in

60 real files + a 400-entry lockfile bump + a `.generated.ts` file + 20 files under `dist/`.

**Expect:** 22 files filtered, 60 reviewable, review proceeds, ~3 calls.

Additional manual checks:
- The summary must name the skip **reasons** (generated/vendored/binary), not just a count.
- Confirm no lockfile or `dist/` content appears in any finding — if it does, the noise filter has a hole.

## Scenario 3 — one file, diff big enough for `patch: null`

**Check the raw API first — this is the assumption mocks cannot verify:**

```bash
gh api repos/$VERIFY_REPO/pulls/<n>/files --jq '.[] | {filename, patch: (.patch // "NULL"), changes}'
```

If `patch` is not `NULL`, the fixture is too small and the scenario is testing nothing — increase the size in `fixtures.ts`.

**Expect:** the file **is reviewed**, at ~15% character coverage, with the truncation disclosed. Its diff is ~400k chars; the local reconstruction truncates to `MAX_GENERATED_PATCH_CHARS` (60k), so most of the content is unreadable — but the file *was* opened, which is a disclosable limitation rather than grounds to post nothing.

The gate separates the two kinds of gap: a **file the budget never reached** trips the 50% floor (`REVIEW_MIN_COVERAGE`), while a **file that was opened but truncated** only trips a much lower floor (`REVIEW_MIN_CHAR_COVERAGE`, 10%) below which a review is theatre. Verify the gate's `warnings` mention truncation.

Additional manual checks:
- The summary must disclose that the file was only partially read.
- The file must be named. It must never simply be absent.
- If you raise `MAX_GENERATED_PATCH_CHARS`, coverage rises and the warning should disappear.

## Scenario 4 — 2-line follow-up push

Run scenario 4's PR, **wait for the first review to complete**, then:

```bash
npx tsx tests/manual/scripts/create-pr.ts 4 $VERIFY_REPO --follow-up <headBranch>
```

**Expect on the second review:** ~2 LLM calls, tokens a small fraction of the first.

```bash
# Compare the two review rows
npx tsx tests/manual/scripts/compare-reviews.ts $VERIFY_REPO <prNumber>
```

Additional manual checks:
- `pull_requests.lastReviewedSha` should equal the first review's head SHA before the second push.
- The summary comment should be **edited in place**, not duplicated.
- If the follow-up fixed something, the summary should say findings look resolved.

## Scenario 5 — 400 files of pure build output

**Expect: zero LLM calls.** `metrics.calls === 0` and `metrics.totalTokens === 0`.

This is *not* a bail-out — it is "nothing to review". Both post a comment; only one is a refusal. If `metrics.calls > 0`, the noise filter failed and the bot paid for build output.

## Scenario 6 — 330 files, sized just under the coverage floor

**Expect:** bail with `coverage-too-low`.

This scenario exists to read the message, so read it:
- Does it state files changed, files after filtering, capacity, and projected cost?
- Does it offer `@prsentry review --force`?
- Would an author understand *why* without reading the source? If not, the message needs work even though the check passes.

## Scenario 7 — failure injection (the one that needs a human)

`tests/unit/pipeline-retry.test.ts` now covers the decision logic automatically: it drives the real `runReviewPipeline` against in-memory fakes, fails the write immediately after generation, and asserts the retry does not call the model again. Run it first — `npx vitest run tests/unit/pipeline-retry.test.ts`.

What that test cannot prove is that the checkpoint survives a **process kill** (BullMQ stall recovery, Redis lock expiry, a half-written Mongo document). That still needs a human:

1. Start scenario 1 and watch the worker log.
2. When you see `ai token usage` — the model calls are done, the checkpoint has just been written — kill the worker:
   ```bash
   # Ctrl+C is a graceful shutdown; use a hard kill to simulate a crash
   taskkill /F /IM node.exe        # Windows
   ```
3. Restart `npm run worker`. BullMQ will re-deliver the stalled job.
4. **Watch for:** `reusing the model output from a previous attempt — skipping generation`.

**Pass:** that line appears, and the second attempt makes **zero** new provider calls.
**Fail:** the worker logs `running static analysis, then calling the model...` again — the checkpoint did not persist or is not being read, and every retry costs full price.

Then confirm in the DB:

```bash
npx tsx tests/manual/scripts/check-checkpoint.ts $VERIFY_REPO <prNumber>
```

A cheaper variant that does not require timing the kill: temporarily make comment posting fail (point `postSummaryComment` at a bad URL, or revoke the App's write permission) and confirm the job still completes without retrying — posting failures are caught and must **never** trigger a re-review.

---

## Cleanup

```bash
npx tsx tests/manual/scripts/cleanup.ts $VERIFY_REPO
```

Closes every `[verify]` PR and deletes every `verify/*` branch. Leaves the DB rows alone — they are the evidence.

---

## Recording results

Copy this table into the PR or issue where you're tracking a change:

| Scenario | Calls (pred / actual) | Tokens (pred / actual) | Inline | Coverage stated? | Wall clock | Result |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 4 / | ~82k / | | | | |
| 2 | 3 / | ~63k / | | | | |
| 3 | 0 (bail) / | 0 / | | | | |
| 4 (2nd) | 2 / | small / | | | | |
| 5 | 0 / | 0 / | | | | |
| 6 | 0 (bail) / | 0 / | | | | |
| 7 | 0 on retry / | 0 / | n/a | n/a | | |
