---
"omnesis": patch
---

The Docker images now ship their dependencies with the repository's patches applied, as source installs always have. Without them, a WhatsApp source running in the collector container let libsignal print whole Signal session records — ratchet private keys and root keys included — to the container's log each time a session was opened, closed or pruned; the images also lacked the Baileys pairing-platform fix and the better-sqlite3-multiple-ciphers type export. The image build now fails when a patch no longer applies, and the runtime smoke checks each patched file in every shipped image. Logs written by a collector container from an earlier image may contain those session records.
