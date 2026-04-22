# Security Model

## Credential Broker (Job 017)

The Credential Broker (§3.6 + §3.31.1.1) brokers OS-keychain access for Git via Git
Credential Manager (GCM). It enforces:

- **URL allowlist (CRED-ACL-1)** — Only URLs whose host matches a configured suffix
  are serviced; all other requests are rejected and audited.
- **Path-based UDS / named pipes (CRED-IPC-1)** — POSIX sockets bind under
  `/run/ai-orchestrator/` (NEVER the abstract `@` namespace); Windows uses a
  `NamedPipeServerStream` with an owner-only DACL.
- **Per-message peer-credential check (CRED-IPC-2)** — Every incoming RPC is
  authenticated via `SO_PEERCRED` (Linux) or `GetNamedPipeClientProcessId` +
  `ImpersonateNamedPipeClient` (Windows).
- **Full verb sequence (CRED-VERB-1)** — Every `GetAsync` call is paired with
  either `StoreAsync` (git credential approve) on successful use or `EraseAsync`
  (git credential reject) on auth failure.
- **Exponential backoff (CRED-INVAL-1..3)** — After `FailuresBeforeBackoff`
  consecutive invalidation events for a URL, the broker engages exponential
  backoff (`InitialDelay * Multiplier^n`, capped at `MaxDelay`). A successful
  retrieval resets the counter.
- **Protected secret material (INV-10)** — `Credential.Password` is a
  `ProtectedString` that zeros its backing buffer on dispose. `ToString()`
  always returns `"***"` so accidental log emission never leaks the secret.
- **Redacted audit trail (INV-11)** — Every operation is appended to the audit
  log with the URL path and query stripped (scheme + host only).

## Same-uid threat model (INV-12)

The broker operates under the assumption that the operating system's user-id
boundary is intact. Specifically:

- **In scope**: untrusted processes running under a *different* Unix user id
  (Linux/macOS) or a *different* Windows user SID (Windows).
- **Out of scope**: malicious processes running under the *same* user id as the
  broker. On POSIX, any same-uid process can already attach to the broker via
  `ptrace(2)` or read its address space via `/proc/<pid>/mem` — no UDS-level
  hardening can defend against that. On Windows, any process running as the
  same user can open a handle to the pipe with default DACLs.

Defenders should compartmentalise by running the broker under a dedicated
service account and granting mount/IPC permissions only to the specific
processes that need credential access.

The filesystem socket (`/run/ai-orchestrator/cred.*.sock`) is created with
`0700` permissions in a directory owned by the broker service user. The Windows
named pipe (`\\.\pipe\ai-orchestrator\cred.*.sock`) is created with a default
DACL that restricts access to the broker's user.

**Consequence for code review**: any change to `AiOrchestrator.Credentials/Ipc/`
or `AiOrchestrator.Credentials/Allowlist/` requires premium-tier security
review (see `.github/CODEOWNERS`, J17-PC-7).

## Key ceremony

AiOrchestrator is a security-first daemon. This document summarizes the key
threat-model choices that constrain the implementation.

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
