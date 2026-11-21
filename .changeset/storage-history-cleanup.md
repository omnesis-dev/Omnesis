---
"@omnesis/gateway": patch
"omnesis": patch
---

Add manual background cleanup of Brain run logs, chat history and old backups from Settings → Storage, with persisted progress, cancellation and protection for active conversations and the newest backup.

Expose storage measurements, limits, source trimming, rolling retention and history/backup cleanup through `omnesis storage`, including JSON output, job progress, waiting and cancellation of history cleanup. Job lookups read durable progress by ID without scanning recent job lists or the source inventory.
