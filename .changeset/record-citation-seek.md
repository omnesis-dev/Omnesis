---
"omnesis": patch
---

When the agent cites a row from your structured data (a run, a transaction, a health sample), the gateway no longer freezes for seconds on a large corpus. Finding the document the row belongs to read an index entry for every document in the store, on the thread every request waits on; it now looks the document up by its id within the source directly. Following a record's connections uses the same lookup. Citations are unchanged.
