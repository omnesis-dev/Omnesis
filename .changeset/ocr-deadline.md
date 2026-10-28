---
"omnesis": patch
---

`inference.ocr.requestTimeoutSeconds` now bounds an image's OCR on the gateway as well as on the collector, with one default of 120 seconds. At the deadline, or when the collector gives up, the gateway stops the backend's work instead of letting it run on and slow the next images.
