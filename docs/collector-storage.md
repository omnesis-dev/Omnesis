# Collector storage boundary

A collector uses its own configuration directory and local install root key.
Gateway pairing supplies an access credential, not the gateway's storage keys.
Encrypting gateway databases alone does not encrypt a remote collector. Source
applications' originals are read-only inputs; Omnesis does not encrypt them.

This inventory follows provider filesystem writes, shared credential and SQLite
helpers, and collector persistence. Paths below are relative to the collector's
configuration directory unless stated otherwise. Encryption is conditional on
initialized local keys; legacy installs without keys retain plaintext compatibility.

| Store / implementation                                                                                                                                           | Content and lifetime                                                                                                                         | Protection and recovery                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apple-imessage/transcripts.db` (`imessage-transcript-cache.ts`)                                                                                                 | Voice transcripts, attachment identifiers, size and modification time; reused across syncs until replaced or removed                         | SQLCipher with the local `imessage-transcripts` storage key; legacy plaintext migrates on open. Missing required keys stop durable access. A content-free `transcripts.db.lock` SQLite file holds a kernel-released exclusive lock for the cache lifetime; it is not a content cache.                                          |
| `enable-banking/<account>/bootstrap/<key>/page-*.json`                                                                                                           | Full-history transaction pages captured during consent; retained until successful drain, invalidation or account removal                     | Root-key-wrapped secret-file envelopes, path-bound authenticated encryption, atomic replacement. Read failures retain the spool instead of discarding consent-limited history.                                                                                                                                                 |
| Banking `session.json` and bootstrap `complete.json`                                                                                                             | Consent identifier, expiry, account mapping, page count and consent epoch; account-scoped `.locks/` holds only process coordination metadata | Same local secret-file boundary; completion is not evidence of a different consent's pages.                                                                                                                                                                                                                                    |
| `whatsapp/<account>/store.db` (`message-store.ts`)                                                                                                               | Message archive, sender metadata, derived media text and retry state; retained across syncs                                                  | Existing SQLCipher storage-key support, plaintext migration via a staging copy, WAL checkpoint; encrypted-key failures fail closed. Archive corruption has its own quarantine/rebuild policy.                                                                                                                                  |
| WhatsApp legacy `message-store.json`, `store.db.corrupt-*` and migration residue                                                                                 | Historical message content; legacy JSON is removed after successful import, corrupt stores are retained for recovery                         | Unresolved historical exposure: old plaintext quarantine/failed legacy imports are not retroactively guaranteed encrypted by live archive encryption. Preserve the only usable copy while investigating; do not infer the status of retained files from the active database.                                                   |
| Provider credentials, OAuth token files, Microsoft token cache, Plaid item credentials, WhatsApp Signal/auth fragments (`credentials.ts`, provider auth modules) | Access credentials and account metadata; until rotation, re-consent or account removal                                                       | Existing secret-file envelopes when the root key exists, otherwise owner-only plaintext; supported legacy files migrate through `keyring migrate`. Atomic writes; path changes require decrypt/re-encrypt, never envelope renaming. WhatsApp generation/seal/order markers contain coordination metadata, not message content. |
| Collector config cache `cache/omnesis.cache.json` (`gateway-config.ts`)                                                                                          | Gateway settings, source identifiers and potentially personal configuration; offline use bounded to 24 hours, file retained until rewritten  | Local root-key-wrapped secret-file envelope, atomic writes and migration on read. Unavailable/corrupt cache falls back to the gateway; missing keys never downgrade its on-disk encryption.                                                                                                                                    |
| Collector token and config-secret files                                                                                                                          | Gateway access token and referenced configuration secrets                                                                                    | Root-key-wrapped secret files; local key availability governs writes.                                                                                                                                                                                                                                                          |
| `collector-pairing-state.json`                                                                                                                                   | Device name, gateway URL, authentication timestamps and non-reversible token fingerprint; overwritten as pairing changes                     | Mode 0600 plaintext metadata, no bearer token; deliberately readable for offline service diagnosis.                                                                                                                                                                                                                            |
| SQLite snapshots (`sqlite-snapshot.ts`, Chromium history and Screen Time)                                                                                        | Source database plus present WAL, SHM and rollback-journal sidecars; one reader operation                                                    | Private owner-only temporary workspace; plaintext native SQLite input. Cleanup on close and failed copy; abandoned owned scratch is recovered conservatively. Source files are never altered.                                                                                                                                  |
| WhatsApp backup import (`ios-backup-decrypt.ts`, `import-worker.ts`)                                                                                             | Decrypted backup manifest and ChatStorage SQLite, including message content                                                                  | Private temporary plaintext working files for native SQLite readers; normal/error cleanup and cancellation ownership, with abandoned-workspace recovery. The backup original stays untouched.                                                                                                                                  |
| Attachment extraction, WhatsApp live media cache                                                                                                                 | Downloaded media and derived text                                                                                                            | Process memory; no durable media cache in these paths. OS swap/core dumps remain outside application encryption.                                                                                                                                                                                                               |
| Downloaded model files and `models/manifest.json`                                                                                                                | Model weights, hashes and provenance, not indexed personal content                                                                           | Plaintext artifacts; model-management removal, no corpus-encryption claim.                                                                                                                                                                                                                                                     |
| Collector logs, OS service logs and configuration files                                                                                                          | Diagnostics can contain source identifiers, paths and provider error context; configuration can contain personal settings                    | Not encrypted by the cache changes. Logger rotation is size/count bounded; OS retention and access controls vary. Avoid logging content; disk encryption and OS policy remain necessary.                                                                                                                                       |

## Key preparation and migration

Use the collector's own initialized root key. The registry in
`packages/core/src/storage-keys.ts` assigns every key to the process that
opens its store (`storageKeyNamesForHost`); the collector's set is
`whatsapp-store` and `imessage-transcripts`. The collector creates any of
those it lacks at every start (`packages/collector/src/storage-encryption.ts`,
through the shared `resolveStorageEncryptionReadiness` in core) and refuses
to start when encryption is armed but the root key cannot be read. The
installer's collector role runs `omnesis keyring storage-init --host
collector` after `keyring init`, so the keys exist before the daemon's first
sync. A refused start names its own remedy: a root key that cannot be read
is unlocked or restored, never re-created, and `storage-init` repairs only a
corrupted marker. Neither step provisions a root key or repairs collector
onboarding. Do not copy a
gateway's data-encryption keys to a collector.

Transcript migration keeps the usable original until its replacement is validated.
Banking uses atomic per-file envelopes and an account-scoped process lock;
source startup migrates retained pages once per consent epoch. Malformed or
unauthenticated retained pages stop that sync and stay available for recovery.
Recognizable abandoned banking atomic-write stages are encrypted in place without
being marked committed; even truncated bytes remain available for recovery.
Existing encrypted stages retain their original path scope. A live or uncertain
stage owner stops migration rather than permitting concurrent modification. An
interruption must be retried with the same local keys. Preserve failed stores
and spools while restoring/unlocking those keys; deleting a banking spool may
lose history that the provider no longer offers outside the consent window.
Encryption of a cache must not be inferred from file permissions or absence of
a particular string: SQLite must reject an unkeyed open and succeed with its
intended key; envelopes must authenticate before their contents are accepted.

## Temporary plaintext and residual exposure

The native readers need filesystem SQLite databases. Keeping their complete
input only in JavaScript memory is not compatible with those readers; encrypting
the source bytes would make ordinary SQLite unable to read them. Snapshot
sidecars remain necessary to preserve the reader's existing WAL/journal behavior.

Owned scratch uses private directories and files. Recovery must establish that
an owner is dead, not merely that a directory is old; uncertain ownership and
live operations are retained. SIGKILL can bypass `finally`. Cleanup happens on a
subsequent operation, so abandoned files can persist if that operation never
runs again. Legacy temporary directories without ownership records cannot be
safely attributed and are not broadly deleted. Inspect those only with their
owning processes stopped before removing them manually.

Unlinking is not secure disk erasure. Filesystem snapshots, backups, swap,
crash dumps, source originals, legacy scratch, diagnostics and personal settings
are separate exposure classes. Full-disk encryption and OS access controls
remain relevant. This inventory does not claim that all collector data is encrypted.
