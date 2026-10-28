# Independent review — Astra S02 foundation

**Review scope:** Frozen A1 deltas listed in `.superpowers/sdd/a9126db5a9fcd7b3/review-offer-round-1.txt` and QA-only fixture delta in `review-qa-support.txt`, against source HEAD `f30490bd892dd651fd2fb276b09b510379e27c0d` and overlay manifest SHA-256 `a688a159676ddf3fbbce6ac8ac894d582f5644afbfee70b63416379f8f0474fd`. This review does not accept the inherited dirty overlay or the full platform.

## Verdicts

**SPEC — PASS for the bounded local foundation prototype; S02 acceptance remains incomplete.** The implementation adds immutable versioned offer content, trusted owner/admin lifecycle operations, proof expiry/revocation checks, geography/category exclusions, a bound launch snapshot, pre-queue and pre-SMTP checks, and a NULL legacy path. It does not claim that offer approval grants outreach permission. The mapping recorded S02 as `new_development` at the frozen pre-increment baseline; that is a task acceptance status, not a claim that this prototype made no progress.

**QUALITY — PASS for this frozen slice.** The reported focused run passed 10/10 tests; the final foundation log records 22/22. Tests cover lifecycle permissions, immutable versions, concurrent version creation, migration preservation, legacy/bound snapshots, and revoked-proof blocking before loopback SMTP. The lifecycle fixture correction adds the required synthetic warmup-review row and retains its readiness and send assertions. The review did not rerun the suite or treat these focused results as broad acceptance.

## Deferred acceptance limitation

**S14/S18 scope — Offer-to-copy price and scope consistency is not implemented in this slice.** In `pipeline/sending-engine.js:1211-1219`, the offer recipient predicate checks only country and exact category exclusions. Preflight (`:1306-1344`), queue (`:1549-1556`), and the pre-SMTP gate (`:1906-1912`) revalidate offer lifecycle and recipient scope, while `sendContentMatchesLaunch` (`:1185-1204`) verifies that campaign copy still matches its snapshot. None compares that copy to the approved offer's service, scope, price range, or currency. A campaign can therefore bind an approved USD 100–900 offer and pass offer preflight with copy stating a different price or service. The focused tests validate price shape but do not exercise copy/price mismatch.

This is an expected boundary of the bounded S02 foundation, not a defect that should pull S14/S18 work forward or invalidate this prototype verdict. The API and report must continue to describe the offer as a stored/bound policy contract, not as proof that outbound claims match it. Before claiming offer-aware message compliance or production readiness, S14/S18 must add the applicable checks and mismatch tests; until then, the contract's price/service/scope fields are not enforced against copy.

## Verified boundaries and remaining gates

- The selected checkout HEAD and overlay digest match the handoff. `combined-backlog.json` has 52 distinct task IDs and a 52-entry topological order; every dependency appears earlier in that order. S33 includes X14, and X14 depends on X07, X08, X10, X11, X12, and S29. The recorded statuses are acceptance statuses; the mapping is not represented as implementation acceptance.
- Capacity is stored in the version and launch snapshot but is not consumed against a customer/deal ledger. Treat capacity as descriptive policy until that ledger exists; do not infer that available capacity was reserved.
- Proof source bytes are not fetched or hashed by this code. The supplied SHA-256-shaped value and rights basis are owner/admin attestations; they do not prove that the referenced bytes or rights are authentic. Require verified source evidence before production use.
- Egress modes are persisted contract metadata. There is no model gateway here to enforce them, and deterministic SMTP is not a model call. `NO_MODEL_EGRESS` must not be read as a general network-egress control.
- Country and currency validation checks only two-/three-letter formats, not authoritative ISO membership. Tenant isolation (S03), event/outbox idempotency (S04), workflow ownership (S05), gateway enforcement (S06), and campaign/send authorization (S19) remain open. The offer API must not be used to bypass any of those gates.
- S00 evidence is a source-backed, synthetic trace with explicit stop points. It is not a composed research-to-revenue run; no meeting, sale, or revenue outcome was observed. The newer source's baseline evidence and the older redesign checkout remain separate.

## Evidence reviewed

- `docs/astra/IMPLEMENTATION_HANDOFF.md`, `source-snapshot.json`, `combined-backlog.json`, `offer-foundation-report.md`, `baseline-validation.md`, and `qa-s00-trace.md`.
- `docs/astra/ADRs/0001-tenant-migration.md`, `0002-workflow-ownership.md`, and `docs/astra/contracts/README.md` plus the harness schema.
- The two frozen review deltas, focused test log, S02 implementation and tests, and the independent reviewer contract at `C:/Users/pooja/.codex/skills/subagent-driven-development/references/reviewer.md`.

**Release decision:** This review approves only the bounded local prototype slice. It does not approve production, live SMTP, provider access, tenant migration, or completion of S02 or the 52-task backlog.
