# PRarness integration

This demo repository vendors the PRarness engine so it can run independently
after being cloned. The upstream core and this demo are separate repositories:

- Upstream core: `eastlighting1/prarness`
- This repository: `eastlighting1/prarness-demo`
- Initial snapshot date: 2026-08-20

The bit-for-bit vendored engine boundary consists of:

```text
.github/agent-pipeline/pipeline.mjs
.github/agent-pipeline/package.json
.github/agent-pipeline/package-lock.json
.github/agent-pipeline/prompts/**
.github/agent-pipeline/schemas/**
.github/agent-pipeline/test/**
.github/workflows/issue-review.yml
AGENTS.md
CLAUDE.md
docs/git-ground-rules.md
```

`.github/agent-pipeline/team.yaml` is deliberately outside that synchronization
boundary. It is repository-local ownership and risk configuration. The initial
demo copy still contains upstream placeholder accounts; a human must replace
them with real, assignable collaborators and verify the demo paths before the
workflow is activated.

Do not edit vendored engine files merely to customize the recipe example.
Updating the engine requires a separately reviewed human change that:

1. identifies an exact upstream tag or commit;
2. replaces the complete vendored engine boundary from that source;
3. preserves and separately reviews the demo's `team.yaml` configuration;
4. verifies that no demo-only change was mixed into the copied engine files;
5. runs `npm run lint` and `npm test`; and
6. records the upstream revision in this document.

The initial local source has not been committed yet, so it has no upstream Git
revision to record. Replace the snapshot date above with an exact tag and full
commit SHA after the core repository receives its initial human-authored
commit.
