---
"omnesis": patch
---

Re-running `install.sh --docker --collector` on a machine whose collector is paired already now keeps that device and needs no new pairing code. It used to demand a code every time (and refuse without a terminal), and redeeming it paired the machine again as a new device, leaving the old one and its sources behind. A `--code` given anyway, or another `--gateway-url`, still pairs again.
