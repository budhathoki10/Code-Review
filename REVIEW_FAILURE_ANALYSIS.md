# Why the review stopped and how it was fixed

## What actually happened

The screenshot is review commit `9a9913fde83b27c7a6fb590b33b47d8f26dd81bc`, with 458 changed files. The saved production rows confirm that the app marked the review `completed` while reporting `filesReviewed: 0`. It made 12 model calls and produced no AI findings; the findings shown in the dashboard came from static analysis.

The displayed gaps were real:

- 233 files were assigned to model work that failed.
- 93 files were excluded by the old total chunk budget.
- One large patch was only partially retained.
- 132 files were filtered, including 38 Markdown files and 81 deleted files.

This was not one failure. Several independent limits combined and the final state incorrectly treated their partial result as finished.

## Root causes

1. **The total chunk cap discarded the tail of a large pull request.** `MAX_REVIEW_CHUNKS` was used as a lifetime PR limit. Once the selected chunks filled, later files were recorded as over budget and never scheduled.

2. **A time/provider failure became a permanent result.** The NVIDIA endpoint returned intermittent HTTP 500 responses. The reviewer retried whole chunks, then stopped later chunks after a small shared failure threshold or the single review deadline. Completed chunk work existed only in memory.

3. **Incomplete output was checkpointed and published as completed.** The aggregate AI checkpoint retained `unreviewedFiles`, but later attempts could reuse that aggregate checkpoint. The pipeline then saved a completed dashboard review even though coverage was incomplete.

4. **Large files were cut by character count.** Both GitHub patch reconstruction and review selection truncated patches. Code after the cutoff could never be reviewed, and slicing arbitrary text could stop in the middle of a diff hunk.

5. **Missing GitHub patches were handled too narrowly.** Reconstruction stopped after 20 files, skipped deleted files, did not use `previous_filename` for renames, could waste time downloading known binary databases, and treated a valid empty text file as “too large.”

6. **The incremental comparison can be incomplete.** GitHub documents that the compare endpoint includes changed files only on its first page and caps that list at 300. Treating 300 returned paths as complete could silently omit the rest. See [GitHub's Compare two commits documentation](https://docs.github.com/en/rest/commits/commits#compare-two-commits).

7. **Policy filters contradicted “review every file.”** Documentation, deletions, formatting-only changes, comments, generated text, build output and lockfiles were excluded by default. Some of those changes can contain mistakes or malicious modifications.

## Fixes made

- Every eligible text file is now scheduled. The chunk count limits new work in one worker window, not total PR coverage.
- Each successful chunk is saved immediately in MongoDB under a content-derived key. If the time window ends or the provider fails, BullMQ delays and continues the same job from saved progress. A provider outage with no progress still consumes the normal retry budget, preventing an infinite loop.
- The final aggregate checkpoint is reusable only when coverage is complete and its versioned selection hash matches the current diff, model and review configuration.
- An incomplete review remains `pending`, does not publish a final GitHub review, does not advance `lastReviewedSha`, and cannot show a clean/green result.
- Large patches are split at diff-line boundaries. Each section gets correct old/new hunk coordinates, so later lines remain reviewable and inline-comment line mapping stays valid.
- A token-limited response continues from NVIDIA's returned partial reasoning with thinking disabled and a forced final submission. If the provider returns no reusable partial text, the file is split into smaller valid diff sections instead of being rerun with a larger output budget.
- Patch reconstruction now covers deleted files, renames, empty text files and up to GitHub's enumerated PR limit. Expensive diff generation has a CPU timeout and falls back to a complete linear replacement patch.
- Known binaries remain excluded because a text model has no meaningful source diff to inspect. SVG is treated as text. Generated text, lockfiles, docs, deletions and trivial-looking edits are reviewed by default; explicit path filters and opt-in environment switches can still exclude them.
- Incremental comparisons that reach 300 files are rejected and replaced with the fully paginated pull-request file listing.
- Numeric review limits now use safe finite-number parsing, avoiding `NaN` values that silently disable limits or timeouts.

## Verification

- Full unit suite: **39 files, 597 tests passed**.
- Repository-wide TypeScript checking passes with `tsc --noEmit`.
- Targeted ESLint passes for every changed source and test file.
- The Next.js production build passes.
- `git diff --check` passes.
- A read-only reproduction against the exact screenshot commit now sees **458 changed files, 457 eligible text files, 1 binary database, 0 unavailable diffs, 0 truncated patches, and 0 size-budget skips**. It plans 279 small chunks, including documentation, deletions, generated text and lockfiles.
- A no-comment live model smoke run completed and saved 10 chunks while the NVIDIA provider repeatedly returned HTTP 500 errors. It retained 10 findings in the persisted chunk checkpoints. The unit regression proves the next invocation reuses those checkpoints; the full 457-file model review was intentionally stopped to avoid spending millions of extra live tokens during local validation.

## Operational note

These changes are local and uncommitted. The running/deployed application will use them only after its normal deployment process. Existing old review rows remain historical evidence; a fresh re-review is required to produce complete coverage with the fixed pipeline.
