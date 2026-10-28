# Astra browser fixture repairs

## Findings and changes

- `astra-growth-design.test.mjs` and `astra-source-rights-ui.test.mjs` served `astra-growth.js` without its statically imported `astra-campaign-draft.js`. The browser rejected the module before UI initialization, causing the inbox navigation and workspace heading timeouts. Both fixture servers now serve the imported module.
- `astra-growth-journey.test.mjs` still addressed campaign and claim selectors inside `#draft-form`, though the current editor keeps campaign selection in `#campaign-select` and uses exact templates in `#draft-fact-picker`. The fixture now inserts the service-provided subject and body templates and explicitly loads the persisted campaign review before approval. The journey’s evidence, qualification, save, approval, offline-plan, and readback assertions remain active.
- No product source was edited. The earlier goal UI race fix remains frozen at SHA-256 `607428014871596a2192b2210cceeaffcb3f867883b9359059eebf21fc39d60`.

## Frozen test hashes

| File | Before SHA-256 | After SHA-256 |
|---|---|---|
| `tests/astra-growth-design.test.mjs` | `9bf87daf27af86d3dbc436fdcbe24246f1bdd025453d4c67d91282d84386933a` | `e3eb230c5e0d2252334d842585fb2367402fe5812c0a1cbd6e0ae6c04cf77708` |
| `tests/astra-growth-journey.test.mjs` | `3f8b1b0a50069db013a04e592a2d7eb35f2c4d3fb77149cb703ed372b6aabce1` | `64497a2ded527014e956a42ad5fc6fd47df1c5f44e9d262ff99a7472fedf8a04` |
| `tests/astra-source-rights-ui.test.mjs` | `7c908a2f1a75e280d5dcf248b4b3ac74d77c082a159385e893e4bc1966470400` | `056fbc18be4345d079d4630abdf82521c05565cdb428f01d09cb9e1836c282d8` |

## Verification

- `node --check` passed for all three test files.
- With `ODD_CHROMIUM_EXECUTABLE_PATH` set to the installed Playwright Chromium and `ASTRA_QA_FIXTURE_PATH` set to `.runner/astra-qa/r20-source-rights/pg.json`, `node --test --test-concurrency=1 --test-reporter=spec tests/astra-growth-design.test.mjs tests/astra-growth-journey.test.mjs tests/astra-source-rights-ui.test.mjs` exited 0: **3/3 passed**.
- The journey used the disposable R20 QA fixture and loopback browser/app endpoints. It reported zero browser errors; policy remained offline. No provider, public-search, outreach, or recipient calls were made.
