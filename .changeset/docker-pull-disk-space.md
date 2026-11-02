---
"omnesis": patch
---

`install.sh --docker` now checks that Docker's storage has room for the images (about 4 GB) before it writes anything, and a pull that still runs out of disk says so at once instead of retrying and telling you to check the network. `OMNESIS_DOCKER_PULL_DISK_GB` changes the requirement; 0 skips the check.
