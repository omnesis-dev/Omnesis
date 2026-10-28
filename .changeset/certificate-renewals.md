---
"omnesis": minor
---

Phones and the OpenClaw and Hermes integrations that pinned the gateway's certificate follow its renewal instead of losing the connection, when they reach the gateway by a DNS name and the new certificate is publicly trusted (Tailscale or a public authority). A client that will still lose its connection at the next renewal — an integration from an earlier release, or one that reaches the gateway by IP address — is named beforehand, with the date and the remedy, on its portal device card, in `omnesis devices list` and in `omnesis doctor` (`fleet.tls-pin-renewal`); on a Tailscale certificate the card offers to update it. A client a renewal has already stranded is reported as `fleet.tls-pin-repair`, and `omnesis tls status` prints the next renewal.
