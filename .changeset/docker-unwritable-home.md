---
"omnesis": patch
---

`install.sh --docker` now checks, before writing anything, that it can write the config directory and `~/.local/bin`. An account whose home it cannot write, or a config directory an earlier `sudo` run left to root, gets a message naming the directory and the `chown` that fixes it, instead of a bare `mkdir: Permission denied` partway through.
