# PRarness integration

This demo uses the central PRarness runtime without vendoring it. The reviewed
runtime revision is:

```text
donghyeon-encored/PRarness@3eee510a6110f30811217bf994277b6892202763
```

The repository-specific adapter consists only of:

```text
.github/prarness.yml
.github/workflows/prarness-intake.yml
.github/workflows/prarness-ci.yml
AGENTS.md
CLAUDE.md
```

GitHub Actions creates the managed bootstrap branch and draft PR. A connected
human then posts the PR's documented `@codex` command. Codex Cloud downloads
the pinned runtime outside the checkout, verifies its checksums, and performs
the bounded implementation and publication in one task. CI runs independently
without repository secrets.

When updating PRarness, change both workflow refs and the Cloud environment's
setup/maintenance `PRARNESS_BOOTSTRAP_REF` to the same reviewed 40-character
commit SHA. Run `npm run lint` and `npm test`, validate the YAML files, and run
the central `repository-check.mjs` compatibility check before publication.

The target repository must never contain the GitHub App private key, App token,
OpenAI API key, or a copied `.github/agent-pipeline/**` runtime.
