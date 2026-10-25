---
"omnesis": patch
---

Add contextual vocabulary hints for gateway Whisper and supported on-device iOS/Android transcription, learned in bounded background batches from indexed documents. Mobile apps refresh a bounded dictionary in the background and read it from memory without delaying recording. Vocabulary is on by default; turn it off with `inference.transcriptionVocabulary.enabled: false`.
