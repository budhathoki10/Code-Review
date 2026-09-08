# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub's [private vulnerability reporting](https://github.com/budhathoki10/Code-Review/security/advisories/new) — the **Security** tab → *Report a vulnerability*. That opens an advisory only you and the maintainer can see.

If private reporting is unavailable to you, open a normal issue titled `Security contact request` with no technical detail, and you will be given a private channel.

Please include, as far as you can:

- what the flaw is, and which file or endpoint it is in
- how to reproduce it — a request, a payload, or a sequence of steps
- what an attacker gets out of it
- the commit SHA or version you tested

You will get an acknowledgement within **3 days** and an assessment within **14 days**. If a fix is warranted, you will be told when it lands. You will be credited in the advisory unless you ask not to be.

Please give a reasonable window for a fix before disclosing publicly.

## Supported versions

This project has not cut a release. Only the current `main` branch is supported — fixes land there, and there is no backporting.

| Version | Supported |
| --- | --- |
| `main` | ✅ |
| everything else | ❌ |

## Scope

This is a GitHub App that receives webhooks, reads private source code, and sends it to a model provider. The areas most worth your attention:

- **Webhook authentication** (`src/app/api/github/webhook/`) — HMAC signature verification, replay handling, rate limiting. A path that acts on an unverified payload is a vulnerability.
- **Installation tokens and the App private key** — anything that widens the App's reach beyond the installation that sent the event, or that logs a token.
- **Prompt injection** (`src/lib/ai/`) — pull request content is untrusted input. Text in a diff, a PR title, or a review comment that makes the reviewer act outside its task, exfiltrate context, or post attacker-controlled content is in scope.
- **Cross-tenant access** — any path where one installation, repository, or dashboard user can read another's reviews, findings, or configuration.
- **Secret handling** — credentials or source code reaching logs, the dashboard, or a provider request that should not carry them.
- **Authentication and session handling** on the dashboard (`src/app/auth/`, NextAuth configuration).

### Out of scope

- Findings from an automated scanner with no demonstrated impact
- Missing hardening headers with no exploit path
- Vulnerabilities in dependencies already flagged by Dependabot, unless this project's use of them makes the impact worse
- Denial of service through sheer request volume against your own deployment
- Anything requiring a compromised maintainer account or physical access

## Deploying this yourself

If you run your own instance, the secrets in `.env.example` are all live credentials in production: `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `AUTH_SECRET`, `MONGODB_URI`, `REDIS_URL`, and your model provider key. Keep them out of the repository, rotate them if they are ever printed, and give the GitHub App the narrowest permission set your workflow needs.
