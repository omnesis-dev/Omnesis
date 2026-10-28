---
"omnesis": minor
---

The transcriber role can run on any OpenAI-compatible `/v1/audio/transcriptions` server, such as whisper.cpp's `whisper-server` built for CUDA or Vulkan, vLLM or speaches, so a Linux host with a GPU transcribes in seconds what took minutes on the CPU. Assign it with `omnesis model assign transcriber <backend>/<model>`. The backend stays on the gateway's machine unless remote inference is allowed, and personal vocabulary hints are sent only to a backend on the same machine. A transcription that takes longer than five minutes is no longer abandoned and retried, and a recording whose caller has gone is no longer transcribed.
