---
"omnesis": patch
---

Encrypted analytics storage now works without network access. It needs DuckDB's `httpfs` extension, which the gateway used to download from DuckDB's repository the first time each analytics database was opened — so an offline gateway, one whose outbound traffic is blocked, or a container with no network could not create or encrypt its analytics store. Omnesis now ships the exact signed build pinned for its DuckDB version: the Docker images carry it, and source and package installs fetch it once while installing and check it against a pinned checksum. The gateway loads that copy, with DuckDB's signature check still on. If the shipped copy is missing, the gateway falls back to downloading the extension as before, logs that it did, and its error names the missing copy and how to restore it.
