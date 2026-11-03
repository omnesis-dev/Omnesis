---
"omnesis": patch
---

Cancelling a WhatsApp backup import no longer kills its worker thread in the middle of reading the backup's SQLite database, which could crash the whole collector process. The worker now stops between batches, with the database closed.
