# Guided-goal customer UI integration

## Changes

- The Discover form now saves the brief first and reports the returned draft honestly while asynchronous planning runs. It polls the saved goal by ID, bounded to 30 checks at two-second intervals, and resumes for the selected workspace after page reload, navigation back to Discover, or tab visibility changes.
- Saved goals load from the workspace list and can be reopened. Workspace changes clear the selected goal and cancel stale polling; responses are fenced by tenant, epoch, selection, and revision.
- Follow-up answers use a native form submit handler, so keyboard submission works. Mutations send the current `expectedVersion`, deduplicate overlapping submissions, reconcile incomplete mutation envelopes with a saved GET, and refresh after version conflicts.
- Only owners see the start action. It submits `expectedVersion` only; source permission is resolved by the backend. A linked job opens in the existing prospecting progress widgets after the backend returns its actual job ID. The UI polls the temporary `starting` reference and then stops polling the goal.
- Plans show explicit target counts, assumptions, and unknown commercial facts. Block reasons are rendered as text without interpreting markup. Existing campaign composer/review code was left intact.
- The older browser fixture now serves `js/astra-campaign-draft.js`, includes the campaign composer fixture response, and scopes ambiguous locators to their owning forms. Its existing behavior assertions remain in place.

## Verification

- `node --check js/astra-growth.js`, `node --check tests/astra-business-goal-ui.test.mjs`, and `node --check tests/astra-growth-ui.test.mjs` passed.
- `node --test --test-concurrency=1 --test-reporter=spec tests/astra-business-goal-ui.test.mjs tests/astra-growth-ui.test.mjs tests/astra-campaign-review-ui.test.mjs tests/astra-discovery-journey.test.mjs` passed **9/9**. The browser fixtures verify create deduplication, persisted planning polling, keyboard answer submission, revisioned owner start, linked job progress, reload continuity, blocked-reason text rendering, reviewer restrictions, workspace reset, campaign review, and discovery behavior.
- Trailing-whitespace scan on the owned source, test, and report files passed.
- Browser API calls were fixture-backed. No live provider, public search, outreach, or recipient calls were made.

## Contract and limits

The UI follows the backend contract: create returns a durable `draft`; the after-commit planner leaves it `draft` until it becomes `planned`, `awaiting_confirmation`, or `blocked`; start commits `running` with a temporary `prospecting_job/starting` reference, then the worker either blocks it or replaces the reference with the durable job UUID and state. Goal polling is bounded and stops when the start reference resolves. The linked prospecting job's existing progress view owns subsequent status updates. The goal row does not claim completion because the backend has no goal-completion callback.

An absent or invalid server-resolved source permission is shown as a backend blocker; the goal form does not ask customers for rights text, UUIDs, hashes, or JSON. The browser test proves the client contract with realistic mocked HTTP responses, not the live PostgreSQL/worker path.
