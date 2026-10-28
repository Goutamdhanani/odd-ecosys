# Astra integration environment handoff

The blank public template is in `.env.example`. Keep all future sandbox secrets outside the repository webroot at `E:\OddEcosysSandbox\.env.astra-sandbox.local`; this external file is a blank copy of the template. The in-repository `.env.astra-sandbox.local` placeholder was removed after confirming it still exactly matched the blank template. The external file is not served as repository static content.

To edit the external placeholder, open that absolute path directly in a local text editor and save it there. Do not move or copy secret values into the checkout, browser, chat, logs, or source control. Node does not auto-load `.env` files, and the local preview runner deliberately supplies a scrubbed loopback environment with synthetic data and denied egress. Editing the file does not load it, start an app or integration, or make an outbound call.

## Verified sandbox variables

- **Astra mode and storage:** `ASTRA_TENANT_MODE=1` is the existing tenant API/auth routing mode used by local preview. `ASTRA_DATABASE_URL`, `ASTRA_WORKER_DATABASE_URL`, and `ASTRA_CONTEXT_SECRET` feed the Astra tenant store; use disposable sandbox databases and a separate worker connection. This handoff provisions no database.
- **GLM:** source fixes provider `glm-5.3-api`, model `GLM-5.3`, and endpoint. `ASTRA_GLM_API_KEY` is the credential; there is no model-selection env var. `ASTRA_GLM_LOCAL_PREVIEW=true` and `ASTRA_GLM_EGRESS_ENABLED=false` keep requests blocked.
- **Source collection:** `ASTRA_SOURCE_COLLECTION_SEARXNG_ORIGIN` is a server-owned HTTPS origin. Remote transport also needs `ASTRA_SOURCE_COLLECTION_REMOTE_ENABLED=true` and scoped source-rights/approval evidence in `ASTRA_SOURCE_COLLECTION_APPROVALS_JSON`. The template leaves transport off and these values blank.
- **Verification:** Reacher uses `REACHER_API_URL`, `REACHER_API_SECRET`, and `REACHER_TIMEOUT_MS` (source default 8000 ms, clamped to 1000–15000 ms). Its default URL is local `http://localhost:8080/v1/check_email`. `ODD_DISIFY_DOMAIN_CHECK=0` disables the separate opportunistic Disify domain check in the sample.
- **CRM:** implemented Twenty CRM sync reads `TWENTY_API_URL` and `TWENTY_API_TOKEN`.
- **Local authentication and encryption:** `ODD_AUTH_BOOTSTRAP_TOKEN` and `ODD_AUTH_RECOVERY_TOKEN` are server-side secrets. `ODD_CREDENTIAL_ENCRYPTION_KEY` is a private 32-byte key encoded as 64 hex characters; `ODD_CREDENTIAL_ENFORCE_ENCRYPTION=true` requires encrypted storage.
- **Mailbox credentials:** SMTP/IMAP passwords are saved through the existing encrypted mailbox setup, not environment variables. The server-side key is `ODD_CREDENTIAL_ENCRYPTION_KEY`; there are no per-mailbox env variables.

## Closed gates

The template keeps `LOCAL_PREVIEW=1`, `ASTRA_LOCAL_PREVIEW=true`, `ASTRA_PREVIEW=true`, and `ASTRA_GLM_LOCAL_PREVIEW=true`. GLM egress, external actions, source remote transport, live actions, launch/live-dispatch authority, S01 authority, and optimizer egress remain disabled; the global provider decision is denied with no expiry. Tenant routing mode does not enable these actions. Other providers are omitted unless their environment contract is verified in source.

This placement correction changes only where a blank local copy belongs. It does not enable provider calls, outbound email, activation, or dispatch; existing provider/source gates and scoped evidence still apply to any later real integration work.