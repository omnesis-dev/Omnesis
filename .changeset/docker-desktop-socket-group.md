---
"omnesis": patch
---

Docker installs on a Mac (Docker Desktop, or another daemon that runs in a VM) can update again. The update container joined the group the Docker socket has on the host, but inside a container the socket belongs to another group (root's, in the VM), so `omnesis update` stopped at `docker compose pull` with "permission denied" on the Docker socket, and its rollback failed the same way.

**If you installed with `--docker` on a Mac with 0.7.1 or 0.7.2, re-run the installer once**, with the options you installed with — for a default install:

```sh
curl -fsSL https://omnesis.dev/install.sh | sh -s -- --docker
```

It keeps your data, keyring and pairing, asks a container which group the socket has, and moves you to the newest release. `omnesis update` works from then on. Docker Engine installs on Linux are not affected.

- The installer now asks the updater image which group the socket has inside a container, and the update checks that its container can reach the daemon before it changes anything. If it cannot, it says nothing was changed and which release the install still runs, and corrects the updater's group in the Compose file (run `omnesis update` again) or prints the installer line to run.
- When a failed pull also fails on the way back, the update now says nothing was changed, instead of "may be built inconsistently".
- Docker installs pull their images quietly, with one line per image, instead of hundreds of layer-progress lines.
- On a terminal, the Docker installer's keyring steps print what the native installer prints instead of raw JSON, and the recovery code is shown once, prominently, on the terminal only — never in a log the run's output is captured into. Compose's "Container … Created" lines no longer surround `omnesis` commands that run in a one-shot container.
- The recovery code's note on the passphrase backend says it recovers your data if the passphrase file is lost.
- The Docker install's closing tip about multicast and `--docker-network host` is shown on Linux only.
- The installer no longer adds a PATH line to a shell profile that already puts `~/.local/bin` on PATH, and `omnesis uninstall` on a Docker host says when it keeps the installer's PATH line because other programs share the directory.
- A source install reports the Node it found once.
