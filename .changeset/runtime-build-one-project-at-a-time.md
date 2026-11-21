---
"omnesis": patch
---

Building the Docker images from source no longer runs out of memory while compiling: the image build compiles one project per compiler process, as a source install on a smaller machine already did, so its peak is the largest project's rather than the whole build's. A source install or update whose build heap is set below 6 GB by hand, through `NODE_OPTIONS`, now also builds one project at a time, even on a machine with plenty of memory.
