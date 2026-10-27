---
"omnesis": patch
---

Two fixes for the built-in agent on an OpenAI-compatible server such as Ollama. Streamed tool calls that share a stream index are now told apart by id, so a server that streams every call of a response at index 0 no longer has its parallel calls merged into one call with concatenated arguments and the rest dropped. A server that trims a request longer than its context window instead of refusing it, which Ollama does by default, now fails the turn with `prompt_truncated` and a message naming the reported and expected prompt sizes and the remedy, instead of returning an answer the model produced without its instructions and tools.
