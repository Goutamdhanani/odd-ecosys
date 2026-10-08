# Persistent FreeInference implementation runner

This runner uses the MIT OpenCode coding harness, pinned to **1.18.34**, inside Docker. It follows [the full orchestrator](../../ORCHESTRATOR_GLM_5_3.md), one ticket/turn and one upstream request at a time. A host supervisor saves state and restarts interrupted turns. The project is **not production ready** yet.

## Current locations

| Item | Windows path |
|---|---|
| Real project | `E:\project\odd-ecosys` |
| Full key, one line | `C:\Users\pooja\.codex\secrets\freeinference.key` |
| Isolated implementation copy | `X:\odd-ecosys-runtime\workspace` |
| Supervisor state | `X:\odd-ecosys-runtime\runner-state.json` |
| Agent logs | `X:\odd-ecosys-runtime\logs` |
| Runtime location pointer | `C:\Users\pooja\.codex\odd-ecosys-runtime-location.json` |
| Consistent DB backups | `C:\Users\pooja\.codex\odd-ecosys-backups` |

Save the real key locally. The dashboard's masked key cannot authenticate. The background supervisor checks every 30 seconds and begins after valid credentials are present, Docker works, dependencies install and `/v1/models` confirms account access. The intended account model is **glm-5.3-flash**. No silent model fallback; a status page listing `glm-5.3` does not prove account entitlement.

## Start, inspect, stop

Run commands from the real project directory:

```powershell
node tools/freeinference/establish-state.mjs
node tools/freeinference/backup.mjs
$env:ODD_RUNNER_ROOT = 'X:\odd-ecosys-runtime'
node tools/freeinference/bootstrap.mjs
docker build --tag odd-ecosys-coder:1.18.34 tools/freeinference
powershell -NoProfile -File tools/freeinference/Start-Runner.ps1
npm run runner:status
npm run runner:stop
# Explicitly resume after a user stop:
powershell -NoProfile -File tools/freeinference/Start-Runner.ps1 -Resume
```

Bootstrap is idempotent: it preserves an existing development copy and all checkpoints. Never delete/reinitialize the workspace to recover a failed inference call. A separate recurring Codex heartbeat checks health and reviewed progress. This requires the computer and Codex app to be running. The Docker containers restart with Docker; the supervisor can be restarted by the heartbeat. It cannot execute while the computer sleeps or is shut down.

## Hard execution rules

1. Read the complete orchestrator and keep its 96 requirements, 24 phases and all defect records. New defects get new IDs.
2. Implement actual behavior, test positive/negative/provider failure/restart paths, inspect actual evidence, persist next action, then continue.
3. Missing SMTP/AI/CRM/billing credentials return truthful disconnected/blocked states. No fabricated sends, delivery, checks, metrics or integration success.
4. Reuse audited OSS such as Warmbly before replacing infrastructure. Verify licenses, pin revisions and run real gates.
5. Provider calls go through a credential gateway; all calls are serialized. One account slot means no concurrent workers or parallel models.
6. Transient errors retry with delays; provider quota exhaustion resumes after UTC midnight (05:30 IST). The human authorizes using the full user-reported **$8/day provider quota**. Local token/byte estimates are telemetry only and do not impose a smaller spending cap. The provider's quota response is authoritative. Other tools using this account can consume quota independently.
7. Each agent turn has a 30-minute watchdog. Interrupted work resumes using the saved OpenCode session and filesystem checkpoints. Repeated no-progress turns get reduced retry frequency and an attention state; they do not churn indefinitely at full speed.
8. An agent claiming completion does not establish release readiness. The supervisor checks all scope IDs/local/live evidence, reruns tests and requires a current host-side independent attestation, bound to the code snapshot, plus reviewed source synchronization. Do not manufacture the attestation to unblock a release.
9. STOP and later user cancellation are always respected. “Keep working” never overrides provider quotas, unavailable credentials, computer shutdown, data protection or external-operation authorization.

## Isolation and review

Only source, scrubbed configuration, docs and synthetic tests are copied. `data`, `.env`, actual SQLite files, key files, existing authentication stores and host node_modules are excluded. The agent receives no host filesystem mount except its sanitized workspace/config/session volumes, no Docker socket and no real FreeInference key. Only the gateway container mounts the key. No gateway port is published on the host. Prompts/responses can be logged by FreeInference; source you intentionally submit is therefore shared with that provider. The container can reach the internet for OSS/package research; this is filesystem/credential isolation, not a comprehensive outbound-network sandbox.

The original project's current Git scope resolves to `E:/`. Do not operate on that drive-wide repository. The agent gets a new Git repository rooted at its isolated workspace. Its edits do not automatically overwrite the real project. The recurring reviewer must inspect exact diffs, rerun meaningful checks and synchronize reviewed files with baseline conflict detection, preserving concurrent user changes and real data/config. Local agent completion must not be reported as source synchronization or production deployment.

## What is still unverified

Live API authentication/model/tool use cannot be verified without the full key. Passing the included focused regression tests does not cover all platform requirements. Full P00 inventory contracts, remaining truthfulness fixes, OSS foundation audit, security/tenancy, durable workflows, complete UI/API/provider tests and live release gates remain in the ledgers.

The initial Docker build hit an input/output error while C: was full. The runtime workspace is on X:, which has free capacity. Docker's own disk image is still managed by Docker Desktop on C:. Further image pulls/builds require adequate Docker storage; do not delete unrelated user data or container volumes to clear it. If Docker remains unavailable, the supervisor records an explicit blocker and retries after credentials are configured.

## Primary references

- [FreeInference quick start](https://doc.freeinference.org/quickstart): OpenAI-compatible API and key setup.
- [FreeInference models](https://doc.freeinference.org/models): verify actual account model access via the API.
- [OpenCode custom providers](https://opencode.ai/docs/providers/#custom-provider): compatible provider configuration.
- [OpenCode CLI](https://opencode.ai/docs/cli/): JSON run events and session continuation.
- [OpenCode permissions](https://opencode.ai/docs/permissions/): explicit deny rules and scoped access.
- [Codex scheduled tasks](https://learn.chatgpt.com/docs/automations?surface=app): recurring local supervision and runtime availability.
