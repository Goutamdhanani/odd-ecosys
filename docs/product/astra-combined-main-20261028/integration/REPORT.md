# Combined integration implementation report

Plan: `astra-combined-main-20261028`. Owner: `sol_combined_integration`, resumed by `sol_finish_combined` using `gpt-6.1-sol/xhigh`. This is the implementation handoff for the existing bounded integration, not a new feature wave or a release acceptance. `releaseReady=false`.

## Frozen sources and scope

The candidate is in the isolated checkout on `codex/astra-combined-main-20261028`, based at `a67413efb07cc462386249ded63fda829e269559`. The original main checkout, its pending merge with `f30490b`, its index/merge metadata, and its unrelated/private files remain the coordinator's preserved baseline. This worker did not commit, apply to main, push, deploy, or operate on real databases.

The source import is recorded in `../SOURCE_IMPORT.json`: 293 preserved main files and the selected source/test/documentation paths from GLM `b949d806f7051872e120cb6921b721ff49c93116`. The private pre-import source backup is the manifest's existing `backup` location. Source choices were reconciled against the main/GLM inputs in `.runner/combined-merge/` and selected additional inputs in `.runner/accepted-merge/`.

The additional preservation snapshots assessed were:

| Revision | Useful source carried into the candidate |
| --- | --- |
| `c8b575a4d002b26da18e03a939c084dcabbeb3db` | Sending/verification hardening, durable discovery and existing local product behavior already represented by the combined source choices. |
| `74170ed5bfd3b9cadb11ebb6309f3c7d9b8883e9` | Authentication concurrency/origin boundaries, guided campaign and reviewed-copy behavior, stable inbox identifiers, bounded exports, copy-edit guards, plus compatible spend-ledger persistence. |
| `e3af8f11d2d705fe7a6e86f104b41de0cfbb8725` | Pinned offline disposable-domain evidence and per-address verification/display safeguards. |

These preservation commits are source references, not acceptance verdicts. The exact raw-byte and LF-normalized candidate hashes, main/GLM/private merge-input hashes, and matching preservation refs are in `OWNED_PATHS.json`. Its private before/after snapshots and patch allow review of the integration against preserved main without changing the original checkout. The patch ignores CR-at-EOL differences; raw-byte hashes retain them.

## Material source decisions

- **Application assembly:** `server.js` combines the legacy API with Astra routes and a distinct PostgreSQL tenant store for guided goals. The guided planner is invoked through its durable service path. Current source rights are resolved by a bounded server-owned registry; missing, revoked, expired, ambiguous, future, or malformed grants fail closed. Customer goal text cannot grant permission. Goal-service internals and growth UI remain under their separate owners.
- **Local product behavior:** preserved main search/scraper, campaign, contact, authentication, mailbox/warmup, static-file and privacy protections remain present. The accepted guided campaign/review UI is integrated into the existing application shell. API/file timeout handling, explicit error states and verifier result rendering were reconciled without enabling hidden fallback success. No second scheduler was introduced.
- **SQLite compatibility:** existing version-seven spend-ledger migration identity is preserved. Additive version eight reconciles combined discovery/verification columns and indexes for previously migrated databases, without replaying old migrations. The disposable-database test interrupts migration eight, verifies rollback, preserves an existing contact and workspace identity, then verifies successful restart and idempotent readback.
- **Verification evidence:** local syntax/DNS gates, typed optional Reacher health/result validation, domain-only external disposable checks and pinned offline evidence coexist. Provider labels or a lone provider boolean do not become mailbox confirmation. Unknown results retain a separate durable count. Each saved `lead_emails` row receives its own result/history, preserving original spelling, source evidence, existing primary flags and contact lifecycle.
- **Intentional selection change:** the combined verifier does not perform the older contact-level fallback that automatically promoted a discovered or alternate email to `leads.email`. Batch verification checks all saved email rows independently. An existing legacy selected address remains selected; newly positive observed rows require an explicit address-selection action. This is an intentional behavior change from the older fallback, not unchanged compatibility.
- **SMTP safety:** destination validation and pinned public DNS resolution remain in place. One total deadline includes DNS and socket activity, so late DNS completion and slow-dripping responses cannot extend it. The successful-recipient path flushes `QUIT` and destroys its socket even when the peer withholds FIN. Recipient acceptance remains separate from inbox/delivery confirmation. Tests use explicit loopback fixtures; this worker made no external SMTP probes.
- **Archive safety:** terminal-only, whole-batch archival and complete restorable snapshots remain. The broad regression follow-up now rejects unrecognized/nonterminal send states, live delivery-report or tracked-link references needed for delayed evidence, and contact/send references not captured by the relational snapshot, including undeclared JSON arrays. Malformed reference JSON also blocks before mutation. Safe declared and legacy relations still round-trip through the archive/restore transaction.
- **Sending safety:** current campaign preflight hashes, approved copy/audience checks, suppression, verification, sender readiness, owner mailbox review, send claims/capacity, reply stop and uncertain-submission handling remain. The bounded real-browser guided campaign check reached only its loopback SMTP fixture and verified reply cancellation.
- **Provider identity:** legacy personalization still uses the GLM-only application gateway contract. `callBedrock` is a compatibility name that fails closed without tenant workflow context; it does not construct or call an AWS SDK client. Compatible version-seven financial tables and spend-ledger unit tests are retained for existing data. The selected dependency union is retained; dependency presence is not execution permission.
- **Private-file hygiene:** `.superpowers/`, `.codex/` and `.kimi-inputs/` now join existing `.runner/` and `node_modules/` ignore rules. This prevents a later broad Git add from importing private/archived material excluded by the import whitelist. Original directories were not copied or modified.

## Exact omissions

The paid Bedrock approval/execution surface was not restored: `/api/personalize/budget` GET/PUT routes, corresponding client methods/mount and paid subject-polish SDK dispatch are absent. Four accepted-branch-only additions were deliberately not imported: `css/ai-budget.css`, `js/ai-budget.js`, `tests/ai-spend-admission-api.test.mjs` and `tests/ai-spend-admission-ui.test.mjs`. They remain preserved in their source revision/private merge inputs. `tests/personalization-bedrock.test.mjs` instead checks the current GLM-only status, denial before SDK construction or dispatch, and copy guardrails; it does not claim the former paid happy paths work.

The import manifest also excludes `.superpowers/`, `.runner/`, `artifacts/`, `backend/`, `frontend/`, `evidence/`, `.codex/` and `.kimi-inputs/` from GLM source imports. Runtime/private diagnostics, archived source bundles, credentials, real databases and persistent volumes are not part of the candidate. Public test certificate/key fixtures remain allowed. No useful source was deleted from the original checkouts.

Historical provenance/acceptance tests that pin older source hashes or require excluded `.superpowers` archives remain a separate evidence gap. They were not rewritten to bless the combined candidate. The coordinator's broad test result and independent final review must distinguish these old provenance assertions from current behavior failures.

## Verification and the five-scenario contract port

Exact commands, file lists, log hashes and outcomes are in `CHECKS.json`.

1. The resumed bounded 21-file legacy run executed **98 tests: 93 passed, 5 failed**, exit 1, in 173.73 seconds. The five failures were all in `tests/discovery-contact-verification.test.mjs`, which asserted single-candidate checking or automatic primary-address promotion. SMTP safety, database rollback/readback, spend ledger, auth/privacy, API timeout, local-search workflow, guided campaign, warmup review, storage, evidence and offline browser paths passed in that run.
2. The independent reviewer `/root/sol_final_combined_review`, through the coordinator, explicitly required porting all five discovery scenarios to the established per-email/no-implicit-promotion contract already enforced by storage/job tests. The original fixture inputs remain. Assertions now require two unknown rows to produce two checks and histories; positive rows to remain unselected; an existing primary and alias both to be audited without changing the selected address; rejected/positive aliases to retain both audits without promotion; and padded/case variants to retain both original rows, spellings, sources and histories. Every scenario also checks unchanged contact state/provenance and zero queued or sent messages.
3. The affected-file rerun, `node --test --test-concurrency=1 tests/discovery-contact-verification.test.mjs tests/email-verifier-storage.test.mjs tests/verification-jobs.test.mjs`, passed **13/13**, exit 0, in 2.75 seconds. This closes the five reproduced contract failures. Product source was not weakened or changed to satisfy them.
4. The initial `node --check` passed for **439** tracked/non-ignored candidate `.js`, `.mjs` and `.cjs` source, test and tool files. The final run after the broad follow-up passed **441/441**. Private/runtime/archive prefixes were excluded from parsing.
5. `git -c core.whitespace=cr-at-eol diff --check` passed, exit 0. The explicit CR-at-EOL setting accounts for existing mixed/Windows source endings. `git check-ignore --no-index` confirmed all five private/runtime example paths are ignored.

The preceding implementation's latest `.runner/combined-legacy-5.log` passed 17/17. Its older failing logs are retained as repair history and are not the final verdict. Separate goal/UI reports and the coordinator's actual-application checks cover their owners' work; no live-provider success is inferred from synthetic transport or blocked-planner evidence.

## Bounded broad-regression follow-up

After the coordinator's first full run (847 tests, 788 pass, 54 fail, 5 skipped), the coordinator assigned the remaining legacy integration failures to this worker. All **40 identified legacy failing cases** were reproduced or inspected and closed through the affected-path reruns. Astra/UI owners retained their separate paths, and historical source/provenance gates were not rewritten.

Two product defects were confirmed and repaired:

- The local offline-classification overlay changed an unperformed SMTPUTF8/DNS-gated disposable check from `null` to `false`. It now retains the verifier's unknown value while attaching the pinned no-match evidence separately. A true disposable match or provider warning remains intact. The F025 assertions retain `null` for unsupported checks and add the top-level/typed-check invariants.
- The archive snapshot path could remove live delayed-evidence references and leave undeclared JSON references dangling. It now refuses the archive atomically for those references and unknown send states. The five campaign-archive scenarios retain their original data and now assert whole-batch no-mutation conflicts, delayed-report retention, original metadata, full declared/non-FK snapshot restoration, and rollback. The existing eight-test `archiver-lifecycle` suite remains unchanged and passed.

The remaining changes align fixtures with established source behavior:

- The actual warmup review API writes `smtp-imap-source-evidence-v2`; the atomic pre-SMTP gate requires the same version. This producer/consumer path is compatible and passes the real review API/UI fixture. Older downstream SMTP suites had seeded v1 or duplicate reviews. The shared `tests/support/reviewed-mailbox-fixture.mjs` now installs an explicit synthetic reviewed row for named saved `.test`/`.invalid` mailboxes only, requires `NODE_ENV=test`, and installs no hooks or global bypass. Unreviewed/held sender, suppression, uncertainty, SSRF, capacity, and failed-SMTP assertions remain.
- Migration fixtures recreate a genuine earlier schema version before dropping columns/tables. They now assert the exact eight version/name rows and an empty version ledger after rollback, preserving existing records, timestamps, suppression and immutable launch data.
- The tenant offer API uses the existing validator and canonical contained synthetic PostgreSQL fixture. The local SearXNG fixture names the exact operator-approved literal loopback endpoint instead of using the removed broad allow-local flag. No production connection or endpoint authority is inferred.
- Static source denial asserts the stronger public-allowlist 404. Browser locators target the specific evidence badge/workspace, and the route audit uses the current visible “All campaigns” navigation after draft creation. The analytics pure-render fixture supplies only its import-time browser event-listener stub. The edit-guard test accepts either its own socket denial or the enclosing suite's earlier TLS denial, still requiring a specific blocked-egress error.
- The full customer journey gives its two synthetic recipient domains deterministic DNS and a typed loopback Reacher identity/result contract. Both verifier results remain unknown. The downstream sender journey receives separately labeled independent synthetic saved-email eligibility, as the existing guided campaign fixture already does; a provider SMTP boolean is never promoted into mailbox confirmation. Import, durable verification history, list enrollment, sequence copy, actual loopback DATA acceptance, reply stop, reopen and browser/export assertions remain.

Verification is recorded without combining intermediate failures into a false whole-suite pass:

| Affected run | Result |
| --- | --- |
| Archive/lifecycle/SMTPUTF8 product checks | 19/19 pass |
| Migration/search/analytics/verifier/rotation checks | 35/35 pass |
| SMTP/auth/browser workflow group before final fixture corrections | 51/54 pass; three failures isolated below |
| Canonical validated tenant offer API | 1/1 pass |
| Final customer journey, UI route audit, send window, archive and real warmup review targets | 11/11 pass |
| Final candidate JavaScript syntax | 441/441 pass |

The three intermediate workflow failures were the wrong named fixture path, unresolved synthetic `.test` DNS, and a click on the hidden campaign overview after the current UI auto-opened its workspace. The final offer/target reruns close all three. `CHECKS.json` records every exact file list, command, outcome and log hash. The initial frozen integration package remains preserved under `.runner/combined-integration-initial-freeze/`; `OWNED_PATHS.json` records the final 33 resumed source/test/helper edit paths and all integrated path hashes.

No helper agents were spawned by this worker. No real provider calls, public searches, outreach, credentials changes, real data migrations, main edits or commits were performed. The coordinator owns final broad-regression reconciliation, independent review and any authorized local-main commit. Final release/phase acceptance remains open and `releaseReady=false`.

## Independent review follow-up R2-F1: captured shared JSON references

Independent review identified a remaining P2 archive defect after the preceding freeze. A custom note captured through `lead_id` could contain `related_lead_ids_json=[archivedLead,otherBatchLead]`. The earlier check considered the row captured and deleted it with the archived batch even though the other batch still needed that shared row. The same gap applied to send-ID arrays, arrays containing only outside IDs, and invalid IDs in captured arrays.

`pipeline/archiver.js` now validates the complete JSON reference array for every captured row before archive copies, snapshots, deletion or batch closure. Each element must be a positive safe-integer number and must belong to the corresponding lead/send snapshot set. Validation also runs when no array value matches the set and when the batch has no sends. Uncaptured live-reference rejection, terminal-state allowlists, malformed-JSON rejection, delayed delivery-report/tracked-link retention and transactional restore remain in place.

The new dedicated `tests/archive-json-references.test.mjs` reproduces mixed-batch lead and send references, outside-only references (including an empty send set), and 11 invalid ID forms for both reference types. Every blocked attempt compares the complete logical contents and row counts of all pre-existing user tables, preserving both batches, the outside contact/send, shared note, archive rows and snapshot state. A valid same-batch case archives both contacts/sends and restores the exact JSON arrays, note and original records after database reopen. The existing campaign-archive and lifecycle test files were not edited for this follow-up.

Before the source fix, the five new cases produced **1 pass / 4 failures** (missing expected conflicts). The final command, `node --test --test-concurrency=1 --test-reporter=tap tests/archive-json-references.test.mjs tests/campaign-launch-archive.test.mjs tests/archiver-lifecycle.test.mjs`, passed **18/18**, exit 0. Both changed JavaScript files passed `node --check`, and the targeted CR-aware whitespace check passed. Only disposable SQLite data was used; there were no network/provider calls or Git index/commit operations.

This follow-up occurred after the coordinator started the second broad run. That run's original frozen source boundary is preserved; this targeted result does not claim the broad run executed the updated archive source. `ARCHIVE_R2_F1.json` records the preceding and final hashes, focused reproduction/regression log hashes and separate follow-up patch. The preceding `OWNED_PATHS.json`/`CHECKS.json` remain records of their original freeze. This addendum and the dedicated test supersede only the archived source entry for R2-F1; final independent review remains required and `releaseReady=false`.
