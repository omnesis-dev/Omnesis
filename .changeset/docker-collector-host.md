---
"omnesis": patch
---

A machine that runs only a collector in Docker gets next steps that work there: its closing banner sends you to the gateway host or the portal to add sources, and the command for a Mac collector names the gateway it is paired with rather than this machine. `omnesis status` and the other admin commands on such a machine say to run them on the gateway host, instead of asking you to start a gateway or printing a stack trace. Its collector container now takes this machine's name, so its device keeps a readable name, and `omnesis uninstall` there reminds you to remove the device on the gateway host, as a native collector's uninstall does. A combined container no longer prints tini's "not running as PID 1" warning.
