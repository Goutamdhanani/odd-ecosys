# Astra baseline validation

## Source and fixture boundary

This check used the isolated implementation checkout at `C:/Users/pooja/.codex/worktrees/astra-foundation/odd-ecosys`, selected source HEAD `f30490bd892dd651fd2fb276b09b510379e27c0d`, and the 228-file source overlay identified by `source-snapshot.json` (manifest SHA-256 `a688a159676ddf3fbbce6ac8ac894d582f5644afbfee70b63416379f8f0474fd`). The original `E:/odd-ecosys-build-worktree` was read-only. I rebuilt a temporary source-only fixture under `%TEMP%` and verified all 228 manifest hashes matched before executing tests. The three files changed by concurrent A1 work were copied from the original read-only source checkout. Dependencies were referenced through a junction to the already-installed workspace `node_modules`; no install was run.

## Baseline failure and cause

The handoff's full foundation command, recorded before A1 changes, exited 1 with 16 passing tests and 1 failing test. The single failure is `tests/campaign-lifecycle.test.mjs:78`: sender selection returns HTTP 409 while the test expects 200. I reproduced that result in the detached source-only fixture with:

```powershell
node --test --test-concurrency=1 tests/campaign-lifecycle.test.mjs
```

Exit code: `1` (1 pass, 1 fail; the sender assignment assertion observed `409 !== 200`). The fixture uses an SMTP sink bound only to `127.0.0.1`; this failure occurs before queueing or SMTP submission.

This is a stale test fixture against the selected baseline policy, not a regression caused by A1. The frozen `pipeline/sending-engine.js` requires an `eligible` mailbox to also have a current approved row in `mailbox_warmup_reviews`. `campaignMailboxWarmupReadiness` returns `warmup_review_required` without that row, and `updateCampaignSenderSelection` rejects a newly selected unready mailbox with 409. The lifecycle test seeds the mailbox as `eligible`, but did not seed a warmup review. The campaign preflight and launch-snapshot fixtures already insert `decision='approved'`, policy `smtp-and-inbox-activity-v1`, and synthetic `{}` evidence at the same policy boundary.

## Fixture correction and verification

With parent authorization, I changed only the isolated `tests/campaign-lifecycle.test.mjs` fixture to insert an approved synthetic warmup review for mailbox 1, matching the preflight and launch-snapshot fixtures. Existing readiness, queue, pause/resume, and SMTP assertions remain in place. No production code or A1-owned path was changed.

The corrected lifecycle test was copied into the source-only temporary fixture and rerun with the same command. Exit code: `0` (2 passing, 0 failing). The existing fake SMTP sink accepted the single synthetic fixture message on loopback; no DNS, provider, mailbox, recipient network, or credential service was contacted.

The parent is running the integrated selected-baseline suite after A1 settled, including the corrected lifecycle fixture and the new focused S02 tests; that result is pending this report. The original baseline log remains evidence of the pre-fix suite result. This report does not approve A1 or mark S02 complete.
