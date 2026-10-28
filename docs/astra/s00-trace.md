# S00 synthetic trace evidence

## Fixture and command

The executable trace uses one temporary SQLite database, a synthetic approved offer, synthetic account/contact identifiers and only injected fixture fetchers. Search returns one `.test` business. Website discovery uses the real `lead-discovery-jobs`, `searxng-search`, `website-discovery-jobs`, and `website-email-discovery` modules; the fetchers return fixture search JSON, robots policy and a synthetic contact page. No external search, website, DNS, verification provider, model, SMTP server, mailbox, or CRM endpoint is contacted.

Run with:

```powershell
node --test tests/astra-source-trace.test.mjs
```

The run persists the discovery job, source evidence and contact; scores deterministic synthetic qualification signals using the selected scoring module; creates an approved no-model-egress offer with synthetic proof; binds it to a draft campaign through the selected campaign-draft API; and enrolls the contact. It asserts the campaign remains a draft and no send row is created.

To exercise reply handling safely, the fixture explicitly seeds a `sent` row and a synthetic outbound event carrying `delivery: unknown`, then passes a synthetic unsubscribe reply to the real reply tracker. This proves local attribution/suppression behavior only. It is not evidence of SMTP submission or delivery. The actual selected loopback SMTP sequence and reply behavior is covered separately by `tests/campaign-sequence-execution.test.mjs`.

Finally, the fixture calls CRM sync with CRM configuration absent. It observes `not_configured`, no remote CRM ID, and no canonical outcome table. The trace stops with booked/held/won/paid/refunded outcomes **unknown**; it does not count the incomplete research-to-revenue path as success.

## Stage results

| Stage | Observed call site/result | Status |
| --- | --- | --- |
| Discovery and source | Real coordinator and site evidence modules persist the synthetic business, contact and a source hash. | Executed with fixture fetchers |
| Qualification | Real deterministic qualification scoring runs on synthetic signals and reports a score/status. | Executed; not a provider assessment |
| Offer and campaign intent | Offer module creates and approves a fixture offer; campaign draft binds its version and enrolls the contact. | Executed; no send created |
| Reply and suppression | Synthetic reply input reaches reply tracker; unsubscribe is persisted and contact is disqualified/suppressed. | Executed against local SQLite |
| CRM outcome | CRM adapter returns `not_configured`; no canonical outcome ledger/table was found. | Explicit stop / unknown |

No source files or shared databases are changed by the fixture. A `sent` row is fixture setup only, not an observed send. No revenue, conversion, meeting, attribution or growth result is claimed.
