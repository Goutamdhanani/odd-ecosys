# Goal selection detail-read race fix

## Scope and behavior

When a saved-goal detail request is still pending and creating another goal selects the new record, the create path now advances `goalDetailToken`. The pending read also checks that its requested ID still matches `goalSelectedId` before it can update the draft or render. This prevents a late response for the previous goal from replacing the newly selected goal.

The dedicated Playwright fixture delays a real mocked browser GET for the previously selected goal, creates a second goal while that response is held, releases the older response, and verifies the new goal remains displayed. Existing tenant, epoch, revision, polling, form submission, and mutation behavior is unchanged.

## Frozen file hashes

| File | Before SHA-256 | After SHA-256 |
|---|---|---|
| `js/astra-growth.js` | `9e9dcdd46a9f9cc846090cdd9c021a5f6026e3f9e7cca799824b2c6b881fb5ee` | `607428014871596a2192b2210cceeaffcb3f867883b9359059eebf21fc39d60` |
| `tests/astra-business-goal-ui.test.mjs` | `3b6eec51c3e18670c5387122f11d25a8f0b9f83cb2c525eb99d6b9f85c8e4fc` | `1bdb03211dba16eda5a412b559b77c669cb2776aee143b2e0fa19ce77b2bf5e1` |

## Verification

- `node --check js/astra-growth.js` — exit 0.
- `node --check tests/astra-business-goal-ui.test.mjs` — exit 0.
- `node --test --test-concurrency=1 --test-reporter=spec tests/astra-business-goal-ui.test.mjs tests/astra-growth-ui.test.mjs tests/astra-campaign-review-ui.test.mjs` — exit 0; 3/3 tests passed, including the delayed-response race regression, growth UI, and campaign review UI fixture.

Browser API traffic was fixture-backed on loopback; no provider, public search, outreach, or recipient calls were made. This is implementation evidence for the bounded UI fix, not product or release acceptance.
