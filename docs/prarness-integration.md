# PRarness integration

This demo uses the central PRarness runtime without vendoring it. The reviewed
runtime revision is:

```text
donghyeon-encored/PRarness@a72e1d86cdfe0c146d6e5b885aee5ffb47a10d8a
```

The repository-specific adapter consists only of:

```text
.github/prarness.yml
.github/workflows/prarness-intake.yml
.github/workflows/prarness-ci.yml
AGENTS.md
CLAUDE.md
```

GitHub Actions creates the managed bootstrap branch and draft PR. Its body
contains an exact repository/Issue/PR-bound `@codex` command. A connected
human posts that complete command without shortening it. Codex Cloud downloads
the pinned runtime outside the checkout, verifies its checksums, runs R&R and
CodeGraph preparation, implements and self-reviews the bounded change, assigns
the reviewer, publishes managed review comments, and reconciles CI in one task.

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
