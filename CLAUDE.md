This repository contains the dependency-free PRarness recipe-scaler demo.

Use Node.js 20 or newer and run `npm run lint` plus `npm test` before
publication. A PRarness-managed Issue task must copy the complete command from
the canonical Issue comment on the first run or canonical draft PR later,
verify GitHub setup, and run its exact repository/Issue/branch- or PR-bound
`prarness-session prepare` command before inspection. Initial prepare uses the
verified repository GitHub App to create or reuse the draft PR and check out
its managed branch. Read the returned pinned instructions and continue through
validate and publish in the same task. Prepare, validation, a regular Summary,
a local commit, and `make_pr` metadata are incomplete; only
`status=PUBLICATION_VERIFIED`, `complete=true`, and `verified=true` from
publish is completion. Reuse the managed branch and PR. Never force-push,
merge, self-approve, expose configured credentials, or perform protected
repository maintenance without an explicit interactive user request.
