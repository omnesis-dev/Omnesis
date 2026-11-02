---
"omnesis": patch
---

`omnesis sources add` works without a terminal, for scripts and AI agents. Give a source's settings with `--set key=value` (repeatable) or `--config <json | @file | ->`, and choose among the accounts a collector finds with `--account`; `omnesis sources describe [type]` lists the source types you can add and the keys each one takes. What is given is checked against the source's declared settings before anything is added. Without a terminal nothing is prompted: an answer the command line does not give fails with the flag that supplies it, and so does a sign-in step that needs a typed answer. A sign-in that ends without an account now exits nonzero too. An add aimed at a collector that is restarting, for example after `omnesis folders share`, waits for it to reconnect.
