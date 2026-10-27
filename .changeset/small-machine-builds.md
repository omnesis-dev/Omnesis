---
"omnesis": patch
---

Updates on a machine with less than about 5 GB of memory now stop the gateway as well as the collector while the build runs, so the build is no longer killed beside a serving gateway and rolled back; the gateway is down until it restarts on the new release. Docker image builds give the TypeScript compile a 3 GB heap instead of Node's default, which a small builder ran out of. `install.sh --docker --build` checks that Docker's storage has about 25 GB free before building, and says so instead of failing with a containerd export error.
