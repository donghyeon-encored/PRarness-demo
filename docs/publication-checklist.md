# Public repository checklist

Use this checklist before the first public push and again before every manual
bootstrap or migration.

## Commit these files

- Product source under `src/` and browser assets under `public/`
- Product and pipeline tests
- `package.json` files and their lockfiles
- Documentation, schemas, prompts, and policy files
- The workflow definition after a human security review
- `.gitignore`, `.gitattributes`, and `LICENSE`

The workflow contains names of repository secrets and variables. Those names
are configuration, not credentials, and are safe to publish.

## Never commit these files

- `.env` files or local configuration overrides
- GitHub App private keys, API keys, access tokens, or package-registry auth
- `.npmrc`, `.netrc`, certificate containers, or private-key files
- `node_modules`, coverage, build output, caches, or logs
- Agent event/state payloads, patches, artifacts, or nested checkouts
- IDE, assistant, and operating-system metadata such as `.DS_Store`

The matching patterns live in the repository root `.gitignore`. Ignore rules
do not make an already committed secret safe; if a secret ever enters Git
history, rotate it and remove it through a separately reviewed incident
procedure.

## Human review required before activation

- Replace placeholder accounts in `.github/agent-pipeline/team.yaml` with real,
  active, assignable collaborators.
- Confirm branch protection, Actions permissions, and CODEOWNERS coverage meet
  `docs/git-ground-rules.md`.
- Install a repository-scoped GitHub App with only the permissions required by
  the deterministic publisher.
- Add `AGENT_APP_ID` as a repository variable.
- Add `AGENT_APP_PRIVATE_KEY` and the selected provider API keys as repository
  secrets through GitHub settings. Never place their values in this checkout.
- Run `npm ci --ignore-scripts`, `npm run lint`, and `npm test` on the exact
  source snapshot that will be published.

Protected workflow, pipeline, ownership, and policy changes must follow the
approval process in `docs/git-ground-rules.md`.
