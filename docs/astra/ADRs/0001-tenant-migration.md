# ADR 0001: Preserve legacy identity while moving to tenant-scoped storage

- **Status:** Proposed design; S00 source map exists. No migration has been run.
- **Date:** 2026-10-24
- **Scope:** S03, with prerequisites for S04, S05, S06, S07, S16, S17, S31 and S33.
- **Decision owner:** Product/data owner and migration reviewer, to be named before S03 implementation.

## Context

The selected source snapshot is `f30490bd892dd651fd2fb276b09b510379e27c0d` plus the source-snapshot overlay recorded in `docs/astra/source-snapshot.json`. The inspected application uses one process-wide SQLite database. Core records such as batches, leads, email evidence, imports, mailbox configuration, campaigns, launch snapshots, sends, events, verification and discovery jobs, usage and suppression are not keyed to a tenant. Auth users and roles describe a single workspace; workspace routes and member invitations do not establish ownership for those global records. `suppression_list` is explicitly global and keyed by email. Existing integer IDs and foreign keys establish relationships inside this database, not tenant isolation.

The target is PostgreSQL-centered storage with `tenant_id` on every tenant-owned record and tenant-compound references such as `(tenant_id, id)`, with RLS or equivalent enforcement. The mapping has not identified historical tenant ownership for the global rows. A single current workspace assumption is not evidence that every old row belongs to a future tenant, nor that each user is an independent tenant.

## Decision

Use an additive, manifest-driven migration to the PostgreSQL candidate after S03 maps the full schema and identity graph. Preserve every source row, original integer ID, external/provider ID, foreign-key lineage, campaign launch hash, send state, event timestamp and source payload required by the approved retention schedule. Target internal IDs may be newly allocated, but keep a durable source-key mapping `(source_database_fingerprint, source_table, source_pk)` to `(target_tenant_id, target_id)`; never reuse an old integer ID as a globally unique tenant identifier.

Create target tenant and membership records only from an owner-approved, evidence-backed mapping. Do not create a default tenant, synthesize a “tenant 1,” infer tenant ownership from user role, or assign every global row to the first owner. Rows with no defensible tenant mapping go to a restricted quarantine set retaining source table/key, checksum, relationship references, reason code and migration-run ID. Quarantined rows are unavailable to tenant reads, exports, memory and dispatch until a named owner resolves them. Referenced child rows remain quarantined with their parent or an explicit unresolved-reference status; do not break lineage by attaching them to a convenient tenant.

Candidate table mapping and effects:

| Current source records | Candidate target treatment | Required migration fact / effect |
| --- | --- | --- |
| `auth_users`, `auth_sessions`, invitations, MFA challenges/recovery codes, auth audit | Preserve user identity and security audit as platform identity records; create tenant membership/role rows only from verified workspace membership evidence. Revoke or expire copied sessions at cutover unless a separate session-security review approves preservation. | Resolve whether historic “workspace” members represent one organization, multiple users in one customer account, or platform operators. Never turn a role into tenant ownership. Credentials and secrets are outside the migration manifest. |
| Batches, leads, lead emails, evidence/provenance, lists/tags, archives, imports and import children, discovery/verification/qualification jobs | Add tenant ownership to parent and child records; target foreign keys include the same `tenant_id`. Preserve source ID and lineage mapping. | Map each child through its parent or another verified relationship. Orphans and cross-parent conflicts are quarantined, not repaired by guessing. Raw staged upload files are not copied by this plan. |
| Mailboxes, domains, mailbox state, OAuth/provider references, inbox messages/cursors | Preserve mailbox/provider identities and references in tenant-scoped rows only after account ownership and secret-vault mapping are verified. Keep credential payloads out of the manifest. | Tenant/account association and external provider tenancy are unknown. Do not move credentials or enable mailbox use as part of a dry run. |
| Campaigns, steps/variants/copy, audiences/enrollments, launch snapshots, personalizations, sends, send reservations/tokens, delivery reports and click-link state | Preserve IDs, immutable snapshot JSON/hash, recipient/content snapshots, provider message identifiers and all status timestamps. Scope all joins by tenant. Preserve submitted, accepted and uncertain send states exactly. | Historical approval does not create a new campaign authorization. An ambiguous or already-submitted send is never retried by migration; classify it as unresolved and reconcile against provider evidence. |
| Operational `events`, delivery reports, tracking and CRM-linked events | Carry source event ID/type/time/raw metadata hash and explicit source provenance into a versioned ledger import after S04 defines event and correction semantics. Build projections from imported facts; do not synthesize outcome events. | Operational events are not automatically canonical revenue, delivery, consent or causal-outcome facts. Unknown semantics remain unknown. |
| Global `suppression_list`, unsubscribe tokens, contact permission/provenance | Preserve every suppression as an effective send veto throughout migration. Until scope is adjudicated, evaluate the legacy suppression set as a conservative platform-wide deny overlay; do not narrow it to a guessed tenant. Migrate only the minimal address token/HMAC and policy-required reason/source/time under approved key custody and retention rules. | Determine lawful retention, deletion exceptions, HMAC/key ownership, deduplication normalization and whether each suppression is global or tenant-owned. If those facts are not resolved, isolate the row and block affected outreach; never discard an opt-out to satisfy deletion or tenant partitioning. |
| AI usage rows and application audit/operational settings | Preserve immutable usage metadata and unknown billing as unknown; key new usage to tenant only where a source task/account relationship proves ownership. Preserve control events as operational audit. | Do not backfill tenant cost by current averages, attribute unlinked calls to a tenant, or infer currency/cost from token counts. |

The migration process is: freeze a source fingerprint and schema/version inventory; produce a versioned mapping manifest; run a read-only dry run that emits counts, mapping decisions, relationship violations and checksums; resolve all safety-critical unknowns or keep affected rows quarantined; take and verify a restorable source backup; copy to shadow target with no provider side effects; compare source/target counts, key maps, relationships, hashes, suppression decisions and send-state totals; rehearse rollback; then obtain separate authorization for any bounded cutover. Cutover must stop the old writer before the new owner writes. Do not dual-write application state. Shadow reads may not send, mutate suppression, or issue execution permissions.

## Manifest and rollback contract

Each migration run records: immutable run ID; source checkout/commit/overlay fingerprint; source database identity and schema version (without credentials); target schema revision; migration code/config hash; start/end time; row counts by table and decision; source-to-target key mappings; per-table deterministic content hashes; relationship and validation findings; quarantine keys/reasons; suppression count and effective-veto checksum; campaign/send state counts including uncertain states; checkpoint; operator/reviewer; and rollback artifact references. A checksum mismatch or any unresolved ownership, suppression, authorization, or send ambiguity is a stop condition, not an allowable aggregate tolerance.

Before cutover, rollback returns reads/writes to the unchanged source snapshot and discards only isolated target work. After any target-side operation is permitted, rollback must merge forward every newly observed suppression/opt-out, provider submission/acknowledgement, reply, audit and outcome fact before restoring the old write route. Uncertain provider outcomes stay blocked from retry. Retention/deletion obligations apply to backups and quarantined records too. The exact backup expiry, suppression legal basis, key custody, recovery objectives and post-cutover merge procedure remain unresolved until the owner and security/privacy reviewers decide them.

## Negative acceptance matrix for S03

These are required future tests; none has been run or passed by this ADR.

| Case | Expected result |
| --- | --- |
| Read or mutate another tenant’s row using a valid guessed integer/UUID | Denied at API and storage boundary; no row, count, cache, log or export leak. |
| Attach a child row to a parent from another tenant | Composite foreign key or equivalent rejects it. |
| Reuse a pooled connection after tenant A then query as tenant B | No A context or result remains; missing tenant context fails closed. |
| Forge tenant ID in request, job payload, cache key, object key, signed URL or export request | Server derives tenant from trusted membership and reauthorizes every referenced record; operation is denied and audited safely. |
| Migrate global row with no proven owner, including an orphan or conflicting parent | Row and dependent lineage are quarantined; no default-tenant assignment or tenant visibility. |
| Same old integer ID occurs in different tables or candidate tenants | Mapping is disambiguated by source database/table/key and tenant; no collision or cross-tenant join. |
| Existing global suppression is absent, stale, normalized differently, or conflicts with contact deletion | Dispatch remains vetoed until an owner-approved resolution; migration cannot weaken suppression. |
| Suppression query races with a new send lease | Suppression wins before external submission; affected send is stopped or marked ambiguous for reconciliation, never blindly retried. |
| Copy a queued/running job across tenants or resume after worker restart | Reauthorize tenant and owned references; a stale/foreign worker cannot commit results. |
| Send was accepted or may have been accepted before crash/cutover | Preserve provider facts and uncertainty; do not create a duplicate submission. |
| Export, deletion, restore from backup, or cache/object lookup crosses tenant boundary | Isolated, complete tenant scope; deletion cannot resurrect data, and documented suppression exceptions remain effective. |
| Dry run repeated with same frozen source/manifest | Deterministic counts and content checksums match; any delta is explained and blocks promotion. |
| Application DB role attempts to bypass tenant scope | RLS/equivalent denies access even when application query omits or forges a tenant predicate. |

## Consequences and open decisions

This keeps customer identity and operational history reviewable while treating unprovable ownership as a real blocker. It requires a source-to-target relationship graph, explicit ownership adjudication and privacy review before any tenant data is exposed. PostgreSQL remains the candidate target, not an installed or selected runtime in this repository. Exact key type, RLS/service-role topology, table-by-table mapping, legal retention basis, target ID strategy, migration tooling, restore window and an approved source-tenant mapping are unknown. S03 is design-only until those decisions, a reviewed migration implementation, and the two-tenant acceptance matrix are complete. S04 and S05 remain gated by S03; this record does not claim a migration or tenant isolation has been implemented.
