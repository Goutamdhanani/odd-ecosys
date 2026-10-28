# Independent combined integration review

Reviewer: fresh independent `gpt-6.1-sol` / `xhigh` agent. Date: 2026-10-28. Scope is the bounded local combined integration in `PLAN.md`, not production acceptance or the full Astra roadmap. `releaseReady=false`.

Status: final bounded-local SPEC PASS / QUALITY PASS in `FINAL_REVIEW.md`, bound to aggregate `2e275edbb9b5f77f7635a87633f19ddb896395cdb56351502d2a62975b07700a`. R1-F1, R1-F2, R2-F1 and R2-F2 are independently closed. Final native workbench 2/2 passed; all 775 final hashes and original 293 source/index/history preservation rechecked. Raw broad-suite failures/skips and customer AI classification limits remain explicit. No application source, Git, external provider, or existing runtime/production-data mutation by this reviewer; tests used disposable synthetic fixtures.

## R1-F1 — P2: an older saved-goal response can replace a newly created goal

Location: `js/astra-growth.js`, `loadGoal` response at lines 2342–2344 and new-goal selection at lines 2403–2404 (pre-fix source).

Trigger: open an existing saved goal while its GET response is delayed, then submit a new goal. The create response renders the new goal but does not invalidate the existing detail token. When the old GET completes, `loadGoal` accepts its still-current token and replaces `goalDraft` with the old goal. The selected ID remains the new goal ID. This violates the promised selection fencing and makes the visible state disagree with the selected saved goal.

Independent read-only reproduction extracted the exact current `loadGoal` and `handleGoalSubmit` functions into a Node VM with deferred HTTP doubles. It returned:

```json
{"renders":["new-goal","old-goal"],"selected":"new-goal","displayed":"old-goal"}
```

Required correction: invalidate or fence prior detail reads when selecting a newly created goal, and cover the delayed saved-goal GET/new-create ordering in a focused regression. No provider or application data was used in the reproduction. Coordinator notified before final freeze.

Closure: the new create selection increments `goalDetailToken`, and the delayed read also checks its requested ID against `goalSelectedId`. At source SHA-256 `607428014871596a2192b2210cceeaffcb3f867883b9359059eebf21fc39d60`, the same independent VM reproduction returned `{"renders":["new-goal"],"selected":"new-goal","displayed":"new-goal"}`. The dedicated Playwright test at SHA-256 `1bdb03211dba16eda5a412b559b77c669cb2776aee143b2e0fa19ce77b2bf5e1` now delays the old GET while a second create selects a new goal. Independent `node --test --test-concurrency=1 --test-reporter=spec tests/astra-business-goal-ui.test.mjs` passed 1/1, zero skips, exit 0. Finding closed; no source writes by reviewer.

## R1-F2 — P2: QA egress guard delegates an external literal IP when custom lookup exists

Location: `tests/support/astra-qa-egress-guard.mjs`, TCP custom-lookup exception and analogous TLS exception (pre-fix lines 95 and 115).

The imported guard permits a non-loopback host when any custom lookup is supplied, assuming that wrapping the lookup constrains the socket address. Node does not consult DNS lookup for literal-IP destinations. A socket request with `host: '8.8.8.8'` and a lookup returning loopback therefore reaches the underlying transport with the external literal IP. The current self-check tests synthetic hostnames with custom lookup, but does not cover literal IP plus custom lookup. This matters while repinning lifecycle tests to the candidate guard and claiming strict synthetic-only egress enforcement.

Independent reproduction replaced `net.Socket.prototype.connect` with a recording stub before guard import; no actual connection was possible. It returned `{"underlyingTransportStubbed":true,"blocked":false,"delegatedExternalLiteral":true}` for the external-IP request. Required correction: reject non-loopback literal IPv4/IPv6 hosts before allowing the custom-lookup exception; apply the same rule at TLS entry, and retain all existing hostname/loopback/lookup negative tests. Add transport-stubbed literal-IP regressions before repinning the lifecycle hash. Coordinator notified. This is a test safety boundary correction and grants no provider or product execution authority.

First correction review: source SHA-256 `fbd64f3a7a018f1f5f38241d639265adc37c4ee5b1468759c327d3470ea6e83e` introduces early literal-IP rejection at TCP/TLS entry and validates TLS custom hostname lookup results. That addresses the reproduced source bypass. However, test SHA-256 `c70dce296ec7b3c6d867c57b931111736ad445f51f60ec9b9d939c77b376f63a` replaced the existing imported complete guard self-check with only the new TCP/TLS child probe. Removed assertions cover DNS callback/promise/Resolver APIs, UDP send/connect/bind, HTTP fetch, listener normalization, direct/nested transport signatures, and all-results lookup controls. Those existing cases must be restored alongside the additive literal-IP regression before closure. Coordinator notified; no new source defect alleged in this correction.

Closure: independent byte comparison confirms the complete old `tests/astra-qa-egress-guard.test.mjs` is restored exactly from GLM `b949d806f7051872e120cb6921b721ff49c93116`, SHA-256 `99030c3dd9b662d845779cdcab910a4a9205d4ebfd163ee7561c353cd65e9a16`. The new child probe is additive in `tests/astra-qa-egress-literal-ip.test.mjs`, SHA-256 `bdb3f5646dc3d6f3f6262fdb241160fe475de1d040d883e7b25d9701d1873edc`. Its child clears inherited `NODE_OPTIONS`, ensuring explicit transport stubs precede guard import. Guard source remains `fbd64f3a7a018f1f5f38241d639265adc37c4ee5b1468759c327d3470ea6e83e`. Independent `node --test --test-concurrency=1 --test-reporter=spec tests/astra-qa-egress-guard.test.mjs tests/astra-qa-egress-literal-ip.test.mjs` passed 2/2, zero skips, exit 0. R1-F2 closed with old coverage preserved and no actual network.

## R2-F1 — P2: captured JSON reference rows can cross batch boundaries

Location: `pipeline/archiver.js`, `assertNoUncapturedReferences`, pre-fix lines 176–197.

The new guard rejects a JSON reference row that is absent from the snapshot, but allows any already captured row without checking whether its ID array also references leads or sends outside the archived batch. A row captured through `lead_id` can therefore have `related_lead_ids_json=[archivedLead,otherBatchLead]`; archive removes that shared live row while the other batch remains live. This is inconsistent with the existing fail-closed scalar cross-batch check and hides evidence associated with the other batch.

Independent disposable-SQLite reproduction created two terminal leads in separate batches and one `custom_note_refs(id,lead_id,related_lead_ids_json)` row with both IDs. The archive result was `{"disposable":true,"blocked":false,"errorCode":null,"crossBatchReferenceRowStillLive":false,"otherBatchLeadStillLive":true}`. The scratch database was closed and cleaned within its verified temporary-directory boundary. No existing database or provider was used.

Required correction: reject captured lead/send JSON-array references containing IDs outside the snapshot set or invalid IDs, before any archive mutation; add a mixed-batch JSON regression proving an atomic no-mutation conflict. Coordinator notified before final freeze.

Closure: source SHA-256 `b157b9b40ed0de5aecb968a746c4b061929603ad03ea068e5ee9b37532e9e35a` validates the entire array of every captured row, including rows with no matching ID and empty snapshot send sets. It requires positive safe integer IDs belonging entirely to the relevant snapshot set. New regression `tests/archive-json-references.test.mjs`, SHA-256 `1c7e79f8dfcaa289d1019949b84df7ca6f4790665defcc309cd9afa558e5e1d0`, covers mixed-batch lead/send arrays, outside-only arrays, invalid IDs, atomic all-table preservation, and valid same-batch exact archive/restart/restore. Independent archive JSON, campaign archive, unchanged archive lifecycle, and IDN/SMTPUTF8 run passed 24/24, zero skips, exit 0. R2-F1 closed. The SMTPUTF8 follow-up at verifier SHA-256 `bc71bfd09061bb87276951ec87bd56c0affd5ddcd76baea52ad192759b11530e` preserves null for unperformed disposable checks; pinned-list evidence remains separate and no mailbox result is invented.

## R2-F2 — P2: late campaign selection overwrites the current composer

Location: `js/astra-workbench.js`, new `selectCampaign` composer loading/assignment, pre-fix lines 545–555; baseline workbench SHA-256 `09263b61c2920057b9750c80226bd804eabf62d8597f7ad3331b230e00f6629a`.

The new adapter stores composer version/templates after awaits without checking that its tenant/campaign selection is still current. Start a slow selection A, complete selection B, then release A: its composer renders over B while `state.campaignId` remains B. Draft and approval submissions then use B's URL with A's composer version/templates. Server CAS and proof validation still protect acceptance, but the adapter displays the wrong copy and source mapping and cannot consistently save the selected campaign.

Independent read-only Node VM probe extracted the exact current `selectCampaign` function and delayed A's detail response. Output: `{"selected":"B","renderedComposer":"A","paints":["B","A"]}`. No application database or provider was used. Required correction: capture selection generation plus tenant/campaign identity, invalidate it on selection/clear, and fence awaited detail/composer results before assigning or rendering. Add a delayed A→B regression. Coordinator notified before final verdict.

Closure: workbench source SHA-256 `cff67373f90149b0a752fe53ea44d00dd60363c02a178c2c5e195ad71d11fe25` captures tenant, selection epoch and campaign ID; validates after both detail/composer awaits; invalidates the epoch on clear; and binds draft assessment to the current composer scope/campaign ID. It also retains the selected template ID per body line instead of inferring an arbitrary ID from duplicate rendered text. Independent exact-function VM probes for delayed detail A and delayed composer A both returned selected/rendered B with only B painted. The added test checks the shared selection predicate; independent probes cover the adapter's actual await/assignment wiring. R2-F2 closed, with native whole-journey verification still pending at this update.

## Reviewed boundaries so far

- Create and answers queue planning through `afterCommit`; provider I/O is outside the original goal transaction. Full durable goal envelopes and required revisions are present.
- The prior missing start-route `afterCommit` context is corrected. Its native PostgreSQL handler regression invokes the actual registered handler, checks 200/full pending r5 state, and checks that no worker or prospecting create runs inline.
- Start requires tenant owner membership and current revision. It resolves source rights server-side, uses existing prospecting create/runOnce interfaces, and commits the job link before runOnce.
- Source-rights registry resolution fails closed for mismatched tenant/plan scope, revoked/expired/future or ambiguous records. Goal JSON cannot grant rights.
- Goal gateway uses the canonical FreeInference client and egress checks, minimized brief/answers, committed shared usage reserve/settle phases, timeouts, duplicate pending behavior, and retained uncertain spend. The per-goal usage cap is serialized through the global budget row.
- Server session/CSRF, verified tenant membership/RLS, tenant-mode legacy API closure, and explicit static-path allowlisting are present in the reviewed assembly.
- Native SMTP retains provider/approval/capability checks, pinned public DNS destinations, TLS verification, immutable message/ticket binding, and terminal uncertain outcomes. Legacy sender protections remain in source; final regression evidence is pending.

## Mandatory limitations

The assembled business-goal service leaves `classifyGoal` at `unknown`. The canonical usage ledger permits only `synthetic-fixture`; therefore real customer AI planning is blocked until a separate approved classification/policy path exists. This integration does not establish real provider success, grant new rights, enable live egress, send messages, run production migrations, or authorize deployment.

The app report demonstrates actual auth/API/Edge create → durable explicit planning block → reload with synthetic databases and zero provider calls. Migration evidence covers 037 UP/DOWN/UP only on the disposable QA cluster, with an empty-usage rollback. Historical source-pin/artifact tests must be classified separately from behavior regressions; their imported historical assertions are not assumed valid for this combined candidate.

## Additional independent evidence

`node --test --test-concurrency=1 --test-reporter=spec tests/astra-goal-source-rights.test.mjs tests/astra-goal-backend.test.mjs` passed 9/9, zero failures/skips, exit 0. The provider and usage tests use in-process doubles; the source-rights tests use fixed synthetic records. No external provider was contacted.

An independent SHA-256 comparison of all 293 paths in the original private `before/STATE.json` against the original `E:/project/odd-ecosys` checkout found zero changed source files at review time. `git ls-files --stage -z` also matched the preserved index exactly, and HEAD/MERGE_HEAD matched the private starting records. Nine of ten `retainedMainPaths` are byte-identical in the candidate; `index.html` has CRLF-to-LF normalization and one additive `css/campaign-workspace.css` link. That additive integration is not a removed local behavior. Post-integration tree equivalence remains a coordinator operation after final source acceptance.

## Discovery contract ruling

The five inherited `tests/discovery-contact-verification.test.mjs` scenarios assume the older main algorithm, which checked one contact address, optionally tried aliases after rejection, and promoted a confirmed address. The current verifier intentionally enumerates and audits each saved email row plus a missing legacy address and preserves `leads.email`, lifecycle state, and existing `is_primary`. This contract is already explicit in `tests/email-verifier-storage.test.mjs` and `tests/verification-jobs.test.mjs`.

Porting all five scenarios to this per-email contract is acceptable for the bounded combination, provided the final tests retain exact row IDs/spelling/source records, independently checked counts/results/history, unchanged primary/lifecycle state, and zero sends. The difference must be disclosed as an intentional behavior choice. An observed positive alias remains ineligible for legacy campaign sending until an operator explicitly selects a primary: campaign audience checks still require `leads.email` and matching saved evidence. This ruling does not approve implicit promotion, probing, sending, or broader policy rights.

## Historical provenance classification ruling

Retain the raw broad-suite exit code and all failure evidence. Classify individual failing test cases, never whole mixed files, as `MISSING_EXCLUDED_ARCHIVE` when they require intentionally excluded private `.superpowers` archives, or `HISTORICAL_BASELINE_MISMATCH` when they assert exact older R18/R20/live source or dependency-lock/license snapshot pins that do not describe the new combined candidate. Do not rewrite old hashes, recreate private archives, or call those cases green.

Current fixture-negative, source-drift detection, commercial denial (`S01-B02`), and other behavioral assertions remain applicable and must pass. Bind current integration acceptance to a new frozen combined-candidate manifest and independent review, while preserving the old acceptance records as historical evidence. The old dependency inventory is not current commercial/license acceptance for the combined lockfile. Such acceptance remains unverified/blocked under `releaseReady=false`; a local integration review grants no new commercial, provider, source, or deployment permission.
