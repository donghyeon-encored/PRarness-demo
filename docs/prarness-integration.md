# PRarness integration

This demo uses the central PRarness runtime without vendoring it. The reviewed
runtime revision is:

```text
donghyeon-encored/PRarness@13e629235b6e12fd43a726dd64ff4cecf20f8955
```

The repository-specific adapter consists only of:

```text
.github/prarness.yml
.github/workflows/prarness-intake.yml
.github/workflows/prarness-ci.yml
AGENTS.md
CLAUDE.md
```

GitHub Actions creates only the managed bootstrap branch, labels, and canonical
Issue comment. It does not request pull-request write permission. A connected
human posts that comment's complete repository/Issue/branch-bound `@codex`
command without shortening it. Codex Cloud downloads the pinned runtime outside
the checkout, verifies its checksums, and uses the repository GitHub App to
create or reuse the canonical draft PR during prepare. The same task checks out
the managed branch, runs R&R and CodeGraph preparation, implements and
self-reviews the bounded change, assigns the reviewer, publishes managed review
comments, and reconciles CI. The PR body contains the exact PR-bound command
for later continuations.

Prepare and validation receipts are explicitly incomplete. Only a publish
receipt with `status=PUBLICATION_VERIFIED`, `complete=true`, and
`verified=true` is accepted. A normal Codex Summary, local commit, or
`make_pr` metadata is not publication evidence.

When updating PRarness, change both workflow refs and the Cloud environment's
setup/maintenance `PRARNESS_BOOTSTRAP_REF` to the same reviewed 40-character
commit SHA. Run `npm run lint` and `npm test`, validate the YAML files, and
run the central `repository-check.mjs` compatibility check before
publication.

The target repository must never contain the GitHub App private key, App token,
OpenAI API key, or a copied `.github/agent-pipeline/**` runtime.
