---
"omnesis": patch
---

Use one Omnesis Apple Watch complication to record audio and send it as Ask or Tell. With a decision model enabled, Send chooses the route automatically; the setting can be disabled to keep explicit Ask/Tell buttons. Gateway transcription applies to both routes, with strictly on-device iPhone transcription and vocabulary hints when gateway transcription is disabled.

Recordings are buffered durably across Watch and phone delivery. Questions display their answer on the Watch, with opt-in playback and audio-only follow-ups in the same conversation. A confirmed displayed answer suppresses the fallback notification. Notes confirm immediately and return to the watch face once their transfer is safe. Cancel from the complication also returns to the face. The existing Ask complication updates in place; the separate Tell complication is removed. Siri actions remain separate.
