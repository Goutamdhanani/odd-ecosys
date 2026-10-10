# Odd Ecosys agent instructions

## Historical development sequencing restriction

The prior supervisor direction restricted implementation work to P02. This checkout did not contain an `AGENTS.md` before the 2026-10-09 reconciliation, so this short historical summary records the restriction without replacing or deleting any earlier instruction text. The restriction governed development sequencing before the owner override below.

## 2026-10-09 — Human authorization for parallel isolated product development

The project owner’s current direction in `LUNA_CONTINUOUS_PRODUCT_BUILD_20261009.md` authorizes isolated feature development across the L02–L25 backlog. This supersedes the P02-only development-sequencing restriction for independently owned implementation tickets. It does not change phase acceptance, approve live sending or deployment, or make any release-ready claim. Keep `releaseReady=false`; preserve P02’s outstanding proof and all other recorded gate states.

Follow `orchestration/OWNERSHIP.md` before editing. One writer per file; transfer or release an assignment before taking its paths. Keep tickets bounded and end-to-end, with durable data, API, UI, and focused behavior evidence where relevant. Use disposable databases and synthetic contacts for tests. Preserve existing databases, credentials, mailboxes, message history, and persistent volumes. Do not send to real recipients, start another warm-up scheduler, or bypass suppression, verification, sender, approval, SMTP, or uncertain-submission safeguards.
