---
"omnesis": patch
---

Transcribe through a speech model served only through a chat API. When a backend has no `/v1/audio/transcriptions` endpoint, the transcriber check sends the audio as a chat completion with an `input_audio` part, and a backend that transcribes it is used that way, a minute of audio per request (Qwen3-ASR behind Ollama or llama-server, an audio language model on vLLM, OpenAI's audio chat models). A backend's `transcription` setting pins the protocol and the chunk length; a model answering in Qwen3-ASR's format gets one-minute chunks on the transcription API too. The per-recording deadline now allows a slow CPU audio model, and the OpenAI, Groq and Mistral presets, with the Voxtral, Scribe, Parakeet and Canary families, count as transcribers.
