---
"omnesis": patch
---

`omnesis restore --force` no longer deletes what the machine owns. It used to replace the whole config directory, so restoring a backup from `omnesis backup --list` deleted every other backup, the downloaded models, exports and logs, and, on a Docker install, the Compose file and install marker. A restore now replaces only what a backup holds (the databases, config material, tokens, TLS certificates and the recovery envelope), removes items of that kind the backup does not hold, such as an index it was taken without, and keeps everything else, including this machine's image tag and keyring settings in `.env`. A failed restore still leaves the directory as it was.

On a Docker install, `omnesis restore` now works from the host: it stops the containers, restores in a one-off container of the gateway's image, starts them again and waits for the gateway to report healthy. At a terminal it asks before replacing a corpus; without one it needs `--force`. A backup copied in from another machine restores with `--code`. `omnesis service start|stop|restart|status|logs` runs its `docker compose` equivalent there instead of failing with a stack trace, and inside a container both commands name the host command to run.
