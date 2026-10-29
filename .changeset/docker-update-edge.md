---
"omnesis": patch
---

`omnesis update --edge` on a Docker install is refused before anything changes, instead of failing at the pull with `manifest unknown` and rolling back: no image follows the main branch. Pin a release with `--target-version`, or an exact commit's published `sha-*` images as the updating guide describes. On a machine that runs only a collector in Docker, `omnesis update` recognises that the collector already runs the newest release instead of planning to reinstall it.
