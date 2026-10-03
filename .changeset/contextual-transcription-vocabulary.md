---
"omnesis": patch
---

Add optional contextual vocabulary hints for gateway Whisper and supported on-device iOS/Android transcription, learned in bounded background batches from indexed documents. Mobile apps refresh a bounded dictionary in the background and read it from memory without delaying recording. Enable with `inference.transcriptionVocabulary.enabled: true`; vocabulary computation and hints are disabled by default.
