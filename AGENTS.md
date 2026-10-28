# Odd Ecosys agent instructions

## 2026-10-20 — Requested model routing and subagent workflow

The owner requests Sol6.1 extra-high to coordinate and assign suitable work to Luna. Use the installed subagent-driven-development skill at C:/Users/pooja/.codex/skills/subagent-driven-development/SKILL.md for authorized multi-task implementation. Explicit routing: coordinator and independent reviewer gpt-6.1-sol/xhigh; focused Luna implementation gpt-6-luna/high, medium for a completely specified mechanical task; complex implementation can use a fresh gpt-6.1-sol/xhigh implementer. Custom agent TOML files under .codex/agents record these roles. The active chat's already-selected model is not changed by a file; set explicit model and reasoning on fresh subagent dispatch.

Use one source writer per file, separate task briefs/reports, frozen before/after diffs and independent spec plus quality verdicts. The owner's subsequent request for multiple concurrent agents authorizes parallel implementation only on disjoint owned files with stable interfaces; dependent changes/reviews remain ordered and actual session slot limits apply. Agents work in a verified isolated checkout when main contains existing uncommitted work. Preserve original changes and all live data/credentials. A generic improvement request does not authorize sends, purchases, deployment, merges, release acceptance or bypassing ownership/reviewer gates. Keep releaseReady=false. Do not spin indefinitely or claim perfection; report bounded verified results and remaining defects.

## Historical development sequencing restriction

The prior supervisor direction restricted implementation work to P02. This checkout did not contain an `AGENTS.md` before the 2026-10-09 reconciliation, so this short historical summary records the restriction without replacing or deleting any earlier instruction text. The restriction governed development sequencing before the owner override below.

## 2026-10-09 — Human authorization for parallel isolated product development

The project owner’s current direction in `LUNA_CONTINUOUS_PRODUCT_BUILD_20261009.md` authorizes isolated feature development across the L02–L25 backlog. This supersedes the P02-only development-sequencing restriction for independently owned implementation tickets. It does not change phase acceptance, approve live sending or deployment, or make any release-ready claim. Keep `releaseReady=false`; preserve P02’s outstanding proof and all other recorded gate states.

Follow `orchestration/OWNERSHIP.md` before editing. One writer per file; transfer or release an assignment before taking its paths. Keep tickets bounded and end-to-end, with durable data, API, UI, and focused behavior evidence where relevant. Use disposable databases and synthetic contacts for tests. Preserve existing databases, credentials, mailboxes, message history, and persistent volumes. Do not send to real recipients, start another warm-up scheduler, or bypass suppression, verification, sender, approval, SMTP, or uncertain-submission safeguards.
