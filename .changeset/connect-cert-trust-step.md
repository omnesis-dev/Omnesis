---
"omnesis": patch
---

Offer Claude Code and Codex the one-time certificate trust step instead of blocking them. On a gateway serving a mkcert certificate, the portal's Connect an agent dialog now shows both agents a copyable `export NODE_EXTRA_CA_CERTS=…` (Claude Code) or `export SSL_CERT_FILE=…` (Codex) line naming the mkcert root that issued the certificate, before their usual commands. On the gateway's own self-signed certificate, Codex gets the same step with the gateway's certificate file, and Claude Code stays blocked with a notice that it cannot trust a self-signed certificate and how to give the gateway one it can. The access overview reports the kind of certificate the gateway serves and that trust file. The installer, the install prompt and the install docs now warn when a gateway ends up without a Tailscale certificate, naming the agents that cannot connect and the fix.
