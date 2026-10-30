---
"omnesis": patch
---

Docker installs are encrypted at rest by default, and `omnesis secure` now works on them.

- **The installer's keyring question under `--docker` defaults to encryption.** Pressing Enter generates an owner-only passphrase file (`~/.config/omnesis/keyring.pass`) that the containers read at start; `1` still installs without encryption. The "stop so you can unlock a keyring first" answer is gone under Docker, since no keyring on the host can reach a container. A re-run reuses the passphrase file the install already records instead of asking again.
- **`omnesis secure` on a Docker host just works.** Typed on the machine that runs the containers, it uses the passphrase backend, generates and records the passphrase file when none is configured, then runs the usual safe order — backup, root key, recovery code printed once, secret files, store keys. The `omnesis` command on the host then restarts the gateway and collector containers, which a container cannot do to itself, and verifies that the databases came back encrypted. A collector-only host restarts its collector container.
- **`omnesis secure` recognises a running gateway on a self-signed certificate**, such as a Docker gateway's default. It used to take such a gateway for stopped and then refuse the offline snapshot because the gateway held its directory; it now backs up through it, and waits for a gateway that is still starting.
- **A gateway whose home directory it cannot write no longer fails to encrypt an existing analytics store.** Copying a plaintext analytics store into an encrypted one loaded DuckDB's encryption extension from `~/.duckdb`, which a container running as the host's account (and a service unit with a read-only home) cannot create, so the gateway exited on every start after `omnesis secure`. The copy now uses the store's own extension directory, as opening the store already did.
- **`omnesis secure --verify`** checks, without changing anything, that encryption at rest is in effect.
- **`omnesis update` refreshes the host's `omnesis` command** to the new release's once the containers run it, so an existing Docker install picks up the new `secure` behaviour by updating.
- **The combined container's collector carries the host's name** (`<host>-collector`, with the host as its hostname) instead of `gateway`. An existing install keeps its device; a collector re-registering after a revoke comes back under the name it last paired as, so no second device row appears.
- **The credentials wizard says where a credential goes and whether it is encrypted.** Under Docker it prints the absolute path and says the file is on this machine; it also says when the file will not be encrypted at rest and that `omnesis secure` fixes that.
