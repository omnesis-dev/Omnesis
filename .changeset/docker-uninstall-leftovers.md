---
"omnesis": patch
---

`omnesis uninstall` of a Docker install now leaves nothing behind in two more cases. Re-running it after an uninstall that stopped part way still removes the job that renews the Tailscale certificate. And the uninstall that runs without the launcher (`npx omnesis uninstall`) now removes every older release's images and that renewal job too, as the launcher's does.
