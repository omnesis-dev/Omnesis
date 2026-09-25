---
"omnesis": patch
---

Running the install command again on a machine it already set up updates that install: the installer uses the checkout the earlier install recorded, lets it fetch from its origin again, and runs the machine's own `omnesis update`, which backs up, rebuilds, refreshes service definitions, restarts and rolls back as usual. Certificate, keyring, embedding model and pairing are left alone, so a collector no longer asks for a new pairing code. `--reconfigure`, `--collector` or `--client-only` on a machine with another role, or a first install that never registered its services, runs the full install, which now restarts the services the machine already had so a rewritten service definition takes effect.
