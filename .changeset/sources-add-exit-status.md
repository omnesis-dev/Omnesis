---
"omnesis": patch
---

`omnesis sources add` now exits nonzero when it refuses: a path the collector cannot read (including a host folder a Docker collector has not been given, where it names `omnesis folders share`), a declined credential step, no account to add, or a gateway that rejects the add. It used to print the error and exit 0, so a script or an agent took the source as added.
