# PRarness Recipe Demo

This is a standalone, dependency-free mock repository for exercising PRarness.
It vendors a reviewed snapshot of the PRarness core under
`.github/agent-pipeline` and pairs it with a small product that can receive a
realistic issue and pull request.

The mock product is a recipe scaler. It offers a small browser interface and a
JSON endpoint that recalculates ingredient amounts when the serving count
changes. The repository deliberately contains one bounded, non-security bug so
you can file a realistic issue and observe triage, implementation, review, and
human handoff behavior.

## Run the mock product

Requirements: Node.js 20 or newer.

```bash
npm start
```

Open <http://localhost:3000>. The same behavior is available through
`POST /api/scale-recipe`:

```bash
curl --request POST http://localhost:3000/api/scale-recipe \
  --header 'content-type: application/json' \
  --data '{
    "baseServings": 4,
    "targetServings": 8,
    "ingredients": [
      {"name": "Flour", "amount": "1 1/2", "unit": "cups"}
    ]
  }'
```

## Validate the repository

```bash
npm run lint
npm test
```

The test suite intentionally reports one TODO. Copy the issue body from
[`docs/demo-issue.md`](docs/demo-issue.md) to turn that TODO into the demo
agent task.

## Repository map

```text
public/                         browser assets
src/components/recipe-scaler.mjs  recipe scaling domain logic
src/server.mjs                  static server and JSON API
test/                           product regression tests
docs/demo-issue.md              ready-to-file exercise issue
.github/agent-pipeline/         deterministic controller and schemas
.github/workflows/              issue/review workflow
```

The pipeline files are copied from the separate upstream PRarness repository;
they are not maintained as product code in this demo. See
[`docs/prarness-integration.md`](docs/prarness-integration.md) before updating
the vendored snapshot.

## Before enabling the agent workflow

The committed workflow contains no secret values. A maintainer still needs to
install the repository-scoped GitHub App and configure the repository secrets
and variables referenced by the workflow. The placeholder GitHub logins in
`.github/agent-pipeline/team.yaml` must also be replaced by real, assignable
collaborators in a separately reviewed human change.

Never commit an App private key, API key, `.env` file, local `.npmrc`, or runner
artifact. See [the publication checklist](docs/publication-checklist.md),
[`.gitignore`](.gitignore), and
[`docs/git-ground-rules.md`](docs/git-ground-rules.md) for the repository's
publication and trust-boundary rules.

## License

MIT
