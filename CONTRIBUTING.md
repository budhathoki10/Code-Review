# Contributing

Thanks for taking an interest. This is an AI code-review GitHub App: a Next.js dashboard and webhook receiver, a BullMQ worker that runs the review pipeline, MongoDB for state, and Redis for the queue.

## Before you start

By contributing you agree your work is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE), same as the rest of the project. That license permits noncommercial use only — read it before you invest real time here.

For anything larger than a bug fix, **open an issue first**. The review pipeline has a lot of load-bearing detail that is not obvious from the outside, and a short conversation up front is cheaper than a rewritten pull request.

## Setting up

You need **Node 22** (what CI runs), a MongoDB database, and a Redis instance. Both can be cloud-hosted; nothing here assumes they are local.

```bash
npm install
cp .env.example .env     # then fill it in
```

`.env.example` documents every variable and what it does. The ones without which nothing runs: `MONGODB_URI`, `REDIS_URL`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `AUTH_SECRET`, and a model provider key.

Run the web app and the worker — **both**, in separate terminals. Reviews execute in the worker; the Next.js app only receives the webhook and serves the dashboard.

```bash
npm run dev          # Next.js on :3000
npm run dev:worker   # BullMQ worker
# or both at once:
npm run dev:all
```

### Working against real pull requests

The pipeline is triggered by a GitHub webhook, so GitHub has to be able to reach your machine:

```bash
cloudflared tunnel --url http://localhost:3000
# then point the App's webhook URL at <tunnel>/api/github/webhook
```

Two probes tell you whether the path is actually live before you spend time debugging silence:

```bash
node tests/manual/scripts/probe-env.mjs       # credentials, Mongo, Redis
node tests/manual/scripts/probe-webhook.mjs   # webhook URL and reachability
```

`tests/manual/verify-large-pr.md` is the full end-to-end runbook, including scenario fixtures and cost projections. Read it before running anything against a real repository — **these are real model calls against real tokens**, and a large scenario is not cheap. Use a throwaway repository, never one whose pull request list you care about.

## Checks

Everything below runs in CI on every pull request ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)). Run them locally first:

```bash
npm run lint
npm run build
npm test             # vitest unit tests
npm run test:e2e     # playwright
npx tsc --noEmit     # type check
```

A green suite is necessary and not sufficient. The manual runbook exists because unit tests missed three real bugs in the diff layer — mocks encode what we *believe* the GitHub API does, not what it does. If you change how diffs are fetched, selected, or budgeted, run the runbook.

## Writing the change

**Match the surrounding code.** This codebase comments the *why* — the measurement, the regression, the decision that is not visible from the code. Comments that restate the line above them are noise; comments recording why a default is what it is are the reason the next person does not undo your work. Follow the density and the register of the file you are editing.

**Do not delete the argument for something you are changing.** If a comment explains why a value is what it is and you are changing that value, rewrite the comment so it explains the new decision. A comment left arguing the opposite of the code is worse than no comment.

**Read the Next.js docs in `node_modules/next/dist/docs/` before writing routing or server code.** This project tracks a Next.js version whose APIs and conventions differ from what you may expect. See [`AGENTS.md`](AGENTS.md).

## Commits and pull requests

Commit subjects are `type: imperative description`, and they describe the **behavior**, not the edit:

```
feat: review only the files a push changed
fix: stop the repository dashboard crashing on the finding code link
test: score the reviewer against known ground truth instead of plausibility
```

Types in use: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`.

Pull request descriptions carry their weight. State the problem, what changed and where, why this approach, and how you verified it — with the evidence, not a claim. If you know of a limitation in what you are shipping, write it in the description rather than leaving it to be discovered. Branches are `type/short-description`, lowercase and hyphenated.

Keep a pull request to one concern. Two unrelated fixes are two pull requests.

## Reporting bugs

Open an issue with what you expected, what happened, and the smallest reproduction you have. For a review that went wrong, the repository, pull request number and the review's head SHA make it findable; log lines around `diff fetched`, `diff selected for review` and `review metrics` are usually the useful ones.

Security problems go through [SECURITY.md](SECURITY.md), not the issue tracker.
