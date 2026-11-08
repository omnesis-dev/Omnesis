---
"@omnesis/gateway": patch
---

When Anthropic model discovery fails before any model list has loaded, the gateway retries after 15 seconds, doubling the delay up to the hourly refresh, instead of waiting a full hour. Until a list loads, a model newer than the bundled list has no known limits and the agent caps its output at 4,096 tokens, which can stop answers before they finish.
