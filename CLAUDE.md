This repository contains the dependency-free PRarness recipe-scaler demo.

Use Node.js 20 or newer and run `npm run lint` plus `npm test` before
publication. A PRarness-managed Issue task must copy the complete command from
the canonical bootstrap PR, verify GitHub setup, run its exact
repository/Issue/PR-bound `prarness-session prepare` command before inspection,
read the returned pinned instructions, and continue through validate and
publish in the same task. Prepare, validation, a regular Summary, a local
commit, and `make_pr` metadata are incomplete; only
`status=PUBLICATION_VERIFIED`, `complete=true`, and `verified=true` from
publish is completion. Reuse the managed branch and PR. Never force-push,
merge, self-approve, expose configured credentials, or perform protected
repository maintenance without an explicit interactive user request.
