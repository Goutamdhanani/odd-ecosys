# R1-F2 QA egress guard correction

Date: 2026-10-28

## Change

The TCP and TLS entry points now reject non-loopback literal IPv4 and IPv6 destinations before considering a caller-supplied `lookup`. This closes the Node behavior where literal-IP connections bypass DNS lookup entirely. Custom lookups for hostnames remain available, and both TCP and TLS now validate every returned address through the same guarded lookup wrapper.

## Verification

- `node --test --test-concurrency=1 --test-reporter=spec tests/astra-qa-egress-guard.test.mjs tests/astra-qa-egress-literal-ip.test.mjs` — passed 2/2, zero skips, exit 0, both without and with `NODE_OPTIONS='--import=./tests/support/astra-qa-egress-guard.mjs'`.
- `node --check tests/astra-qa-egress-guard.test.mjs` — exit 0.
- `node --check tests/astra-qa-egress-literal-ip.test.mjs` — exit 0.
- The original `tests/astra-qa-egress-guard.test.mjs` self-check was restored byte-for-byte from commit `b949d80` (Git blob ID `be99e04f30b8c6195231ed75354ba5293850ed63`). Its existing negative coverage remains intact: DNS callback and promise APIs and Resolver classes, UDP send/connect/bind, fetch, wildcard listeners, nested/direct TCP/TLS, hostname custom lookup including `all: true`, and normal loopback paths.
- The new literal-IP test runs in a child process that replaces `net.Socket.prototype.connect` and `tls.connect` before importing the guard. It proves IPv4 and IPv6 external literals are rejected before lookup or transport delegation, hostname lookups returning loopback are allowed, hostname lookups returning external addresses are denied, and ordinary loopback TCP/TLS requests reach only the stubs. No network connection is attempted.
- The probe child clears inherited `NODE_OPTIONS` so a parent preload cannot install the guard before the transport stubs. The test suite passes in both preload modes, while the child remains fully stubbed.

## Frozen hashes

- `tests/support/astra-qa-egress-guard.mjs` SHA-256: `FBD64F3A7A018F1F5F38241D639265ADC37C4EE5B1468759C327D3470EA6E83E`
- `tests/astra-qa-egress-guard.test.mjs` SHA-256: `99030C3DD9B662D845779CDCAB910A4A9205D4EBFD163EE7561C353CD65E9A16`
- `tests/astra-qa-egress-literal-ip.test.mjs` SHA-256: `BDB3F5646DC3D6F3F6262FDB241160FE475DE1D040D883E7B25D9701D1873EDC`

Lifecycle source-pin repinning remains with the coordinator after this freeze.
