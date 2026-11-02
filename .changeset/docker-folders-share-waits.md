---
"omnesis": patch
---

On Docker, `omnesis folders share` and `unshare` now return only once the container they recreate is back: running, and healthy for the gateway of a `--combined` install. A command run straight after a share on a combined install used to find no gateway answering ("Cannot reach gateway").
