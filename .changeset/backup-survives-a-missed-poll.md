---
"omnesis": patch
---

`omnesis backup` no longer fails while the backup is still running because one progress check could not reach a busy gateway. The backup runs on the gateway either way, and `omnesis update`'s pre-update backup waits the same way. The command now keeps checking, and still reports a gateway that stays unreachable for five checks in a row.
