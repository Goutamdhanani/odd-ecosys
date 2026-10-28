# Combined Astra/GLM local integration — 28 October 2026

The selected GLM source and useful local changes have been combined and repaired in `codex/astra-combined-main-20261028`. The final product fingerprint is `2e275edbb9b5f77f7635a87633f19ddb896395cdb56351502d2a62975b07700a` across 775 source/test/configuration/governance paths. This is a local development integration, not production or 52-task roadmap acceptance. `releaseReady=false`.

## Source preservation and choices

- GLM baseline: `b949d806f7051872e120cb6921b721ff49c93116`, built on preserved Astra `b9a6e21`.
- Main baseline: `a67413e` with the unfinished merge of `f30490b`, existing staged/unstaged work and 293 preserved source paths. Original source, index and merge metadata were backed up privately and independently checked before integration.
- Useful compatible improvements from `c8b575a`, `74170ed` and `e3af8f1` were reconciled, including authentication, campaign editing, verification evidence, local search, warmup and data retention.
- Four accepted-branch paid-provider UI/API additions were deliberately not imported. The canonical GLM identity remains; legacy paid execution stays disabled. Compatibility storage and its accounting/security tests remain.
- Private runtime files, secrets, customer databases, `.superpowers` diagnostic archives and unrelated local files were not imported into Git. Known protected environment values were scanned against selected source without printing them; this is not a universal secrets or credential-rotation certification.

## Connected fixes

The guided-goal API/UI now saves and reloads complete versioned goal state, schedules planning after commit, runs provider work outside the goal transaction, applies results by revision CAS, preserves answers and handles duplicate polling without overwriting an active result. It uses durable canonical usage reservations, three-call limits, enforced deadlines and explicit blocked/reconciliation states. Owner start uses the existing prospecting `create`/`runOnce` interface and server-resolved current source permissions; customers do not supply internal IDs or grant JSON.

The operator workbench now loads actual composer templates and campaign versions, preserves the selected proof mapping, rejects unsupported copy in that editor, performs version-checked saves/approvals and fences delayed campaign responses. The customer console retains its verified composer/review and discovery behavior; a stale goal-selection response race was repaired with a browser regression.

Local main's SMTP total deadline, DNS/destination checks, cleanup, suppression and uncertain-submission behavior were retained. Verification audits individual saved email records without implicitly promoting aliases or inventing mailbox confirmation. Unsupported SMTPUTF8 disposable checks retain unknown/null evidence. Archive operations now block unsafe shared scalar/JSON references, unknown send states and delayed delivery evidence before mutation, while safe snapshots remain restorable. The QA network guard now blocks external numeric-IP/custom-lookup bypasses while retaining its complete earlier self-check coverage.

## Actual verification

| Evidence | Exact result and scope |
|---|---|
| Broad R1 | 847 tests: 788 passed, 54 failed, 5 skipped; exit 1. Retained repair history. |
| Broad R2 | 861 tests: 850 passed, 5 failed, 1 cancelled, 5 skipped; exit 1. Bound to predecessor fingerprint `7847ddec…`, before the final archive/operator corrections. |
| Final operator journey | 2/2 passed in actual Edge with authenticated app HTTP, temporary SQLite and disposable PostgreSQL. Includes source-backed copy, approval, offline plan/quarantine, outcomes, refunds, analytics and delayed selection. |
| Goal backend | 10/10 passed with the strict 37-migration synthetic PostgreSQL fixture and explicitly synthetic gateway transports. Includes actual registered owner-start handler scheduling. |
| Independent archive/verifier checks | 24/24 passed after shared-reference fix, including retained restore scenarios and unsupported SMTPUTF8 evidence. |
| Network guard | Original complete self-check restored byte-for-byte; separate literal-IP regression added. Both pass, including parent-preload mode; no Internet transport. |
| Customer app/browser | Actual authenticated save → initial planning attempt → persisted explicit block → reload passed. Running preview readback is recorded in `PREVIEW_CHECK.json`. |
| Migration 037 | UP → DOWN → UP passed only on the new disposable QA cluster. No production/customer migration was executed. |

Rerun counts overlap and are not summed into a new unique-test total. The original 100-scenario registry was not rewritten.

Scoped implementation whitespace checks passed. A final whole-import staged whitespace check also reports inherited Markdown hard-break spaces and blank EOF lines, including immutable migrations. These formatting diagnostics remain disclosed; pinned migration bytes and historical reports were not normalized to remove them.

## Remaining limits, openly retained

Four R2 failures describe old source/archive/license snapshots, not the new combined tree. Their assertions and original records remain intact; private archives were not recreated and old hashes were not changed to manufacture acceptance. The combined dependency/license inventory still needs separate commercial acceptance. One qualification test timed out at 180 seconds under concurrency four; its unchanged serial rerun passed in 6.46 seconds, and its prior R1 run passed. The raw timeout remains an observed resource-sensitive validation issue. Five dedicated PG32/PG34 scenarios remain skipped because their separate fixture requirements were not met.

The fifth R2 failure exposed the actual operator copy contract defect. The final adapter and full focused browser journey now pass on the final fingerprint. The final archive delta also has its own independent focused evidence; no claim is made that the entire broad suite ran again against those final deltas.

Customer AI planning remains disabled by default: the assembled classifier returns unknown and the canonical usage policy permits only approved synthetic fixtures. Source rights, provider authorization and budgets remain enforced. Previous real GLM receipts are retained as earlier bounded evidence, not a fresh live run of this combined candidate. No new inference/search/public-page requests, live outreach, production migration, deployment or push occurred.

## Local inspection and Git handoff

The local preview is `http://localhost:3213/growth.html`, with synthetic data, external actions disabled and outreach disabled. It runs from the isolated combined checkout. The browser's saved synthetic goal shows the genuine `goal_planner_authority_disabled` block; it does not pretend research completed.

The final main handoff requires the independent final review for this exact fingerprint, a last original-main preservation check, a source-only allowlist, protected-value scan and exact staged-tree equivalence. The existing main merge history is retained. Git HEAD and the private `COMMIT_RESULT.json` record the resulting local commits; no remote push or deployment is part of this handoff.

See `SOURCE_IMPORT.json`, `integration/REPORT.md`, `goal/REPORT.md`, `ui/WORKBENCH_CHECK.md`, `TEST_RECONCILIATION.json`, `review/CANDIDATE_FINAL.json` and `review/FINAL_REVIEW.md` for precise boundaries, hashes, commands and independent findings.
