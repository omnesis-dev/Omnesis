---
"omnesis": minor
---

Experimental: the iOS app can hold a realtime voice conversation with the Omnesis agent, using the same prompt, tools, permissions and conversation as text. It needs `OMNESIS_EXPERIMENTAL=1`, remote inference allowed, and an OpenAI backend explicitly assigned to the new Speech to speech role with `gpt-live-1`. Audio goes from the phone to OpenAI and is not stored by Omnesis; the transcript, tool activity and citations stay in the conversation.
