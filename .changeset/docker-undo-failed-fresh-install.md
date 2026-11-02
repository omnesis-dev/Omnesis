---
"omnesis": patch
---

A first `install.sh --docker` that stops before its containers start — the images will not pull, or the collector's pairing code is refused — now removes the compose file, install marker and `omnesis` command it wrote. They used to stay, so the host looked like it had a Docker install (and a later native install was refused) although nothing ran. An existing install is never undone.
