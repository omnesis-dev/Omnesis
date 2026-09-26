---
"omnesis": patch
---

`omnesis connect openclaw|hermes` now loads the plugin it installed. It restarts the harness (`openclaw gateway restart` or `hermes gateway restart`), asking first on a terminal because a restart interrupts a running agent. `--yes` restarts without asking, and `--no-restart` prints the command instead. It then asks the harness whether the Omnesis skill is ready and reports the answer, with the command to run when the skill is not ready. `--refresh` restarts the harness the same way. `--skill-only` changes no plugin, so it restarts nothing.

The installer's `--openclaw` and `--hermes` roles no longer reinstall Omnesis over a machine that already runs it. On a host with a recorded checkout or a registered gateway or collector service, the role connects with the `omnesis` command already there and leaves the checkout, launcher, services and config as they are. When that command is too old for this connect, the role offers the machine's own `omnesis update` first, or stops and names it when there is no terminal. The harness roles no longer initialize or migrate the keyring, so they no longer seal an existing collector's credentials as a side effect.

In the portal's Connect an agent dialog, an address counts as direct to the gateway only when it presents the gateway's certificate on the port the gateway listens on. A Tailscale Funnel address that serves the same certificate is now labelled as a proxy, and its command still pins the fingerprint.
