---
"omnesis": patch
---

An `omnesis` CLI older than its gateway no longer crashes when the gateway reports a value the CLI does not know yet. `omnesis model list` and `model status` show a model assigned through a newer kind of backend by its name, and `omnesis tls status`, `omnesis doctor`, `omnesis watches list` and `omnesis push status` likewise show a newer certificate source, renewal mode, delivery kind or phone state as the gateway reported it.
