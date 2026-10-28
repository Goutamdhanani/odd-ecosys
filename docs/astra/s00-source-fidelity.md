# S00 source fidelity and delta record

Candidate slice: `c00-s00-20261024-01`  
Selected commit: `f30490bd892dd651fd2fb276b09b510379e27c0d`  
Selected overlay identity: SHA-256 `a688a159676ddf3fbbce6ac8ac894d582f5644afbfee70b63416379f8f0474fd` from the preserved source snapshot.  
Read-only original: `E:/odd-ecosys-build-worktree`.

## Result

The immutable stored source snapshot names 228 files. The initial five S00/S02 deltas remain recorded, and the nine additional Phase 2 source divergences are traced to `orchestration/astra-source-scope-ruling.json`, the 234-file `orchestration/astra-phase2-source.json` after checkpoint where present, and the relevant checkpoint-before artifact. The explicitly authorized B08 test-only correction is listed separately. Their base/current hashes, authorized purpose and evidence references are recorded individually in [s00-source-delta.json](s00-source-delta.json). This establishes scope/provenance only; it is not code acceptance, legal/provider approval or a test waiver. The campaign snapshot fixture repair is also recorded. The original checkout was not edited; no file was restored from remote `main` or the original checkout.

The five initial deltas are in `pipeline/database.js`, `pipeline/sending-engine.js`, `server.js`, `tests/campaign-launch-snapshot.test.mjs`, and `tests/campaign-lifecycle.test.mjs`. Seven additional source paths were added from the coordinator ruling; the existing sending-engine and server rows were refreshed to the ruled current hashes rather than duplicated. The B08 test correction adds one more authorized path. All source changes remain unaccepted until their phase acceptance is independently established. The original SHA-256 remains recorded per file, so a later source change that is not added to the delta report fails `S00-01`.

The disposable negative probe copies `server.js` to a temporary directory, confirms the unchanged copy matches, appends a probe comment to that copy, and confirms hash comparison reports the mismatch. It never modifies the selected file.

## Limits

The overlay identity is an inherited checkpoint fact, not independently authenticated provenance. This check establishes current bytes against the local source snapshot plus explicit deltas; it does not establish that all overlay changes are accepted product behavior. The reviewed S02 increment remains partial and unaccepted pending independent Luna review.
