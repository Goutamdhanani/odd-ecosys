# UI priority and competitive acceptance brief

## Latest authorized human direction

The human requires a distinctive, beautiful working UI inspired by the two supplied images, a local app they can inspect, and continued background implementation toward the combined capabilities of Instantly, Smartlead, Apollo, Saleshandy and lemlist. Current ownership: Codex may implement frontend and backend; FreeInference implements backend only. Assign each backend ticket to a single writer to prevent overlap. See `orchestration/OWNERSHIP.md` for the binding work split. This is an instruction brief, not an implementation or completion claim.

## Next coding priority

At the next permitted FreeInference run, read this entire brief, `orchestration/OWNERSHIP.md` and REVIEW_QUEUE.md. FreeInference must work on backend tasks only; do not assign it frontend implementation, source, styles or UI tests. Codex may work on separate backend tickets. Treat UI work as preparatory work for P18; do not mark P18 or any dependency gate passed early. Keep P01 defects and all P00-P23 gates active. Preserve all original F001-F096 IDs. Continue real backend and OSS adoption work. Do not weaken tests or use mock success.

The current local preview is Docker compose service preview, published only at http://127.0.0.1:3000. It mounts the sanitized workspace read-only, uses its own empty /tmp/odd-preview.db, and has no real user database, provider key or secret environment. Tests may use disposable synthetic fixtures, but do not seed fake production records into this preview. UI/API pages must show real empty/disconnected/error states. Codex restarts the preview after reviewed server changes; browser reload picks up CSS/JS changes.

## Visual reference interpretation

References are in orchestration/references/reference-overview.webp and reference-hero.webp. They are user-supplied visual inspiration, not application screenshots and not feature specifications. Do not copy their DeFi copy, sponsor logos, claimed financial performance, or controls that have no outreach meaning.

Create an outreach operating console with a cinematic black canvas and restrained silver/sage light. The references use: an almost-black rounded outer frame; soft metallic ambient light concentrated in the upper right and lower left; large white typography dissolving into silver; extremely fine curved connection lines; small luminous nodes; a compact floating pill navigation; small quiet labels; deliberate white primary actions; deep nested panels; graphite radial instruments. Translate those visual relationships into the actual CRM work surface.

Design direction:
- Near-black background and charcoal surfaces, off-white text, muted sage accents and cool silver secondary details. Reserve amber/red for actual warning/failure semantics. Define tokens centrally.
- An atmospheric but legible opening/dashboard section with oversized editorial title, compact workspace/integration status, and real next actions. The heading should describe outreach operations, not fabricated performance promises.
- A distinctive compact navigation rail and refined header. Keep page names discoverable. Use one visual language for search, tables, drawers, tabs, forms, toasts, filters and confirmation flows.
- Sculpted larger panels with subtle tonal edges, high quality spacing, and softly lit corners. Dense operational tables should remain easy to scan. Use aligned numeric columns, elegant row focus, meaningful grouping and contextual detail panels.
- Real metrics only. A graph with no observations has an honest empty state; unknown deliverability/cost stays unknown. Decorative orbital lines may express the visual identity but must never imply observed pipeline activity.
- An elegant mailbox/integration health area, campaign work queue, lead funnel, and recent activity driven by real endpoints. Do not use hard-coded growth percentages, fabricated timestamps, fake connected accounts or sample logos as customers.
- Font scale and hierarchy must work at desktop and narrow widths. Prefer locally bundled properly licensed fonts with readable fallbacks; do not introduce unnecessary external tracking/CDN dependencies.
- Restrained 150-250 ms transitions, hover/focus feedback and subtle ambient lighting. Respect reduced motion. Avoid distracting moving graphs, excessive blur, generic neon gradients and stock component styling.
- At 1440px, 1280px, 768px and 390px: no overflow, clipped actions, inaccessible tables or broken dialogs. Ensure contrast, keyboard navigation, focus visibility, dialog trapping/restoration and meaningful labels.

## Page coverage and real behavior

Redesign dashboard, leads, qualification, verification, personalization/review, mailbox fleet, campaigns/sequences, batches and analytics consistently. Preserve working imports/forms and mutation confirmation. Every action must perform an actual supported API operation or be explicitly unavailable with a short useful explanation. UI polish cannot fabricate new inbox, prospect database, OAuth, white-label or media functionality. Add those as real requirement-backed features in their appropriate phases with tests. Keep existing behavior and source compatibility with the adopted OSS foundation.

## Competitive capability acceptance matrix

Research below was checked against public official vendor pages on 2026-10-06. Public marketing is capability discovery, not evidence that our build provides it. Maintain a durable matrix with source URL, capability, matching original F IDs or new F097+ IDs, implementation location, exact tests, actual performance evidence, provider/data/license dependencies and blockers. Keep all features discovered in scope and require new IDs in release gates too; never hide uncovered capabilities behind an existing broad ID.

| Reference | Capability families to cover | Existing scope anchors |
| --- | --- | --- |
| Instantly — https://instantly.ai/ | Mailbox fleet and sending at scale, deliverability/inbox placement, lead discovery and verification, campaigns and AI workflows, shared inbox/reply assistance, CRM revenue pipeline, APIs/integrations and usage/plan economics | F041-F064, F065-F072, F082-F096; map discovery/AI rows from the complete orchestrator |
| Smartlead — https://www.smartlead.ai/ | Bulk mailboxes, sender rotation, actual warm-up evidence, shared master inbox/team assignment, intent/subsequence handling, deliverability infrastructure, agency/client access and white-label, APIs/webhooks and CRM | F001-F008, F041-F072, integration/agency requirements; add missing infrastructure and dialer coverage IDs |
| Apollo — https://www.apollo.io/ | Real licensed contact/company search and enrichment, filters and data provenance/refresh, prospecting intelligence, sequence execution, CRM synchronization, extension/integration surfaces, calling and workflow assistance | Discovery/research/enrichment requirements, F033-F040, F049-F056 and integration rows; explicitly add uncovered prospect data/extension/calling requirements |
| Saleshandy — https://www.saleshandy.com/ | Lead finder, verification, mailbox/domain onboarding, sender rotation, sequences/followups, warm-up/placement, unified inbox, agency white-label/client workspaces, CRM/infrastructure and enrichment | F041-F072 plus discovery and agency rows; add gaps instead of assuming blanket equivalence |
| lemlist — https://www.lemlist.com/ | Personalized outreach, lead enrichment, intent signals, unified inbox, deliverability hub, multichannel email/LinkedIn/calls/SMS/WhatsApp workflows, integrations; separately verify dynamic image/video personalization against official documentation | F033-F040, F049-F072 plus integration rows; add media renderer/variables/link tracking and multichannel gaps |

No invented contact database or unavailable commercial infrastructure. Build provider adapters and provenance-backed licensed data ingestion; expose connection and coverage truthfully. Record procurement/credential dependencies as blockers. Do not buy subscriptions, send outreach, create paid resources or claim access without authorization. No hard product mailbox/domain count ceiling unless an explicit plan policy requires it; actual provider quotas, storage and capacity still apply.

Define and execute scale gates: mailbox and campaign cardinality, queue throughput and fairness, duplicate prevention under workers/restarts, API p95 latency, UI performance on large paginated lists, search/inbox lag, provider failures, backup/restore, data isolation and accessibility. State the tested hardware/data/workload and result; do not infer vendor equivalence from visual similarity or a passing unit suite. Exact proprietary data size, inbox placement and pricing equality remain measured/external dependencies, never fabricated claims.

## Reuse and validation

Use existing functioning implementation and audited open-source projects. Retain the Warmbly foundation audit/adoption gate before replacing core workflows. Reuse maintained UI primitives, tables, icons, validation and testing tools where they fit, with pinned versions/licenses. Avoid rewriting backend infrastructure for a cosmetic redesign.

Address REVIEW_QUEUE findings while implementing: strict API contracts, Windows URL paths, deterministic provider tests, honest analytics counters, stale metadata, source-bound evidence. Add browser checks and screenshots at the four target sizes, navigation and actual form/empty/error paths, responsive keyboard and reduced-motion checks. Preserve failing logs. Save a concrete candidate file/hash list for review and synchronization. No test weakening, no skipped phase IDs, no release-ready claim before all original and added local/live requirements pass.

## Budget and continuity

The human authorizes use of the full FreeInference daily plan quota (currently $8/day) before the provider enforces its limit. Disable the smaller local reservation stop; keep request serialization, provider error classification and the UTC reset pause. Never bypass the provider quota, send concurrent requests, switch away from the configured FreeInference model, or expose credentials. Keep prompts/tickets bounded and checkpoint progress. Estimated local request cost is telemetry, not actual provider usage.
