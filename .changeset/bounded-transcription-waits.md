---
"omnesis": patch
---

Long recordings now finish on a slow transcriber: each part of a recording (ten minutes, or a minute for an audio language model) gets its own deadline, so a long recording is no longer cut off after 30 minutes in all and retried on every sync, while a server that stops answering is still given up within one part's time. A recording may take up to six hours. A slow vocabulary lookup no longer holds up voice notes and dictation; after three seconds the recording is transcribed without hints.
