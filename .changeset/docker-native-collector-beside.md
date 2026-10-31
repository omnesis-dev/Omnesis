---
"omnesis": patch
---

A native collector now installs cleanly on the same machine as a Docker install. Running the `--collector` line a Docker install prints, on that machine, puts the collector beside it with its own command (`omnesis-collector`), config directory (`~/.config/omnesis-collector`), checkout, service and device token, instead of replacing the Docker install's `omnesis` command and sharing its directory and token. When the Docker gateway is on the same machine, the collector dials it at `localhost` and, on a terminal, mints its own pairing code with it. `omnesis-collector uninstall` and the Docker install's `omnesis uninstall` each remove only their own install, and a Docker install is refused while a native install it would take over is still registered.

A Docker install's collector can now read folders on the host. `~` and relative paths in `omnesis sources add` mean the machine you type on, not the container; a folder the collector's container cannot see is offered for sharing on a terminal, mounted read-only at the same path, and the add continues. `omnesis folders`, `omnesis folders share <path>` and `omnesis folders unshare <path>` manage the shares, which re-runs and updates keep. A path the container cannot see now says so and names the command that shares it.

The download progress line of `omnesis model install` no longer leaves stray characters behind when it gets shorter.
