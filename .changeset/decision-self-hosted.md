---
"omnesis": minor
---

A TypeSafe-compatible endpoint of your own can serve the Decision model: one on this host needs neither an API key nor remote inference, and one elsewhere on your network needs remote inference allowed but no key, while any `typesafe.ai` endpoint still needs its key. In experimental mode, the Decision model can also run on a local GGUF chat model (`local/<file>.gguf`) or an OpenAI-compatible server that returns token log-probabilities, such as llama-server, vLLM or Ollama (`<backend>/<model>`); each question is answered from the probabilities the model gives its one-token answer labels, and a question it cannot answer leaves the decision unanswered, as when TypeSafe is unreachable. Outside experimental mode such an assignment is refused, because every decision threshold was tuned on TypeSafe Jev. `scripts/eval-decision-cassette.mts` measures how often a candidate model agrees with recorded decisions and how much of what they passed it would keep.
