# Astra S02 offer foundation report

**Disposition: partial foundation, independent review pending.** This slice adds immutable offer versions and a guarded binding to the existing campaign launch snapshot. It does not establish S02 acceptance for production. The source is the isolated checkout at HEAD `f30490bd892dd651fd2fb276b09b510379e27c0d` with the 228-file source overlay recorded by `docs/astra/source-snapshot.json` (manifest SHA-256 `a688a159676ddf3fbbce6ac8ac894d582f5644afbfee70b63416379f8f0474fd`).

## Behavior added

`offers` stores a named offer, and `offer_versions` stores immutable canonical JSON, schema version, SHA-256 content hash, version number, creator, approval metadata, and revocation metadata. SQLite prevents edits/deletes to version content, duplicate version numbers, invalid status transitions, and edits to proof-rights and proof-revocation records. Each proof asset records a reference, content hash, observed time, expiry, and declared rights basis. Owner/admin approval writes immutable rights approval metadata for every proof. Owners/admins can revoke a version or an individual proof; old versions remain available for audit.

The validator bounds service and scope text, validates ordered non-negative integer minor-unit price bounds and a three-letter currency code, requires nonexpired proof references with SHA-256-shaped hashes, checks two-letter geography codes and disjoint include/exclude lists, validates exclusions and positive capacity, and accepts the blueprint's `MINIMIZED_REMOTE`, `APPROVED_REMOTE`, and `NO_MODEL_EGRESS` settings. These checks verify code format; they do not establish actual ISO country/currency membership or resolve references to prove that the referenced bytes match their supplied hash.

The API is authenticated. Offer creation/versioning and approval/revocation require the trusted session to be owner or admin. A request body cannot supply approval state, actor, or lifecycle timestamps. Draft campaigns bind through `PATCH /api/sending/campaigns/:id` using `offerVersionId`; only a currently approved version with current proof can be bound. Preflight checks approval, proof expiry/revocation, proof-rights approval, geographic inclusion/exclusion, and exact category exclusions against the existing contact `category` field. Queue rechecks the policy and skips an out-of-scope recipient. The worker checks the bound offer before claiming a queued send and again immediately before SMTP; a revoked/expired offer or proof cancels the queued row and releases its daily-capacity reservation without retrying it. An external SMTP submission already in flight cannot be recalled; existing uncertain-submission handling remains authoritative for that boundary.

The launch snapshot adds the version ID, offer ID/version, content hash, policy version, canonical content, and rights approvals only when `campaigns.offer_version_id` is non-NULL. Existing NULL campaigns serialize with the previous snapshot keys and hash inputs. A bound offer version remains immutable; editing an offer creates another draft version. The implementation uses the existing launch snapshot and send state owner.

Offer approval records business terms and proof rights. It does not authorize outreach or replace campaign/send permission. Existing suppression, sender health, compliance, recipient eligibility, campaign review hash, and SMTP ambiguity safeguards continue to apply. `NO_MODEL_EGRESS` is a model disclosure setting; deterministic email dispatch is not treated as a model call. This slice makes no model calls.

## Remaining gates and limits

The application remains a single-workspace database with no tenant/workspace ownership on offer rows; S03 must define and test tenant boundaries and a reversible ownership migration. Offer capacity is stored and bound into the snapshot, but this application has no canonical customer/deal capacity ledger to consume slots against; a prospect count is not a defensible substitute for sold delivery capacity. Audience exclusions currently match the existing category field exactly, case-insensitively. Proof references and rights bases are attested during owner/admin approval; this code does not fetch or independently validate third-party source rights. The three egress modes are persisted and validated but no model gateway exists in this slice to enforce them; S06 remains required. Offer-aware copy controls and evaluation (S14/S18) remain pending. GLM commercial/privacy, jurisdiction and data-provider rights gates remain open. Campaign authorization, S19, S03 tenant isolation, the event/outcome ledger, and other release gates remain open, so this is not a production-ready or S02-accepted claim.

## Changed file fingerprints

Baseline hashes are from the selected source overlay manifest; current hashes cover the complete files after this slice.

| File | Overlay baseline SHA-256 | Current SHA-256 |
| --- | --- | --- |
| `pipeline/database.js` | `21c264b83995d7e12d8a8c87fd4f74d1d2fc12478b05a4758260f013bfdd4f5b` | `816a52e9f56cbbf2f4d9571ea61a9e3d77cc1b6b3cc54c1f83c37e49f1c741cc` |
| `pipeline/sending-engine.js` | `39d90158f453977721544bc08c6ad7917917a8851ed15b268a81349e960c1639` | `5684a2906f022ba09d3f2a1c6ef89aeea8875ad67843f0cdcdb73a98ab087454` |
| `server.js` | `8bbd27357bb94a0f7aa9b8913381aa513d69f48d10ec09dfb411cd3806c75613` | `925c1cffeb7137a4821999678ae3a87436f7c218f46e7464af1b4052789f112b` |
| `tests/campaign-launch-snapshot.test.mjs` | `902a88e9f04246f8f1cada073f50d81c17f6b88da65d1848a45fbbdba33d3de7` | `970a5a8fcc96b4b4257c9e432ee39d3aa3ae33b360b89aa8737d25651450660b` |
| `pipeline/offer-contracts.js` | New | `4ce112efd096a2b2922cb989c0819dcf40acf7edd033d09c910b3b04ac12572b` |
| `tests/offer-contracts.test.mjs` | New | `feda78072339ff1547b8e28b62f90d89c9836811f79d2ba3e47d89238a25afaf` |
| `tests/offer-contracts-api.test.mjs` | New | `f1a74098aa6207b2c574348c0e628dcd9f41c29fe73f900e5f357e5912a9354e` |

`tests/campaign-preflight.test.mjs` is owned by this slice but unchanged from its overlay baseline SHA-256 `431db4ed026d4ee76004a0b8c15ab5465d40a1ef6e42e12ebdc6cea16c597f32`; existing preflight coverage remained useful without an artificial test edit.

## Focused verification

All commands ran in the isolated checkout against disposable SQLite databases and synthetic contacts. The launch/preflight tests used only their loopback SMTP sink. The offer contract test also seeds campaign, send, suppression, and immutable launch history, removes the newly added nullable campaign column to model the prior schema, reopens through the real initializer, and verifies IDs, NULL binding, and exact snapshot JSON/hash are retained.

| Command | Result |
| --- | --- |
| `node --test tests/offer-contracts.test.mjs tests/offer-contracts-api.test.mjs tests/campaign-launch-snapshot.test.mjs tests/campaign-preflight.test.mjs` | exit 0; 10 passed (offer immutability/validation, trusted API lifecycle and concurrent versions, additive migration preservation, legacy and bound launch snapshots, revoked queued proof blocked before loopback SMTP, preflight and geography checks) |
| `git diff --check -- pipeline/database.js pipeline/offer-contracts.js pipeline/sending-engine.js server.js tests/offer-contracts.test.mjs tests/offer-contracts-api.test.mjs tests/campaign-launch-snapshot.test.mjs tests/campaign-preflight.test.mjs` | exit 0; Git reported only line-ending normalization warnings |

The parent recorded one pre-change baseline failure in `tests/campaign-lifecycle.test.mjs`: the pause/resume queue fixture received 409 because it lacked required synthetic `mailbox_warmup_reviews` evidence. QA added that evidence in the test fixture without weakening assertions; the parent reports 2/2 lifecycle tests pass against the exact frozen baseline. This slice did not edit that file or relax send readiness.
