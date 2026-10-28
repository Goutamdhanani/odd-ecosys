# Workbench draft contract check

**Status: focused verification passed.** The R2 browser runner previously failed on the real draft save because the operator form sent manual copy without the current campaign version or server template identity.

## Adapter and corrections

- Campaign selection loads `/composer`, including the current campaign version, server validation, subject template, and source-backed body templates. Results are applied only while tenant, campaign, and selection epoch still match; the selected composer is rechecked against that scope before its version or templates can be used.
- The workbench shows exact rendered copy with source URL and literal excerpt. Operators can insert a specific template. Selection preserves that template ID even when multiple claims produce identical rendered text. Free-form text that cannot be bound to the selected current template remains unverified and cannot be saved or approved.
- Save sends the composer `expectedVersion` and only the exact template/claim mapping selected in the editor. Approval requires current saved verified copy and sends the current campaign version.
- The end-to-end journey checks unsupported text remains unverified, selects a template returned by the actual workbench composer, verifies version CAS and mappings in the UI-generated save request, and retains campaign approval, offline plan, quarantine, outcome, refund, analytics, and readiness assertions.

## Verification

Command: `node --test --test-concurrency=1 --test-reporter=spec tests/astra-workbench-e2e.test.mjs`

Environment: `ASTRA_QA_FIXTURE_PATH=.runner/astra-qa/r20-source-rights/pg.json`; `NODE_OPTIONS=--import=./tests/support/astra-qa-egress-guard.mjs`; the test's loopback browser guard and Microsoft Edge.

Result: **2/2 passed, 0 failed, exit 0**. The delayed campaign-A response was discarded after campaign B became current. The full offline operator journey passed in Edge (27,612 ms; combined test process 37,165 ms), including draft, approval, offline-only plan and quarantine, outcome correction, refund and analytics assertions. The browser guard blocked the expected external Google Fonts request. No provider or recipient was contacted.

The test is bound to `docs/product/astra-combined-main-20261028/review/CANDIDATE_FINAL.json`; its end-of-run check confirms the frozen product hashes stayed unchanged. The historical R15 runtime manifest remains untouched. No full-suite or release-ready claim is made; keep `releaseReady=false`.
