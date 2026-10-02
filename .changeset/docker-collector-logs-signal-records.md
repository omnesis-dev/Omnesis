---
"omnesis": patch
---

If you ran a WhatsApp source in the collector container from an earlier Docker image, that container's logs may contain Signal session records, which include session keys. After updating, rotate or delete the old collector container logs, for example by recreating the container, and remove any copies a log driver or log collector has shipped elsewhere. Source installs are not affected.
