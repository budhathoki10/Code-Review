# This App vs. CodeRabbit-class Tools

- **Chat, autofix & tickets** — This app: none. CodeRabbit-class: yes.
- **Memory / learns from feedback** — This app: no. CodeRabbit-class: yes.
- **Cross-file / repo context** — This app: diff only. CodeRabbit-class: full repo + dependency graph.
- **Verification before posting** — This app: no. CodeRabbit-class: yes ("judge" pass).
- **Incremental review (new commits)** — This app: re-reviews everything. CodeRabbit-class: delta only.
- **Config surface** — This app: severity + free text. CodeRabbit-class: full YAML (filters, tool toggles, drafts).
- **Large PR (100+ files)** — This app: skipped entirely. CodeRabbit-class: filtered + rate-limited, still reviewed.
- **Static analysis bundled** — This app: 1 tool (ESLint). CodeRabbit-class: 40+ tools.
- **Async pipeline / retries** — This app: solid. CodeRabbit-class: solid.
- **Webhook security** — This app: solid. CodeRabbit-class: solid.

**Bottom line:** infra (queue, retries, webhook security) is on par. Everything else — what the AI sees and how much it's trusted before posting — is behind.

Full detail: `gap.md`.
