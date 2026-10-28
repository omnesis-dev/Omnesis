---
"omnesis": patch
---

Add contextual vocabulary hints, learned in bounded background batches from indexed documents, for the gateway's transcriber (local Whisper, or an HTTP transcription server on the same machine) and supported on-device iOS and Android transcription. Mobile apps refresh a bounded dictionary in the background and read it from memory without delaying recording. Vocabulary is on by default; turn it off with `inference.transcriptionVocabulary.enabled: false`.
