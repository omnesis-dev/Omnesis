---
"omnesis": patch
---

A search no longer holds up the rest of the gateway while it reads its results' links. The links and file type of each result are now read on a read worker, and only for the results the search returns, instead of on the gateway's main thread for its whole candidate pool. On a busy store that read could freeze every other request for a second or more.
