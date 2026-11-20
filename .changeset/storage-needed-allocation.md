---
"@omnesis/gateway": patch
---

Avoid an unused full page walk of the main database during storage measurement. Main storage totals continue to use file sizes and document payloads, while search-index page attribution supplies lexical-index sizes independently.
