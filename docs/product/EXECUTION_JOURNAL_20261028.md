# Execution journal — 2026-10-28 (session on branch `astra/extended-plan-20261028`)

## X14 addon: execution-ticket emergency-stop propagation

**Working feature:** when a tenant's active launch release is revoked (or the
active pointer moves to another release/campaign), all `issued` execution
tickets of the bound campaign are invalidated, and new execution intents for
that campaign are rejected at mint time with `launch_release_revoked`.

**Why this was missing:** `astra.execution_tickets` is worker-role only by
design (migration 012 grants UPDATE solely to `astra_worker`). The revoke and
pointer-activation paths run in tenant app transactions, so the direct ticket
UPDATE was denied (42501, wrapped as an opaque 404). The release↔send-path
link (X14 "emergency stop / stale tasks") therefore never worked, and
`assertAstraLaunchDispatchCompatible` had zero call sites.

**Implemented (commit `575487e`):**
- `migrations/astra/035-x14-execution-revocation.up.sql` — audited
  SECURITY DEFINER `astra.revoke_issued_execution_tickets(tenant, campaign, reason)`,
  EXECUTE granted to `astra_app` + `astra_worker`, revoked from PUBLIC.
- `pipeline/astra-launch-controls.js` — `revokeAstraLaunchRelease` and
  `activateAstraLaunchPointerInternally` invalidate the pointer campaign's
  issued tickets through the definer function; counts recorded in events and
  return values. Also fixes a latent `GROUP BY r.id` error in the activation
  query (PG 16 refuses non-aggregated selected columns).
- `pipeline/astra-autonomy.js` — new `assertCampaignLaunchNotStopped`
  emergency-stop gate consulted by `issueAstraExecutionTicket`
  (`launch_release_revoked`, 409); `invalidateAstraCampaignTickets` migrates
  to the definer function (same latent denial fixed).
- `tests/support/astra-r20-fixture.mjs` — canonical fixture pins extended to
  migrations 001–035 (034 was already un-pinned/drifted; both now hash-pinned).
- `tests/astra-launch-revocation.test.mjs` — new fixture-backed tests.

**Evidence (disposable synthetic cluster `r20-source-rights`, 35 migrations, realData=false):**
- `astra-launch-revocation.test.mjs`: 2/2 pass — stop-gate (no pointer OK,
  approved pointer OK, revoked pointer rejects), revocation invalidates exactly
  the pointer campaign's issued tickets (succeeded + foreign-campaign tickets
  untouched, reason tagged `launch_release_revoked:`), pointer activation
  invalidates the previous campaign's issued tickets.
- Regression: `astra-execution-copy-proof.test.mjs` and
  `astra-composer-persistence.test.mjs` still pass (5/5 combined).

**Limits:** no live dispatch, no campaigns outside fake fixtures, no release
activation without the X14/S01 server flags (test enables them locally for a
disposable-synthetic run), `releaseReady=false`. The r20 label fixture in the
astra-foundation worktree is untouched; my QA cluster is a separate fresh
cluster created by the sanctioned `prepare-qa-db.py` path.

**Next:** per the master spec, the next vertical slice is the guided-goal
journey (`astra-guided-goal-20261028` brief): customer goal → bounded planner
→ owner-confirmed start → discovery/research/qualification → saved prospects,
with the 3-call GLM + 1-search budget, using `assertCampaignLaunchNotStopped`
patterns once dispatch-adjacent.
## Guided business-goal journey (commit `8de2c93`)

**Working feature:** a customer-facing panel (growth.html view Discover) where
the user types their goal ("I sell SEO audits to plumbers in Austin"), the app
durably records it, a bounded planner structures a plan and asks only missing
questions, and after the owner confirms, a start request is handed to the
prospecting service — with blocked states shown verbatim.

- `036-business-goal-runs.up.sql` — RLS tenant-scoped table, revisions for CAS.
- `astra-business-goal.js` — idempotent create (Idempotency-Key), answer CAS,
  first-class blocked (planner authority/gateway/prospecting unavailable),
  owner-only start with version check.
- `astra-goal-planner.js` — DI bounded planner, 3-call/step-deadline limits,
  returns blocked + reasons when unconfigured (never mocked AI).
- Routes under /business-goals registered + assembled in server.js after the
  real prospecting service; growth.html/js panel wired.
- Fixture pinned through 036; 3 new tests.

**Evidence:** 8/8 focused tests pass on the disposable synthetic cluster.
**Blocked (honest):** real GLM planning is blocked until the sanctioned
gateway path + S01/X14 authority are configured (the planner then returns
`goal_planner_authority_disabled`); the authenticated browser round-trip
needs the app session stack (next step with the running preview pattern).

## Authenticated HTTP proof of the guided-goal journey

Against a live app instance (port 3213, NODE_ENV=test, real auth, disposable
QA PostgreSQL cluster, ASTRA_TENANT_MODE=1):
- login → workspace create → goal list → create with Idempotency-Key →
  same-key replay returns the same goal → different-brief conflict 409 →
  get by id → answers returns honest blocked (planner authority disabled,
  reason persisted) → start rejected instead of fabricated → cross-tenant
  hidden. **8/8 checks pass** (docs/product/evidence/business-goals-http-proof-20261028.json).
- Authed GET /growth.html and /js/astra-growth.js serve the goal panel and
  handlers (200, panel present).

## Real GLM planning proven (commit pending)

The live planner step ran through the real FreeInference gateway (glm-5.3-flash)
against the synthetic plumbing brief and returned an in-schema plan: offer
summary, target industry, country/city, objective, targetCount 50, four honest
unknownCommercialFacts, assumptions, and three follow-up questions — persisted
in the goal run (awaiting_confirmation). Owner-confirmed start returned the
honest blocked state (prospecting_unavailable) because the Mongo-backed
prospecting service is not provisioned for this synthetic run. Two earlier
provider attempts surfaced real gateway behavior (schema gate too strict;
output truncation at 900 tokens) and were fixed in the adapter
(max_tokens 4096, reasoning_effort low, questions allowed). Provider calls for
this run: 3 completions + models discovery — exactly the guided-goal budget.
