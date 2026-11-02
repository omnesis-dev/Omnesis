---
"omnesis": patch
---

Docker installs and the native collector beside them behave the way they say they will.

- The `omnesis` command a Docker install writes finds Docker where Docker Desktop, OrbStack and Colima put it, so it works over a non-login `ssh` session, from cron and from launchd, and Docker Desktop's "What's next" advertisement no longer follows a failed command.
- Adding a folder source for a folder the collector's container cannot see shows only the explanation and the offer to share it.
- A native collector beside a Docker install names its own command (`omnesis-collector`) in every hint about itself, including the Full Disk Access steps, and `omnesis-collector status` talks to the gateway the collector is paired with instead of asking to trust `localhost`.
- Collectors pair under the name the installer prints: `<host>-collector`, where `<host>` is the machine's short name without a Mac's `.local`, and `<host>-mac-collector` for the native collector beside a Docker install on a Mac, so the two collectors on one machine have distinct names. Collectors paired before keep their names, and `omnesis pair` takes `--name`.
- A fresh install no longer asks to restart a collector it has not started yet, and arming the keyring with nothing to migrate prints one line instead of a table of zeros.
- `omnesis-collector uninstall` names its real device, offers to revoke it on this machine's Docker gateway, and with `--purge` also removes its keys from the OS keyring. `omnesis uninstall` on a Docker install removes the images of earlier releases too.
- `install.sh --docker --build` tags the images with the checkout's version (`<version>-local`) rather than the registry's newest release, so a later `omnesis update` moves the install onto the published images.
