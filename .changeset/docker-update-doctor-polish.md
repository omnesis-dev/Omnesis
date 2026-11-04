---
"omnesis": patch
"@omnesis/core": patch
---

Docker installs read more cleanly and report the host correctly.

- `omnesis update` reports its pre-update backup as one line, even when it runs without a terminal. Before, a run without a terminal printed the backup's JSON report in the middle of the update.
- Re-running the installer removes an old updater image that the last update kept because it was still running.
- `omnesis doctor` on a Docker install reports the disk encryption of the host, not of the container's mount. It no longer warns that there are no service units, since Docker runs the containers.
- When `keyring migrate` finds every secret file already encrypted, it now prints one line instead of a table of zeros.
