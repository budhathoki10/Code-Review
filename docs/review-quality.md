# Evidence, feedback and review depth

PRSentry assesses potential blocking findings before publishing. A second AI
opinion is labeled **probable**, never test-proven. High/critical findings can
fail the check only after acceptance with a quote matching the finding's
source line (outer whitespace may be normalized), and only when they meet the repository's severity threshold. The model's
standalone merge verdict cannot bypass this policy. Medium/low/info, rejected,
unchecked and downgraded findings cannot block. Existing historical findings
without assessment are advisory until re-reviewed.

## Cost and retries

The verification allowance is per PR **head SHA**, not the lifetime of a PR.
New pushes receive a new allowance. A normal retry of the same head canno
spend the allowance again. An explicit force-review creates a new review.

| Setting | Default | Hard limit |
| --- | --- | --- |
| `REVIEW_VERIFICATION_MAX_FINDINGS` | 3 | 8 |
| `REVIEW_VERIFICATION_TOKEN_BUDGET` | 12000 | 32000 |
| Verification model calls | 1 batch | 1, SDK retries disabled |
| Completion tokens | 1800 | min(1800, budget / 3) |
| Model request timeout | 30 seconds | 30 seconds |

The request budget conservatively counts serialized UTF-8 request bytes,
including tools and metadata, plus output tokens and a framing allowance.
This is a token proxy, not an exact provider tokenizer. Actual reported usage
is included in review totals and shown separately on the dashboard. If a
provider fails without reporting usage, the attempt is counted but its token
count is unknown; a displayed zero is not proof that it was free.

Findings are filtered by repository settings and deduplicated before selection.
Critical issues are selected first, followed by sensitive files. The verifier
receives only candidate metadata, the relevant diff hunk (up to 3500 chars),
and numbered nearby source (up to 4500 chars). No whole-PR replay or tool loop.
Missing context, invalid output and an exhausted allowance leave findings
advisory. No qualifying findings means no verification call or context fetch.
Setting either configurable limit to zero disables paid verification.
Optional context reads share a six-second deadline; risk enrichment has a
three-second deadline. These reads skip normal rate-limit retries and do not
cache transient failures as missing files.

A durable reservation is saved before any verifier call. A crash after that
reservation leaves an interrupted advisory assessment instead of spending
again. Results, rejected findings and usage are checkpointed before publication.
If the provider responded but the process died before recording usage, exact
usage cannot be recovered automatically.

## Sensitive changes

Path and changed-code rules detect authentication/permissions, payment logic,
database migrations/destructive queries, APIs/webhooks and execution sinks.
These signals prioritize files within existing chunk limits. Sensitive changes
bypass cheap whitespace/import/deletion triage, but explicit path filters and
generated-file exclusions still apply.

At most two sensitive files receive nearby HEAD source in the first review
prompt (3000 chars each). Verification uses a wider nearby window for sensitive
files, inside the same total verification budget. Signals are visible in the
dashboard. They are heuristics, not a full dependency/call graph or evidence
that a file contains a bug.

## Explicit feedback

Authenticated repository owners can mark a finding correct, false positive or
duplicate, and undo a rating. Ownership is checked through the repository,
installation and PR for every mutation. Feedback changes no GitHub check and
does not silently create learned suppression rules.

The dashboard reports false positives / (correct + false positives) for the
explicitly rated findings shown in that review. Duplicates and unrated findings
are excluded from this denominator. This is a biased observed sample, not
whole-system accuracy or recall. Measure missed bugs with independently labeled
PRs, including clean changes, before claiming accuracy improvements.

## Optional test-backed evidence

Set `REVIEW_TEST_PROOF_IMAGE` on a worker with Docker to a preinstalled,
digest-pinned Node 24 image, for example `node@sha256:<actual-image-digest>`.
No image is pulled automatically. Without this configuration, no code is
executed and the model is instructed not to generate test descriptors.

The same verifier call can propose a JSON assertion for a self-contained
exported JS/TS function: its export name, argument array and expected return
value. At most one proposed test is attempted per review. The actual PR merge
base and reviewed head are pinned; each receives the identical assertion in a
separate container. Only base-pass/head-fail earns **regression reproduced**.
The assertion and SHAs are displayed for inspection. Intended behavior still
needs human assessment; a behavioral difference alone does not prove a bug.

Containers have no network, no host mounts or application credentials, a
read-only filesystem, an unprivileged user, dropped capabilities, a temporary
8 MB filesystem, 128 MB memory, half a CPU, 32 PIDs and an 8-second execution
timeout. Cleanup targets only the generated container name. Repository code
never executes in the web/worker process. Use a dedicated isolated Docker
worker for untrusted repositories; containers share their host kernel.

This initial runner supports JSON-returning, self-contained `.js`, `.mjs` and
erasable `.ts` exports. External imports, frameworks, JSX, setup-dependent
functions, thrown errors, timeouts and missing runtime/image are reported as
unavailable, not test failures proving a regression. It neither installs PR
dependencies nor runs repository scripts. Passing both versions or failing the
baseline does not reproduce the finding; the separate AI assessment remains
visible rather than treating one test as an exhaustive disproof.

## Validation

Run `npm test` and `npm run build`. The unit suite covers budget enforcement,
exact evidence, malformed responses, deduplication, retry reservations,
authorization, feedback denominators, risk selection and sandbox invocation.
Mocked execution tests verify control flow, not live Docker isolation or live
model accuracy. Measure a labeled PR sample before making performance claims.


## Accuracy-first latency controls

The worker configuration uses Ultra, thinking enabled for discovery, 8192 maximum
output tokens, temperature 0.2 and one optional investigation round. Investigation
requires a tool call; the final round forces submit_findings. Cheap triage still
skips formatting/comment-only changes. Verification disables thinking and keeps
its independent evidence check. A second model is not required.

The production chunked path generates its summary deterministically from assessed
findings, with no summary model call. All chunks enter a scheduler capped at two
concurrent calls by default. Static analysis and sensitive-file context start
together. SDK retries are disabled for discovery and verification. Provider HTTP,
connection and timeout failures do not trigger file splitting; queued chunks stop
on provider failure, while already-running chunks can finish. Malformed output
can still be split within the shared deadline and bisect allowance.

REVIEW_DEADLINE_MS defaults to 180000 and REVIEW_RISKY_DEADLINE_MS to 240000
(milliseconds from pipeline start). Forty seconds are reserved for verification
and finishing analysis. Each discovery request and investigation fetch receives
the remaining discovery budget; the request timeout can shorten it further.
Static analysis stops starting files at that deadline; an already-running linter
can finish under its existing timeout. Verification receives the remaining total
budget. Optional Docker proof starts only with at least 30 seconds left.
These are analysis budgets, not guaranteed webhook-to-comment service times:
queue/throttle delay, worker startup, database operations and GitHub publication
can add time. They cannot make an overloaded provider complete successfully.

Incomplete discovery is disclosed, cannot produce an approval, and does not
advance the incremental baseline. Earlier findings on failed files remain advisory.
A partial review is excluded from baseline fallback on the next push. High/critical
findings still require accepted evidence to block; no deadline bypasses that rule.

Review metrics now include stages (loadAndSelect, prepare, context, discovery,
staticAnalysis, staticTail, mergeAndCheckpoint, verification and publish) and
queueWaitMs. StaticAnalysis overlaps discovery; do not sum overlapping durations.
QueueWaitMs is elapsed time from review-document creation and includes earlier
attempts on retries. Each successful discovery request logs duration, round and
finish reason. Failed attempts count as calls even when token usage is unknown.

Validation of runtime policy is separate from detection accuracy. Before claiming
better recall or unchanged precision, replay labeled buggy and clean PRs against
both configurations, using the same SHAs and several runs. Compare confirmed bugs,
false positives, missed bugs, incomplete coverage, tokens and p50/p95 duration.
The regression suite exercises scheduling, provider failures, deadlines, evidence
validation and incremental baselines; it does not establish live model accuracy.

Local .env changes require a worker restart. Render blueprint settings require
application to the deployed service; editing this repository does not change a
running worker's environment automatically.
