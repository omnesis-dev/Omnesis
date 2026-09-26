---
"omnesis": patch
---

Re-running the installer with `--source-dir` on a machine whose last completed build predates 0.5.6 again hands the update to `omnesis update --yes --force`. When the named path reached the recorded checkout through a symbolic link, as a macOS temporary directory does through `/var`, the installer looked up the installed build by the wrong path, read the checkout's current commit instead, and left out `--force`. The old updater then refused a target that shares no history with the installed build.
