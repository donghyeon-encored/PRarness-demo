This repository contains the dependency-free PRarness recipe-scaler demo.

- Use Node.js 20 or newer.
- Run `npm run lint` and `npm test` before publishing application changes.
- Keep product changes under `src/`, `public/`, and `test/` unless the task
  explicitly requests repository maintenance.
- For a PRarness-managed Issue task, run the installed
  `prarness-session prepare` command before editing and follow its pinned Cloud
  session contract.
- Never force-push, merge, self-approve, or print configured credentials.
- Workflow, `.github/prarness.yml`, ownership, and secret-related maintenance
  requires an explicit interactive user request.
