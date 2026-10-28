# Independent final review — bounded local integration

SPEC: PASS

QUALITY: PASS

Reviewer: fresh independent `gpt-6.1-sol` / `xhigh`; 2026-10-28. These verdicts accept the bounded source integration for the authorized local commit. They do not accept production deployment, commercial/provider/source rights, the historical R15/R18/R20 releases, or the full Astra roadmap. `releaseReady=false`.

## Exact candidate

- Final source aggregate: `2e275edbb9b5f77f7635a87633f19ddb896395cdb56351502d2a62975b07700a`.
- Manifest: `CANDIDATE_FINAL.json`, SHA-256 `32e60e76fd84d7b3f40005efb4debfab8f446172aead4b1ef17dd623224fc0da`; 775 paths. Independently recomputed SHA-256 of compact JSON `files`, checked every listed file hash, and found zero drift.
- Starting HEAD: `a67413efb07cc462386249ded63fda829e269559`; selected GLM source: `b949d806f7051872e120cb6921b721ff49c93116`.
- Broad R2 predecessor aggregate: `7847ddecaa1d9348f1ed2bfa3d3f84e6aa1786568d9d94f63b2735b520490723`. Exactly five paths differ afterward: `astra.html`, `js/astra-workbench.js`, `pipeline/archiver.js`, new `tests/archive-json-references.test.mjs`, and `tests/astra-workbench-e2e.test.mjs`. No predecessor path was removed. Their final deltas have separate focused evidence.

## Spec verdict

The integration preserves the bounded local search, verification, authentication, campaign, mailbox/warmup and customer UI contracts reviewed here. Main/GLM/preserved local source choices, intentional omissions and legacy verification selection differences are documented in the import and integration reports. Paid Bedrock execution was not restored; compatible stored spend-ledger data is preserved. Historical source references are not treated as new acceptance.

Guided-goal create and answer operations persist complete revisioned state and schedule planning after commit. Native route coverage confirms the registered owner-start handler commits the pending reference and schedules its callback without inline prospecting. CAS is required, start is owner-only, and current source rights are resolved server-side before existing prospecting create/runOnce interfaces are used. Gateway deadlines, input minimization, committed shared usage reservations/settlement, call bounds, pending duplicates and uncertain spend remain guarded. Session/CSRF, verified tenant membership/RLS, tenant-mode legacy API closure and static allowlisting remain present. Native and legacy SMTP/sending safeguards were not bypassed or silently enabled.

The verifier intentionally audits every saved email row while preserving primary selection, source records, history and contact lifecycle. Its five inherited discovery scenarios were retained and ported to that explicit contract. Positive observed aliases require explicit operator selection before the legacy campaign audience can use them. SMTPUTF8/unperformed checks remain unknown. SQLite compatibility uses additive migration 8; PostgreSQL migration 037 changes task constraints without enabling policy or egress.

## Quality verdict and closed findings

The detailed findings and probes are retained in `REPORT.md`. No known actionable finding remains open in this bounded candidate.

| Finding | Independent closure |
| --- | --- |
| R1-F1: old saved-goal GET overwrites newly created goal | Selection ID/token fencing; original exact-function reproduction now paints only the new goal; dedicated browser regression passed. |
| R1-F2: QA custom lookup permits external literal IP | Early IPv4/IPv6 TCP/TLS rejection and wrapped hostname lookups. Complete original self-check restored byte-for-byte; separate additive stubbed-transport regression. Independent 2/2 passed. |
| R2-F1: captured JSON references cross batch boundaries | Every captured lead/send ID array must contain valid IDs wholly within its snapshot, including empty-set cases. Independent archive/restore/SMTPUTF8 suite passed 24/24. |
| R2-F2: stale campaign composer replaces current selection | Tenant/campaign/epoch fencing and bound composer assessment. Independent exact-function delayed-detail and delayed-composer probes both preserve B; selected template IDs remain exact when text duplicates. |
| Broad R2 workbench draft contract failure | Operator loads current composer, inserts exact source templates, sends draft/approval revisions and preserves template/claim identity. Final native Edge offline journey and selection check passed 2/2, exit 0. |

The workbench receipt was verified against the implementation report and completed worker result. The journey uses real authenticated handlers with the canonical synthetic PostgreSQL fixture and browser/Node egress guards. It retains unsupported-copy denial, draft, approval, offline plan, quarantine, outcome correction, refund and analytics assertions. Final product hashes are checked before and after. It is not a route-mocked proof of provider success.

Other independent execution included gateway/source-rights tests 9/9, native goal lifecycle/routes 3/3, and goal browser regression 1/1, all with zero skips. No combined unique-test count is inferred by adding reruns. Implementer and coordinator focused evidence additionally covers legacy workflow repairs, migration rollback/readback, current browser fixtures and the actual app goal create → explicit saved planning block → reload.

## Broad-suite evidence and remaining validation limits

Raw R2 remains non-green: **861 tests, 850 passed, 5 failed, 1 cancelled, 5 skipped; exit 1**. Log `.runner/combined-full-r2.tap` independently hashes to `514a3adb1749ddf490473867a74a10dcb0f0cb55f6554780bd814526ced556fe`. It ran against the predecessor, not the final five-path delta. The final focused closures do not rewrite that result.

| Retained case | Classification and limit |
| --- | --- |
| S01-B01 dependency/license snapshot | `HISTORICAL_BASELINE_MISMATCH`: combined lockfile differs from the older frozen inventory. Combined dependency/license/commercial acceptance remains unverified. |
| Side-effect inventory module | `MISSING_EXCLUDED_ARCHIVE`: top-level load requires the intentionally excluded private historical `.superpowers` inventory. Its current inventory assertions therefore did not execute in R2. |
| R20 supplemental provenance | `MISSING_EXCLUDED_ARCHIVE`: requires private historical R20a before-capture. Historical acceptance is not recreated. |
| S00 selected 228-file fingerprints | `HISTORICAL_BASELINE_MISMATCH`: old exact hashes do not describe this new combined candidate. No old pins were rewritten to manufacture acceptance. |
| Workbench 400 response | Actual UI contract defect, corrected and closed by final focused native journey; retained as the original R2 failure. |
| Qualification progress/cancel/retry/restart | Observed 180-second timeout under concurrency 4, followed by explicit cleanup of that disposable test child. Unchanged serial rerun passed 1/1 in 6.46 seconds; cause is not proven and no flake-free full-suite claim is made. |

The five skips remain unrun: dedicated PG34 billing/receipt fixture, migration-032 membership fixture, and three legacy-fixture X-Ray/Radar cases. Applicable negative fixture/source-drift and commercial-denial checks are not waived; current source grants remain closed. The old full-suite acceptance and complete commercial/side-effect inventory acceptance are not part of these PASS verdicts.

Scoped implementation whitespace checks passed. The final whole-import staged check reports inherited Markdown hard-break spaces and blank EOF lines, including pinned migrations. These are disclosed formatting diagnostics; no functional source change or pinned-history rewrite is required to suppress them.

Real customer AI planning remains blocked: the assembled service classifies goals as `unknown`, while the canonical usage policy allows only `synthetic-fixture`. A separately approved classification/policy path is required before real customer briefs can reach a provider. Synthetic gateway tests and the honest authority block do not establish a new real-provider success. Production migrations, real outreach and deployment were not performed or authorized by this review.

## Preservation and local-commit boundary

Immediately before this verdict, the reviewer independently rechecked all 293 original source hashes against private before-state, compared original index entries with the preserved index, and verified unchanged original HEAD and pending `MERGE_HEAD=f30490bd892dd651fd2fb276b09b510379e27c0d`. All matched. Nine of ten explicitly retained paths are byte-identical in the candidate; `index.html` has only line-ending normalization and the additive campaign-workspace stylesheet link.

The coordinator's local-copy/commit script was reviewed read-only. It rechecks original source/index/history, selects bounded source/evidence paths, excludes private/runtime/database/environment paths, checks protected secret values, backs up file collisions and requires exact candidate/main staged-tree equality before the main commit. It preserves the pending merge's history. Execution, final exact-tree checks and the local commit remain coordinator operations after this review; they are not claimed completed here. The script must bind this exact final aggregate and refresh its commit-plan evidence accordingly. No push, deployment, customer database migration or external provider action is approved.
