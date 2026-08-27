# PRarness Recipe Demo

This is a standalone, dependency-free mock repository for exercising PRarness.
It uses a SHA-pinned central PRarness runtime through a thin repository adapter
and pairs it with a small product that can receive a realistic issue and pull
request.

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
.github/prarness.yml            repository-specific PRarness contract
.github/workflows/              hostless Issue intake and secret-free CI
```

The runtime is downloaded from the separate upstream PRarness repository and
never committed into this demo. See
[`docs/prarness-integration.md`](docs/prarness-integration.md) before updating
the pinned runtime SHA.

## Before enabling the agent workflow

Install the repository-scoped GitHub App and configure its App ID and private
key only in this repository's Codex Cloud environment setup. Use the same
pinned PRarness SHA for Cloud setup and maintenance. GitHub Actions itself
receives no App private key or OpenAI API key.

Never commit an App private key, API key, `.env` file, local `.npmrc`, or runner
artifact. See [`.gitignore`](.gitignore) and
[`docs/prarness-integration.md`](docs/prarness-integration.md).

## License

MIT
