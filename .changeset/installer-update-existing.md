---
"omnesis": patch
---

Running the install command again on a machine it already set up, for the role it already has, updates that install: the installer uses the checkout the earlier install recorded, lets it fetch from its origin again, and runs the machine's own `omnesis update`, which backs up, rebuilds, restarts and rolls back as usual. Certificate, keyring, embedding model, pairing and service definitions are left alone, so a collector no longer asks for a new pairing code. `--reconfigure`, a role change, or a first install that never registered its services runs the full install, which now restarts the services the machine already had so a rewritten service definition takes effect.
