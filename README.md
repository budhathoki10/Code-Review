<div align="center">

# 🛡️ PRSentryAI

**An AI pull-request reviewer, shipped as a GitHub App.**
Install it on a repo, open a PR, and get a summary comment, inline line-by-line findings, one-click suggested fixes and a merge-gating check run within minutes.

[![Live](https://img.shields.io/badge/Live-codereview.kushalbudhathoki.com.np-2563eb?style=flat-square)](https://codereview.kushalbudhathoki.com.np)
![Next.js](https://img.shields.io/badge/Next.js-16-000000?style=flat-square&logo=nextdotjs)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![BullMQ](https://img.shields.io/badge/BullMQ-Redis-DC382D?style=flat-square&logo=redis&logoColor=white)
![MongoDB](https://img.shields.io/badge/MongoDB-47A248?style=flat-square&logo=mongodb&logoColor=white)
[![License](https://img.shields.io/badge/License-PolyForm%20Noncommercial-64748b?style=flat-square)](LICENSE)

</div>

---

## What it does

When a pull request is opened or updated, PRSentryAI:

1. **Receives the webhook**, verifies its HMAC signature, rate-limits it and queues it. It responds to GitHub immediately.
2. **Debounces rapid pushes** into a single review, and holds a per-PR Redis lock so two reviews of the same PR never race.
3. **Fetches only what changed.** After the first review, it reviews incrementally from the last reviewed commit.
4. **Filters, ranks and chunks the diff** so even very large PRs get reviewed within a token budget.
5. **Runs 9 static analysers plus a secret scan** (ESLint, Biome, oxlint, Stylelint, markdownlint, HTMLHint, actionlint, Squawk, Buf) and passes their results to the AI as context.
6. **Runs a bounded AI review.** The model must answer through a typed tool call, and every result is Zod-validated before it's trusted.
7. **Posts back to the PR** as `prsentryai[bot]`: a summary comment, inline comments, committable suggestions and a check run.

Developers can **reply to a finding** and get an answer in the thread. Findings that a later commit fixes are marked **resolved** automatically.

## Design principles

- **Nothing is silently dropped.** If a file was skipped or a finding couldn't be mapped to a line, the comment says so.
- **Size never fails a review.** Oversized PRs are filtered, ranked and chunked instead of rejected.
- **Cost is bounded before it's spent.** A size gate estimates token spend before the first model call.
- **The model gets the least trust in the system.** Its output is schema-validated, size-bounded and reconciled against deterministic checks.

## Architecture

```
GitHub (OAuth login, App install, PR + comment events)
                     │
                     ▼
Next.js app ── auth · dashboard · webhook endpoint
     │
     ├── MongoDB            reviews, findings, repo config
     ├── Redis / BullMQ     review · reply · throttle queues + per-PR lock
     │
     ▼
Review worker (src/worker/review-worker.ts)
     ├── Static analysis    9 linters + secret scan
     ├── AI review engine   chunking, bounded tool loop, bisect retry
     └── GitHub publishing  summary, inline comments, suggestions, check run
```

The full design is in **[Documentation.md](Documentation.md)**: data model, pipeline stages, large-PR handling, incremental reviews, cost controls and build history.

## Tech stack

| Layer | Choice |
|---|---|
| App | Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS |
| Auth | GitHub App (user-to-server OAuth) via Auth.js |
| GitHub | Octokit with installation-scoped tokens |
| Jobs | BullMQ + Redis, three queues and a distributed lock |
| Database | MongoDB |
| AI | NVIDIA NIM through an OpenAI-compatible API, with tool calling and Zod |
| Notifications | Web Push (VAPID) when a review completes or fails |
| Testing | Vitest (unit) and Playwright (end-to-end) |
| Deploy | Render (web service and worker) |

## Running locally

**Requirements:** Node.js 20+, a MongoDB database, a Redis instance, a GitHub App and an NVIDIA API key.

```bash
npm install
cp .env.example .env    # fill in the values listed below
npm run dev:all         # starts the Next.js app and the review worker together
```

Then open http://localhost:3000.

**Required environment variables**

| Variable | Purpose |
|---|---|
| `AUTH_SECRET`, `AUTH_URL` | Auth.js |
| `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET` | Sign in with GitHub |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET` | GitHub App and webhook verification |
| `MONGODB_URI`, `MONGODB_DB` | Database |
| `REDIS_URL` | Job queues |
| `NVIDIA_API_KEY` | AI provider |

Optional tuning (chunk limits, rate limits, cost reporting) is listed in [Documentation.md §14](Documentation.md#14-environment-variables).

**Browser notifications (optional):** set `VAPID_SUBJECT`, `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` for both the web app and the worker. Then enable notifications under **Dashboard → Settings**. Production push needs HTTPS. Localhost works in development.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev:all` | App and worker with hot reload |
| `npm run worker` | Run the review worker only |
| `npm test` | Unit tests (Vitest) |
| `npm run test:e2e` | End-to-end tests (Playwright) |
| `npm run lint` | ESLint |
| `npm run build` | Production build |

## Contributing & security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Design notes and research are in [`docs/`](docs).

## License

[PolyForm Noncommercial 1.0.0](LICENSE). You may clone, study, modify and share this code for noncommercial purposes. Commercial use is not permitted.

---

<div align="center">Built by <a href="https://github.com/budhathoki10">Kushal Budhathoki</a></div>
