# Guided goal backend integration report

Date: 2026-10-28

## Imported source and scope

The guided-goal implementation was imported from GLM commit `b949d806f7051872e120cb6921b721ff49c93116` after `docs/product/astra-combined-main-20261028/SOURCE_IMPORT.json` appeared. The import manifest SHA-256 is `309bd086b43583efc3f4949b5d9867886777073ee2ac0f3ea5dd7cbd48990dcd`.

This backend slice covers the goal service and routes, planner and gateway, the shared usage and egress task allowlists, additive migration 037, and focused lifecycle/gateway tests. The existing GLM client and its canonical FreeInference endpoint/model checks remain in use. Server assembly and the source-rights resolver are integrated by the server owner.

## Changes

- Goal creation now returns the complete persisted goal at revision 1. Initial planning is scheduled through `afterCommit`; draft reads can reschedule a lost worker callback. The worker loads the goal in a short tenant transaction, calls the planner after that transaction closes, then persists through a fresh revision-CAS transaction.
- Answer submission validates the current question IDs, saves the answers durably, clears the old plan/questions, increments the revision, and schedules the planner after commit. Provider work does not run inside the answer request transaction.
- Every goal mutation and read returns the durable goal state, including `id`, `status`, `stateRevision`, `plan`, `questions`, `answers`, `blockedReasons`, and `startRef`. Planning/start CAS revisions are required; there is no optional version bypass.
- Owner start persists a `starting` reference and schedules a post-commit worker. The registered route explicitly receives the transaction's `afterCommit` hook. Its native PostgreSQL route regression returns 200 with the full pending start at revision 5, stores that state, schedules the callback exactly once, and proves neither the worker nor prospecting `create` runs inline. The server-only resolver must return a current approved source-rights request; missing rights or prospecting setup becomes a stored block. A valid result uses existing prospecting `create`, persists its job reference, commits, and only then calls `runOnce`. No send action is included.
- Planner and provider deadlines now abort stalled work. The GLM gateway rechecks the canonical authority gate before dispatch, uses the existing shared tenant/global usage ledger, and durably reserves and settles usage in separate committed tenant transactions. The prompt includes only the goal brief and answers; tenant/run IDs remain in accounting metadata.
- Repeated draft polling is safe while planning is active. Same-process duplicates return `pending` and share one provider dispatch; duplicates in the durable ledger remain pending while queued/running or recently succeeded (within twice the provider deadline). The planner propagates pending and the service returns the CAS-checked current goal without changing its revision or blocking the active worker. A duplicate older than that recovery window returns `goal_usage_reconciliation_required` because the ledger has no typed plan-output cache after process restart; this avoids both a false block during normal work and indefinite pending after a lost result.
- Migration 037 adds `business_goal_planning` to the existing usage-task constraints. It enables no policy, provider, or live egress setting.
- Provider output is bounded and validated without deleting/mutating the question list. The plan cannot choose more than 10 prospects, which matches the existing prospecting request limit. Unavailable, unauthorized, uncertain, or unpriced provider results remain blocked and do not produce a fabricated plan.

## Durable planning-call cap

`reserveAstraUsage` serializes reservations through the existing global budget row. For each tenant-scoped goal UUID, it counts durable `business_goal_planning` usage rows in `queued`, `running`, `uncertain`, or `succeeded` state and refuses a fourth reservation. A dispatched timeout or unknown-cost response remains `uncertain`, counts against the three-call cap, and retains its reservation. A request that fails before dispatch can be settled as `failed` and released. Stable per-run/content idempotency prevents the same plan request from being sent again; there is no automatic retry or second provider call on a duplicate reservation. Existing global and tenant daily budgets, task policy, token ceiling, circuit breaker, commercial gate, and synthetic-fixture classification checks remain active.

The business-goal service defaults classification to `unknown`; request JSON cannot set it. The current usage ledger permits only `synthetic-fixture`, so real customer briefs remain blocked unless the canonical classification/policy is explicitly extended and approved. The planner/live authority flags and global egress settings were not enabled.

## Validation evidence

Commands run in the isolated candidate checkout:

```powershell
node --check pipeline/astra-business-goal.js
node --check pipeline/astra-business-goal-routes.js
node --check pipeline/astra-goal-planner.js
node --check pipeline/astra-goal-gateway.js
node --check pipeline/astra-usage.js
node --check pipeline/astra-egress.js
node --check tests/astra-business-goal.test.mjs
node --check tests/astra-goal-backend.test.mjs
git diff --check -- pipeline/astra-business-goal.js pipeline/astra-business-goal-routes.js pipeline/astra-goal-planner.js pipeline/astra-goal-gateway.js pipeline/astra-usage.js pipeline/astra-egress.js tests/astra-business-goal.test.mjs tests/astra-goal-backend.test.mjs migrations/astra/037-business-goal-planning-usage.up.sql migrations/astra/037-business-goal-planning-usage.down.sql
$env:ASTRA_QA_FIXTURE_PATH = '.runner/astra-qa/r20-source-rights/pg.json'; node --test --test-concurrency=1 --test-reporter=spec tests/astra-business-goal.test.mjs tests/astra-goal-backend.test.mjs
```

The canonical R20 source-rights fixture and validator pin all 37 UP migrations, including migration 037; its final entry hash matches `6ebce2d1a11c87029660bb0ab04552f2221d6adaf8dbe4bdd4a1a3d270996680`. The owner verified migration 037 UP/DOWN/UP on the disposable cluster. The focused suite was rerun against that 37-migration fixture and passed 10/10, including both PostgreSQL-backed lifecycle cases. All eight targeted `node --check` commands passed, as did `git diff --check`. The fixture runs in WSL; its loopback service was temporarily unavailable during an earlier attempt, then restored, and the successful rerun supersedes that transient connection failure.

The passing native lifecycle regression invokes the actual registered owner-start route, captures the transaction's `afterCommit` callback exactly once, checks the persisted pending start at revision 5, and verifies neither the worker nor prospecting `create` runs inline. The route source already destructures `afterCommit`; no route fix was needed. The duplicate-ledger SQL computes age from `created_at`, requires a finite age within twice the provider deadline for queued/running or succeeded rows to remain pending, and returns reconciliation-required for stale rows. The recent-running and old-succeeded cases passed.

Coverage included durable create/idempotency, complete revisions, required CAS, answer allowlisting/persistence, the blocked missing-source-rights path, pending duplicate apply preserving current draft/revision/answers, committed reserve/settle ordering, input minimization, question preservation, schema/count rejection, non-synthetic classification blocking, planner/gateway deadlines with uncertain spend retained, overlapping polls with exactly one provider dispatch and successful winner output, and recent/stale cross-process duplicate states. No network provider, live search, original database, mailbox, or sender was used.

Historical GLM evidence from the imported source records three provider calls for the guided run and a generated plan, but the owner-start attempt was blocked because prospecting was unavailable and no durable goal row was created. That previous external receipt was not repeated. The current synthetic gateway tests do not establish a real GLM success.

## Source hashes

SHA-256 for the finalized owned implementation/test sources at report time:

| File | SHA-256 |
|---|---|
| `pipeline/astra-business-goal.js` | `0448d0e865c0b9afaf0d3a2364e5bbb9ee324a91721bb60205f9539baa449632` |
| `pipeline/astra-business-goal-routes.js` | `6eb199793f1083e0604f396db3a46fc00cae3b8674aacb928f42e7c25ccd575c` |
| `pipeline/astra-goal-planner.js` | `712edfb9e3b81e2bfafdbced4c5f906a947320aa545bc94987ce2c04fa3521d2` |
| `pipeline/astra-goal-gateway.js` | `46cdabf53782951778c10a6f7f89e8bf594483738745f95d31c48374cf14bec4` |
| `pipeline/astra-usage.js` | `f043b371cf46f45510206e5549bd7f2555c2872e3dca5bbd961e1624765c92e4` |
| `pipeline/astra-egress.js` | `8ca6d748dce11522044d075fc21636a014c12845f21b5039873343271b53e85c` |
| `migrations/astra/037-business-goal-planning-usage.up.sql` | `6ebce2d1a11c87029660bb0ab04552f2221d6adaf8dbe4bdd4a1a3d270996680` |
| `migrations/astra/037-business-goal-planning-usage.down.sql` | `1d954673fb664e716d813ab9cfe7178eb8aecababe8e5d9eab83eeaf37ca6f70` |
| `tests/astra-business-goal.test.mjs` | `93df36a410e7939fe02234cdcde4d7ea0b1b1702891ff0aad8169934b5756a40` |
| `tests/astra-goal-backend.test.mjs` | `5732d9d2b59893753583c6dc01c1f8af9a123458e3c6dadb2297a4f354a769f9` |

`releaseReady` remains false. No files were committed.
