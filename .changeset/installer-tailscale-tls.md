---
"omnesis": patch
---

The installer now sets up a trusted HTTPS certificate through Tailscale in every
install, Docker included. When Tailscale is running on the machine, it asks
"Tailscale detected — set up a trusted HTTPS certificate for <name>? [Y/n]"
(Yes by default; unattended runs go ahead unless `--no-tls` is passed). It says
plainly when the tailnet has HTTPS certificates switched off. Under `--docker`
the certificate is issued on the host, the machine running Docker, including
with the Tailscale app on a Mac. The containers serve it, and a host job (a
launchd agent on macOS, a systemd timer on Linux) renews it daily.
`omnesis uninstall` removes that job. Browsers and the Chrome extension can then
connect to a Docker gateway without certificate errors.

A gateway left on its self-signed certificate now ends the install with a
prominent warning that browsers and the Chrome extension cannot connect, and
names the one command that fixes it. The browser-extension steps no longer read
as if they would work. On a terminal, the portal address in the closing summary
carries a one-time login code that signs you in once, within 10 minutes. The
Docker summary now says that `omnesis` commands run in your terminal as usual.
