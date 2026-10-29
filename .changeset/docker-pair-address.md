---
"omnesis": patch
---

A gateway installed with `install.sh --docker` on the default bridge network no longer recommends its container's own address for pairing a phone. `omnesis devices pair --kind ios|android` and the portal now offer the host's addresses and name that the installer wrote into the gateway's certificate first, as long as the certificate still covers them; the container's address and `omnesis.local`, which phones cannot reach through the bridge, are listed last.
