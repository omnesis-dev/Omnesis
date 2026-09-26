---
"omnesis": patch
---

Re-running the installer on a machine whose last update was interrupted now reads the installed version from the build the update returns to even when `--source-dir` names the checkout through a symlink, as a macOS temporary directory under `/var` is. The installer handed the updater the path as typed, which did not match the physical path in the update record, so it judged the version by the half-applied checkout and could leave out the `--force` an updater older than 0.5.6 needs.
