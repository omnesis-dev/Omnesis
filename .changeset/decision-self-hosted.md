---
"omnesis": minor
---

The Decision model can run on a local GGUF chat model (`local/<file>.gguf`) or an OpenAI-compatible server that returns token log-probabilities, such as llama-server or vLLM (`<backend>/<model>`), as well as on TypeSafe. Each question is answered from the probabilities the model gives its one-token answer labels; a server that returns no log-probabilities, or a model whose answer is not one of the labels, leaves the decision unanswered, and callers fall back as they do when TypeSafe is unreachable. A TypeSafe-compatible endpoint on this host needs neither an API key nor remote inference, and one elsewhere on your network needs no key. Codex, Claude Code, Anthropic and Responses-only backends cannot serve the role. `scripts/eval-decision-cassette.mts` measures how often a candidate model agrees with recorded decisions.
