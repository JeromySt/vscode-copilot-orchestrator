# Security

AiOrchestrator is a security-first daemon. This document summarizes the key
threat-model choices that constrain the implementation.

## Key ceremony

The daemon trusts a burn-in set of **5 offline HSM public keys** which are
baked into the install-time configuration (`KnownHsmPublicKeys`). Every release
manifest must be signed by **at least 3 of the 5** keys (M-of-N = **3-of-5**).
A separate set of **emergency-revocation HSM public keys** forms a
**dual-root** trust topology: the primary roots sign day-to-day manifests,
while the emergency roots are kept air-gapped and used only to authorize an
emergency revocation of a compromised trusted audit key.

Routine HSM key rotation occurs on a **5-year** cadence. Rotations are
performed by the offline key-ceremony binary (job 043, `tools/key-ceremony/`)
and materialized by publishing a new signed release-manifest. The daemon
itself never holds or uses an HSM private key (INV-10).

Any code path that references `KeyCeremonyToolingStub` from outside
`tools/key-ceremony/` or `tests/` is flagged by analyzer OE0043 at compile
time.

## Transparency log

When a transparency-log URL is configured, every fetched manifest is checked
for inclusion via a Sigstore-style Merkle proof. Rejection of the inclusion
proof fails the manifest with `TransparencyLogMismatch`.
