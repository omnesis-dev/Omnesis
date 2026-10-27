---
"omnesis": patch
---

Check a transcriber backend before assigning it. The gateway asks an HTTP backend to transcribe one second of audio when the transcriber role is assigned to it, and refuses the assignment with the backend's answer when it cannot (a chat-only server with no `/v1/audio/transcriptions` endpoint, a model the server does not have). The Models page says what a transcriber needs, marks a model the backend has refused, and the role reads "configured, but unavailable" with the reason instead of a green check for a backend that will not transcribe. The HTTP transcriber also reads Qwen3-ASR's `language …<asr_text>` prefix as the detected language, so Ollama and llama-server serving that model return clean text.
