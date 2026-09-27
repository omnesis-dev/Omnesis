---
"omnesis": patch
---

OpenClaw and Hermes can use Direct and Notes when their connection's access level grants them. Each plugin lists the connection's tools on `/mcp` and offers the Direct and Notes ones as native tools named `omnesis_` followed by the gateway's tool name — `omnesis_list_tables`, `omnesis_run_sql`, `omnesis_add_note` and the rest — with the gateway's own descriptions and input schemas, forwarding each call to the same gateway tool. A connection without Direct or Notes is offered none of them. OpenClaw re-reads the connection's tools every five minutes and whenever the gateway refuses a call; Hermes reads them when it loads the plugin, so it picks up a newly granted tool on its next restart. Both keep the last listing so a restart with the gateway down keeps the tools they had. The installed skill describes the new tools, and `/mcp` responses of up to 4 MiB are accepted so the largest Direct results reach the agent.
