---
"omnesis": patch
---

Re-running `install.sh --docker` onto another release (the upgrade path for releases older than `omnesis update`) now removes the previous release's images of that install once the new gateway serves, as `omnesis update` does. They used to stay on the machine, a gigabyte or more each, until `omnesis uninstall`.
