# Current source inventory

Generated: 2026-10-06T12:30:23.330Z. Root: E:\project\odd-ecosys. Parent Git scope: E:/. Scoped Git repository is created separately for the sanitized agent workspace.

61 source/config/document/tool files; 131 exported functions; 73 route expressions; 85 UI action expressions. This is extracted source, not proof every runtime branch has coverage. Full records and line references are in inventory.json. Private data contents are excluded.

## Pages

Dashboard, leads/discovery, qualification, verification, personalization/approval, mailboxes, campaigns/A-B testing, batches and analytics are implemented by js/app.js plus corresponding js modules. Cross-page interactions and every actionable control require P00 coverage mapping and later browser evidence.

## Commands

- **test:** `node --test tests/*.test.mjs`
- **runner:start:** `node tools/freeinference/runner.mjs`
- **runner:status:** `node tools/freeinference/runner.mjs --status`
- **runner:stop:** `node tools/freeinference/runner.mjs --stop`
- **start:** `node server.js`
- **dev:** `node server.js`
- **pipeline:discover:** `node pipeline/cli.js discover`
- **pipeline:import:** `node pipeline/cli.js import`
- **pipeline:seed:** `node pipeline/cli.js seed`
- **pipeline:batches:** `node pipeline/cli.js batch-status`
- **pipeline:stats:** `node pipeline/cli.js stats`
- **pipeline:template:** `node pipeline/cli.js template`
- **pipeline:help:** `node pipeline/cli.js help`

## Remaining inventory work

Resolve regex routes/method branches, UI event handlers and all request/response schemas into executable contract tests. Map every feature ID and defect to positive/negative/error/restart coverage. Do not mark this extraction as complete test coverage.
