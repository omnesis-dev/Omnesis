---
"omnesis": patch
---

Direct MCP connections gain a read-only `list_tables` tool that returns, page by page, the analytics tables and columns the connection may query with `run_sql`. Clients that keep only the start of a server's instructions no longer lose the table list: the instructions now open with the privacy warning, untrusted-data handling and the discovery step, and a refused query points at `list_tables`.
