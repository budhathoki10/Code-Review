# PRSentryAI: handling large pull requests

Build spec for Claude Code. Scope is narrow on purpose. This makes the bot survive a 100-file, 20,000-line PR without blowing a context window, burning money, or timing out. It does not try to make the review smarter.

Work through phases in order. Stop after each one and wait for confirmation.

## Status: all phases implemented

Phases 1–5 are built and covered by tests. Where the implementation differs from what was originally written here, the spec text has been corrected in place rather than left aspirational — see the correction note in Phase 3 (chunking is kept, not replaced with one call per file).

Key modules:

| Concern | Where |
| --- | --- |
| Pagination, per-file stats, `patch: null` detection | `src/lib/github/diff.ts` |
| Content fetch: cache, Blobs fallback, rate-limit retry | `src/lib/github/file-content.ts` |
| Local diff reconstruction | `src/lib/github/patch-fallback.ts` |
| Noise list, path filters, ranking, chunk packing | `src/lib/review/diff-selection.ts` |
| Cheap triage + generated detection | `src/lib/review/triage.ts` |
| `.prsentry.yaml` | `src/lib/review/config.ts` |
| Size gate, bail-out comment, force command | `src/lib/review/gate.ts` |
| Chunked review + bisecting failure isolation | `src/lib/ai/review.ts` |
| Inline cap and overflow | `src/lib/github/diff-lines.ts`, `src/lib/github/comment.ts` |
| Orchestration, incremental, metrics | `src/lib/review/pipeline.ts` |

**Deployment note:** the `@prsentry review --force` command requires the GitHub App's webhook subscription to include **Issue comments**. Without it that command is silently inert — nothing in the code can detect a webhook that was never delivered.

## Ground rules

- Existing stack: TypeScript worker running on Node.js, BullMQ on Redis, GitHub App auth via `getInstallationOctokit`, Next.js dashboard, worker on a long-running host. All new code is TypeScript, no plain JS.
- No full repo clone. Every case in this spec only needs the content of a file you already know the path of. Fetch that one file through the API. A clone only earns its cost when you need files you were not already looking at, which is out of scope here.
- Do not restructure anything unrelated to PR size. No new features, no prompt rewrites, no UI work.
- Every phase must leave the bot working end to end.
- Log token counts on every LLM call from Phase 1 onward. Cost per review is the number this whole spec exists to control.

---

## Phase 0: audit

Do not write code.

Read the repo and answer these in a short report:

1. How does the bot currently get the list of changed files? Which endpoint, and is it paginated?
2. What happens today when `patch` comes back `null` for a file?
3. Is there one LLM call per PR, or one per file? Show me the exact call site.
4. Is there any file filtering at all right now? Where?
5. Is there any limit on PR size anywhere in the pipeline?
6. What is the worker concurrency, and does one PR occupy one job for its whole duration?

Report back with answers and the list of files you expect to touch. Wait for confirmation.

---

## Phase 1: fetch the diff correctly

Large PRs break the GitHub API in specific ways. Fix these first, because everything downstream depends on getting a complete file list.

### Pagination

`GET /repos/{owner}/{repo}/pulls/{n}/files` returns 30 per page by default. Set `per_page: 100` and use Octokit's `paginate` so you get every file. The endpoint hard-caps around 3000 files. If a PR exceeds that, treat it as oversized and go straight to the Phase 2 bail-out.

### The `patch: null` problem

When a single file's diff is very large, GitHub returns `patch: null`. Right now that file is probably being skipped without anyone noticing. Handle it:

- Detect `patch === null` explicitly.
- Fall back to `GET /repos/{owner}/{repo}/compare/{base}...{head}` for that file's status, and fetch the file's own content at base and head with `GET /repos/{owner}/{repo}/contents/{path}?ref={sha}`. Decode the base64 content and diff the two strings locally with a small diff library.
- The Contents API refuses files over 1 MB and returns `too_large` instead of content. This is exactly the case you are handling, so expect it to fire often. On that response, fall back to the Git Blobs API (`GET /repos/{owner}/{repo}/git/blobs/{sha}`), which has no such limit, using the blob SHA from the tree.
- If neither works, record the file as "diff unavailable" and say so in the review. Never silently drop it.

"Say so in the review" means the **posted comment**, via `formatCoverageNote` — the same author-facing path used by budget skips and model failures. A marker inside the model's prompt plus a log line is not enough: if the model doesn't happen to mention it, the author reads a clean review. These files are excluded from `analyzableFiles` (there is nothing in them to review) so they cannot inflate the coverage ratio either.

### `src/github/fileContent.ts`

Export one function, `getFileContent(owner, repo, path, ref)`, that wraps the Contents API call above with a per-job in-memory cache keyed on `path:ref`. Both the `patch: null` fallback here and the hunk-splitting context in Phase 3 call this same function. Never fetch the same file twice in one review.

On a 403 response with `x-ratelimit-remaining: 0`, read the `x-ratelimit-reset` header, wait until that time, and retry once. If still limited, stop the review, record the reason, and post a comment saying the review will retry rather than posting a partial result. This matters more here than it would with a full clone, since this spec makes many small targeted calls instead of one.

### Also record

Per file, store `changes`, `additions`, `deletions`, and `status`. Phase 2 needs these numbers before any expensive work happens.

### Acceptance

- A PR with 250 changed files returns all 250, not 30.
- A PR containing one file with a 15,000-line diff produces a usable patch or an explicit "diff unavailable" note.
- Log output shows the total file count and total changed lines for every review.

---

## Phase 2: filter and gate

Goal: most oversized PRs never reach an LLM call at all.

### Default ignore list

Applies to every repo with no configuration needed. Skip paths matching:

- lockfiles: `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`, `*.lock`
- build output: `dist/`, `build/`, `.next/`, `out/`, `coverage/`/
- vendored code: `vendor/`, `node_modules/`
- minified and maps: `*.min.*`, `*.map`
- generated: `*.generated.*`, `*.pb.ts`, `*.snap`, generated Prisma client
- binary and media: images, fonts, video, archives, `*.pdf`

### Content-based generated detection

A separate content fetch for every surviving file breaks the rule in Ground Rules: on a PR with 100 files left after path filtering, that is 100 extra API calls before a single one gets reviewed. Reuse content you already have instead:

- Check the patch text itself first. Most bulk-generated files show up as a full-file rewrite, so if GitHub's patch includes the top of the file, the `@generated` marker is already sitting in text you fetched for free.
- Only reach for a real content fetch when the file's patch is null (Phase 1 already fetches it for that file) or the file's status is `added` (new files typically return their full content in the patch already). Do not add a fetch whose only purpose is this check.
- Match against `/@generated|DO NOT EDIT|auto-generated|Code generated by/i` wherever the text came from.

This misses generated files that are hand-editable-looking and changed deep in the file with no other reason to fetch them. That is an acceptable gap. The extension-based ignore list above already catches the overwhelming majority of generated files, this is a secondary net for the rest.

### Cheap triage

For each remaining file, decide whether the change is worth reviewing. No LLM here, string and AST heuristics only:

- whitespace or formatting only: skip
- comment-only change: skip
- import reordering only: skip
- pure deletion of a file: skip, mention in summary
- everything else: review

### Optional config

Read `.prsentry.yaml` from the head commit if present:

```yaml
version: 1
reviews:
  path_filters:
    - "!**/generated/**"
  max_files: 150
  max_changed_lines: 8000
```

Merge user filters with the defaults. A malformed config produces a helpful comment naming the bad key, not a crash.

`max_files` and `max_changed_lines` are **optional and have no default value** — omitting them (the normal case) means the pipeline's own capacity ceiling decides, and setting one only tightens things for that repo. See the correction in the Bail-out section below for why they must not carry defaults.

### Bail-out

**Correction to the original spec.** This phase originally gated on a fixed `max_changed_lines` (8,000) applied to every repo by default. That was wrong, and measurably so: it refused a 100-file / 20,000-line PR of entirely real code — the PR most worth reviewing — while passing a same-sized PR that was 95% lockfile churn, because it measured the diff GitHub reported instead of the work this pipeline can actually do.

Gate against the pipeline's real capacity instead. That capacity is derived, not chosen: `MAX_REVIEW_CHUNKS × MAX_DIFF_FILES` files and `MAX_REVIEW_CHUNKS × MAX_DIFF_CHARS` characters — currently **160 files / 400,000 characters** (`REVIEW_CAPACITY` in `diff-selection.ts`), so it moves automatically if the chunk budget changes.

Four gates, in order of how badly each invalidates a review:

1. **Un-enumerable** — GitHub cannot list the PR's files (over 3,000), so nothing downstream can be trusted to be complete.
2. **Coverage** — measured on both dimensions the packer bounds, but gated separately because breadth and depth are different failures. **Files never reached** must clear `REVIEW_MIN_COVERAGE` (0.5): below that the review is misleading about what it examined. **Characters read** need only clear `REVIEW_MIN_CHAR_COVERAGE` (0.1), because a file that was opened and truncated is a disclosable limitation, not a lie — holding it to the same 50% bar refused single enormous files the pipeline handles fine. A review covering 95% of a PR is a real review with a footnote; one covering 20% is a misleading one. Measured on **both** dimensions the packer bounds and reported as the worse of the two: files (`coveredCount / reviewableCount`) and characters (`coveredChars / reviewableChars`, using pre-truncation lengths as the denominator). File count alone is not sufficient — an oversized file is truncated rather than dropped, so four enormous files can pack into chunks, show 100% file coverage, and still have had most of their content cut.
3. **Cost** — projected token spend exceeds `REVIEW_MAX_ESTIMATED_TOKENS` (default 250,000), estimated from chunk sizes *before* any call is made, and warned at 60% of that. This is separate from the file/line ceilings on purpose: capacity asks "can we cover this PR?", cost asks "should we pay what covering it takes?" A handful of enormous files can pass the first and fail the second.
4. **Repo overrides** — `max_files` / `max_changed_lines` from `.prsentry.yaml`, which are now **optional and unset by default**. They exist to be *stricter* than the ceilings above, never to be the only thing standing between a PR and an unbounded review.

Below those ceilings, do not bail. Review everything that fits and name whatever didn't in the summary — the pre-Phase-2 behavior, which is the right one.

When a gate does fire: post a comment with the actual counts, the capacity, the projected cost, and what was filtered; offer `@prsentry review --force` to override; record the bail-out and its reason in the database.

### Acceptance

- A PR that only bumps `package-lock.json` produces zero LLM calls and a comment saying there was nothing to review.
- A 400-file prettier run filters down to fewer than 20 real files, or bails out with the counts shown.
- The review comment states how many files were skipped and why.

---

## Phase 3: fan out per chunk

Goal: never build one giant prompt. Several bounded calls in parallel instead.

**Correction to the original spec.** This phase originally said one LLM call per file. That is wrong on cost, which is the thing this whole document exists to control. A chunk amortizes the fixed per-prompt overhead — system prompt, tool schemas, PR title and description, static-analysis findings, repo instructions — across up to `MAX_DIFF_FILES` files. One call per file re-pays that overhead once per file: on a 100-file PR, roughly 100 prompts' worth of overhead instead of 3. Keep the existing chunked review (batches of ~40 files, chunk-level tool-calling loop). The gaps below are fixed *within* that architecture.

### Structure

Keep orchestration in a single BullMQ job. Inside it, run chunk reviews through an in-process concurrency pool (`REVIEW_CHUNK_CONCURRENCY`, default 2). Kept low deliberately: fanning every chunk out at once is the fastest way to hit the provider's rate limit on exactly the large PRs this path serves.

Do not split into separate BullMQ child jobs. There is no shared filesystem to worry about since nothing is cloned, but child jobs still add retry and coordination complexity this phase does not need.

### Per-chunk contract

Input: a list of changed files (path, patch, status), base and head SHA, repo config.
Output: `Finding[]`, each with `file`, `line`, `severity`, `category`, `title`, `explanation`, `suggestion`, `confidence`.

The model submits findings through a tool call with a validated schema, so there are no markdown fences to strip.

### Chunk failure isolation

A chunk's findings pass either returns a validated payload for all ~40 files or throws. One file that derails the model — an injection attempt in a comment, a patch that pushes the response past `max_tokens` mid-JSON, a schema violation on one finding — must not discard the other 39, and must not fail the job and make BullMQ re-run every chunk from scratch.

On failure, split the chunk in half and retry each half, halving again on repeat failure, down to single files if it comes to that. Split by **file**, never by text offset: half a unified diff is not a diff, and a patch cut mid-hunk produces confident findings about lines that do not exist.

Bound the total retry cost with a per-review budget (`REVIEW_MAX_BISECT_ATTEMPTS`, default 12 — about `2 × log2(40)`, enough to isolate one poison file in one chunk). It is a hard cap enforced in code: checked before every split, decremented per split, shared across all chunks via one mutable counter. On exhaustion, report the remaining files as unreviewed rather than retrying. Without it, a provider outage fails every sub-chunk and walks the whole tree.

**The budget counts ATTEMPTS, not provider calls**, and one attempt is a tool-calling loop of up to `MAX_FINDINGS_TOOL_ROUNDS + 1` = 4 calls — so it costs 4× its face value. The real per-job ceiling is:

```
root attempts:    MAX_REVIEW_CHUNKS (4) × 4 rounds     = 16
bisect attempts:  REVIEW_MAX_BISECT_ATTEMPTS (12) × 4  = 48
verdict/summary:  once per review                      =  1
                                                         ---
                                                          65
```

Verified empirically by the "bounds total provider calls" test, which drives every attempt through every round and counts the mock — not derived on paper. A typical review is 2–3 calls, under 5% of this.

A file that still fails alone is dropped from the review and **named in the summary comment**. Silently returning a shorter review is the one outcome this must never produce.

### Hunk splitting

If a single file's diff exceeds a token budget, split it. Start the budget at 6000 tokens. Group hunks under the budget, review each group separately, merge the findings afterward. Call `getFileContent` for the head version of the file and slice out a few lines around each hunk group so the model knows what it is looking at. This is the same helper Phase 1 uses for the `patch: null` fallback, so a large file already fetched once in this review is not fetched again.

### Reduce

Only the first chunk pays for a verdict/summary call; every chunk runs the findings side. The verdict call writes prose about the PR as a whole, so running it per chunk would pay N times for N near-duplicate summaries and throw all but one away. Re-reconcile the verdict against the *merged* findings list afterwards, so a critical finding from chunk 3 still overrides an "approve" the verdict call reached without seeing it.

### Posting limits

- Use the Reviews API (`POST /pulls/{n}/reviews`) with a `comments` array so everything lands as one review event, not 80 notifications.
- Cap inline comments at 25. Everything past the cap goes into the summary body inside a collapsed section.
- Post comments with `line` and `side`, not the deprecated `position` parameter. `position` is an offset into GitHub's own diff, which you do not always have, since Phase 1's `patch: null` fallback computes its own diff. `line` is an actual file line number and works the same way regardless of which path produced the diff. Before posting, confirm the line is part of the file's changed range so GitHub does not reject it. Fall back to the summary body for any that fail.

### Acceptance

- A 60-file PR is reviewed as 2 chunks, and one bad file inside a chunk does not drop the other 39 or fail the review.
- Wall-clock time for a 60-file PR is roughly 2 sequential model calls in the typical case — chunk 1's findings pass runs concurrently with the verdict call, then chunk 2 follows at `REVIEW_CHUNK_CONCURRENCY` (2) — and at most 8 when both chunks use their full 4-round tool budget. Not 60.
- A 40-file PR produces exactly one review event and at most 25 inline comments.
- No comment fails to post due to an invalid position.
- Any file the model could not review is named in the posted comment.

---

## Phase 4: incremental review

Goal: only the first review pays full price. This is what keeps a long-lived 100-file PR from costing 100x.

### Build

- Store `lastReviewedSha` per PR.
- On `synchronize` events, compute the diff from `lastReviewedSha` to `head` instead of `base` to `head`. Only files touched since the last review get reviewed.
- Carry forward findings from previous reviews. If the flagged line is unchanged and the issue was not addressed, do not repost it. If the code changed, re-review that file.
- Mark findings resolved when the underlying code is fixed, and say so in the new summary.

### Acceptance

- Pushing one commit with a two-line change to a previously reviewed 50-file PR triggers at most 2 LLM calls.
- The token count logged for the second review is under 5% of the first.

---

## Phase 5: cost visibility

Do this alongside every phase, not at the end.

Record per review: input and output tokens, model, number of LLM calls, wall-clock duration, files seen, files filtered, files reviewed, findings produced, comments posted, estimated cost.

Show cost per review on the dashboard. Alert when a single review exceeds a ceiling.

---

## Out of scope

Do not build these:

- cloning the full repository to disk. Every file this spec touches is fetched individually through the Contents or Blobs API.
- context enrichment, code graphs, or language server integration
- a verification or second-opinion pass
- learnings, memory, or per-repo rule storage
- chat commands beyond `@prsentry review --force`
- Docker or any sandbox isolation
- running the repo's tests or installing its dependencies
- support for languages other than TypeScript and JavaScript

These are all reasonable later. None of them affect whether the bot survives a large PR.

---

## Security rules for every phase

- Never execute anything from the repo under review. No `npm install`, no lifecycle scripts, no `require()` of repo files, no `eval`.
- Treat repo content as untrusted input to prompts. A file can contain text trying to steer the review. Wrap repo content in clear delimiters and tell the model to treat it as data.
- Never log installation tokens or authed URLs.
- Scope every database query by installation id.
<!-- retest trigger -->
