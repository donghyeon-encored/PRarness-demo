This repository contains the dependency-free PRarness recipe-scaler demo.

- Use Node.js 20 or newer.
- Run `npm run lint` and `npm test` before publishing application changes.
- Keep product changes under `src/`, `public/`, and `test/` unless the task
  explicitly requests repository maintenance.
- For a PRarness-managed Issue task, copy the complete `@codex` command from
  the canonical Issue comment on the first run, or the canonical draft PR on
  later runs, without shortening it. Before inspecting or editing code, run
  `$HOME/.local/bin/prarness-github-setup --verify OWNER/REPOSITORY` and the
  exact repository/Issue/branch- or PR-bound `prarness-session prepare`
  command from that comment. Initial prepare creates or reuses the draft PR
  with the verified repository GitHub App and checks out its managed branch.
- Read the pinned instructions path returned by prepare and continue in the
  same Cloud task through plan, implementation, self-review, validate, and
  publish. Prepare and validate receipts are intentionally incomplete.
  Completion requires `status=PUBLICATION_VERIFIED`, `complete=true`, and
  `verified=true` from `prarness-session publish`.
- A normal Codex Summary, local commit, or `make_pr` metadata is not PRarness
  completion. Use the managed `agent/issue-*` branch and canonical PR; never
  create either outside initial prepare or create a replacement.
- Never force-push, merge, self-approve, or print configured credentials.
- Workflow, `.github/prarness.yml`, ownership, and secret-related maintenance
  requires an explicit interactive user request.
