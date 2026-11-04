---
"omnesis": patch
---

Fixes from the 0.7.6 Docker test:

- `omnesis doctor` on a fresh Tailscale install no longer fails its permission check. The installer and the daily renewal job now leave the Tailscale or mkcert certificate and its `tls/` directory owner-only, as the gateway's own renewals do. The Docker launcher now writes the host records it leaves for the doctor (`host-network`, `host-disk-encryption`) owner-only too. Before, each command rewrote them world-readable, so even `omnesis doctor --fix-permissions` could not keep the check passing.
- `omnesis backup list` lists your backups. Before, it ignored the word and started a full backup. Any other word after `omnesis backup` is now refused instead of ignored.
- When the gateway stops before it ever answers, the installer now says so. Before, it reported that the gateway did not answer `/health` within the wait, as if it had timed out.
