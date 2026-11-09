---
"omnesis": patch
---

The installer and `omnesis update` now say so when ffmpeg's download fails. npm leaves that optional package out without an error, and voice notes then could not be transcribed, failing only later as "will be retried". The warning explains what is affected and how to fetch it. Published Docker images now fail their build instead of shipping without ffmpeg.
