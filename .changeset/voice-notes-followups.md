---
"omnesis": patch
---

Gateway dictation for Tell Omnesis is on by default whenever a transcriber model is assigned, without experimental mode; set `inference.dictation.transcribeOnGateway` to false to keep the phone's transcript only. The Brain waits for a voice note's gateway transcript — or for the gateway to give up on it — before reading the note, up to `brain.pendingContentBarrier` (1 hour), so it reads each note once, in the gateway's words. Apple Watch notes dictated as text are kept on the watch until the iPhone confirms it has them, like recorded voice notes. The portal's Tell Omnesis page marks a voice note still being transcribed, and no longer shows the gateway's transcript as an edit.
