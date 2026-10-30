---
"omnesis": patch
---

A Docker install, or `omnesis update` on one, no longer fails when a single registry connection is refused partway through pulling the images. `install.sh --docker` tries the pull up to three times, pausing longer each time and keeping the layers already downloaded. `omnesis update` pulls once more before rolling back. A refusal on credentials or a missing tag still stops at once, and the final message points at the network instead of the tag, which the installer has already checked. `install.sh --docker` also finds Docker Desktop's or OrbStack's `docker` when the terminal it runs in was opened before the install and so does not have it on PATH yet. It uses that `docker` for the install and says to open a new terminal, instead of reporting Docker as not installed.
