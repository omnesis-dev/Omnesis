# Model support over OpenAI-compatible HTTP backends

How Omnesis drives inference against any OpenAI-compatible HTTP backend — a local
server (vLLM, Ollama, llama-server, text-embeddings-inference) or a cloud API
(OpenAI, Google's Gemini shim, Groq, Cerebras, Together, Fireworks, Mistral,
DeepSeek, NVIDIA, xAI, Meta, Moonshot AI, OpenRouter). This is an engineering reference for the wire protocol Omnesis speaks and
the small set of general principles that keep it working across providers without
a per-model lookup table.

Scope: the inference purposes Omnesis drives over an HTTP backend — **embedder**,
**single-shot completions**, and **agent**.

## Design stance: no per-model registry

**Omnesis deliberately does not try to "know what each model does."** Encoding
per-model capabilities — protocol, tool support, parameter rules, reasoning-token
quirks — as a registry in Omnesis would be a maintenance sink that is wrong the
moment a provider ships a changelog. The provider's API is the source of truth; a
copy baked into Omnesis is a copy that is always drifting.

Compatibility is instead handled by **general principles, not a model database**:

1. **Send the most broadly-accepted request, and degrade gracefully.** Prefer
   request shapes that the largest set of models accept; on a specific, documented
   rejection (an unsupported parameter, a "not a chat model" 404), retry without
   the offending field or against the alternate endpoint. This turns "know it's a
   reasoning model" into "react to the 400," and "know it's Responses-only" into
   "fall back on the 404" — discovery, not a lookup table.
2. **Preserve everything the wire hands back.** Several apparent incompatibilities
   are really a client discarding protocol data and then sending an invalid
   continuation. Gemini's `thought_signature` is the clearest case: the field is
   in the response; the client carries it through unchanged rather than
   special-casing Gemini.
3. **Classify structured failures without copying provider bodies.** Provider
   error codes and documented envelope fields select stable Omnesis error codes
   and compatibility fallbacks. Raw upstream bodies can echo private prompt
   content, so transcripts and logs receive only a safe message plus bounded
   metadata such as HTTP status, error type/code, request id, and body size.

The one thing the protocol genuinely cannot tell us — whether a model id is an
embedder or a chat model — is also **not** solved with a capability database. It
is handled by a cheap name heuristic (`classifyModelRoles`) that is explicitly
_a suggestion, not a limit_, paired with a free-text escape hatch so any model
can be assigned by hand.

The anti-goal, stated plainly: **do not build a per-model capability registry.**
Operator-declared token ceilings are not such a registry: they are optional
deployment facts keyed by the backend's exact served model id, never inferred
from a model name and never borrowed by another model.

## Talking to a backend

Omnesis speaks **only** the OpenAI-compatible wire protocol, hand-rolled (no
provider SDKs). Each purpose has a fixed request shape; compatibility is a
question of whether a given provider/model accepts that shape, with the resilience
ladders below recovering the common rejections.

Two shared building blocks apply to every purpose:

- **`inference.allowRemoteInference`** (config; default off). When off, the
  gateway only probes and calls loopback HTTP inference endpoints, so document
  chunks, queries, prompts, and OCR images stay local unless the operator
  explicitly opts in. Enforced at the transport by `fetchWithInferenceUrlPolicy`.
- **`apiPathPrefix`** — the path segment between the base URL and the
  OpenAI-compatible endpoints (`/chat/completions`, `/embeddings`, `/models`),
  normalized by `normalizeApiPathPrefix` (leading slash, no trailing slash,
  defaults to `/v1`). Most providers serve at `host + /v1`; some bake a different
  version path into their base (e.g. Gemini's OpenAI shim lives at
  `…/v1beta/openai`, configured as a bare host `url` plus
  `apiPathPrefix: "/v1beta/openai"`), so URLs never double-version into a 404.
- **`modelLimits`** — optional positive-integer ceilings keyed by exact model id:
  `maxInputTokens`, `contextWindowTokens`, and `maxOutputTokens`. The resolved
  agent receives only its exact entry. This is useful because OpenAI-compatible
  `/models` responses do not standardize token limits. Without a configured
  limit, Omnesis still reports provider token measurements when available, but
  cannot calculate a percentage or perform a trustworthy client-side preflight.
- **`agentTimeoutMs`** — optional positive per-request timeout for agent
  generation. When absent, requests use two minutes until the backend exposes
  reasoning behavior or returns an empty output-limit exhaustion, then ten
  minutes for later requests on that backend instance.

### Embedder — `HttpEmbedder`

`packages/gateway/src/indexer/http-embedder.ts`

- `POST <base><apiPathPrefix>/embeddings`, body `{ model, input: string[] }`. Bulk
  inputs are batched (default 32, `OMNESIS_EMBED_BATCH_SIZE`) and each input is
  capped at ~4096 chars (surrogate-safe) as a transport backstop; genuine token
  overflow surfaces as a 400 handled by the resilient orchestrator.
- Bulk indexing bounds its in-flight requests (default 4,
  `OMNESIS_EMBED_BULK_CONCURRENCY`) so it can't flood a shared embedding server;
  the interactive search embedder runs unbounded and single-input, so a query
  embed interleaves instead of queuing behind a bulk flood.
- **Does not send `dimensions`.** A configured smaller output dimension is
  truncated **client-side by slicing** (no re-normalization). The vector index
  uses cosine distance (`MetricKind.Cos`), so magnitude loss from slicing is
  irrelevant to ranking — but slicing is only _semantically_ valid for
  Matryoshka-trained embedders (e.g. OpenAI `text-embedding-3`); slicing a
  non-Matryoshka output corrupts the vector. By default no output dim is forced,
  so no truncation happens.
- Optional per-model retrieval encoding: a text-prefix pair (distinct query vs.
  document prefixes) or an API-parameter role (a top-level body field per call,
  e.g. Voyage's `input_type`). Defaults to none.
- Response requires `data: [{ embedding, index }]` with one entry per input;
  `usage` is read into the type but **not required** — a provider that omits it is
  fine.
- Auto-discovery (`probeHttpEmbedder`): if no model is configured, the probe
  filters `/models` through `classifyModelRoles` and uses the sole embedder,
  erroring clearly when none or several are served. Setting the model explicitly
  is still recommended for cloud backends.

### Completions — `HttpCompleter`

`packages/gateway/src/inference/http-completer.ts`

The single-shot "prompt in, text out" path, with no tools and no conversation
state — the counterpart to the agent backend below, for the internal
classification passes that ask a model one bounded question. It is what
`inference/completion-loader.ts` and `inference/entailment-loader.ts` build when
the assigned backend is an OpenAI-compatible HTTP server, so it serves the
`entailment-verifier` role (the annotation write gate's firewall) and the
token-identity classification pass, which runs during backfill on the
`background-agent` assignment.

- `POST <base><apiPathPrefix>/chat/completions`, **non-streaming**, body
  `{ model, messages: [{ role: "user", content }], max_tokens: 150,
temperature: 0.3, stop? }`. Reads `choices[0].message.content`, with inline
  `<think>…</think>` stripped. No tools. 30s timeout.
- Reasoning models are handled by retry, not detection (principle 1): a 400 retries
  with `max_completion_tokens` (default temperature, no `stop`) at a large budget
  (`REASONING_RETRY_TOKENS`, floored at the caller's request), and a 200 reply
  that is empty with `finish_reason:"length"` re-issues once at the large budget —
  so hidden reasoning tokens don't crowd out the visible answer.
- `completeWithUsage` additionally returns the provider-reported `usage`, summed
  across whichever internal retry fired, so every billed call is cost-accounted
  and not just the one whose text is returned. `usage` is null when the server
  reports none.
- Non-2xx responses are drained but never quoted: the thrown error carries only
  the status, model id, byte count, and content type, because a misconfigured
  backend can echo the submitted prompt back in its error body.

### Agent — `HttpAgentBackend`

`packages/agent/src/http-agent-backend.ts` routes each turn to one of two
OpenAI-compatible wire protocols, with no per-provider branching:

- **`chat-completions`** (`HttpChatBackend`, `packages/agent/src/http-backend.ts`)
  — the default; every OpenAI-compatible server speaks it.
- **`responses`** (`OpenAIResponsesBackend`,
  `packages/agent/src/openai-responses-backend.ts`) — the OpenAI
  `POST /v1/responses` protocol, for models served **only** there (they 404 on
  chat-completions as "not a chat model").

**Protocol selection.** An explicit `protocol` in the backend config pins the
choice. When unset, the first turn tries chat-completions and, on a "not a chat
model" / "v1/responses" 404 before any output, transparently re-runs that turn
against the Responses API and memoizes the decision for the rest of the session —
so a Responses-only model works with zero configuration while the common
chat-completions path pays no extra request.

**Chat-completions request shape.** `stream: true`, body
`{ model, messages, stream_options: { include_usage: true }, max_tokens, tools? }`.
The system prompt is a `role: "system"` message. Every output budget is clamped
to the exact model's configured `maxOutputTokens` when present. A precise
structured "unsupported parameter" rejection switches once to
`max_completion_tokens` and caches that field choice; the cap is never omitted.
Requests default to 4,096 output tokens when no
`maxOutputTokens` is configured. Omnesis recognizes reasoning content exposed
by the response rather than maintaining a model-name list; later requests on
that backend instance default to a 16,384-token extended budget when no
`maxOutputTokens` is configured. An explicit configured allowance is never
lowered. Any response with no visible answer or tool call and
`finish_reason:"length"` retries once at up to 32,768 when the configured model
ceiling permits a larger attempt, including providers that do not expose their
hidden reasoning. Does not send `temperature` or `tool_choice`.

**Resilience ladder (no per-model branching).** On a 400/422 the chat backend
retries without `stream_options` (some providers reject the unknown field), then
falls back to a non-streamed request (some providers gate streaming of reasoning
models behind account verification); the non-streamed reply is adapted into the
same event sequence. Apart from the bounded 429 retry below, a non-400/422
status is terminal. The winning shape is
remembered per backend (`streamOptionsUnsupported`, `streamingUnsupported`) so
later iterations skip a rejected shape. `stream_options` is sent by default so
usage accounting works, but it is no longer fatal.

Before treating a 429 as terminal, runtime OpenAI-compatible inference requests
retry it up to twice with a short jittered exponential delay. `Retry-After` and
compatible `x-ratelimit-reset-*` dimensions are honored when they fit within a
15-second total wait budget; longer waits remain terminal. Agent errors include
the suggested delay when one is available. The original body and the request's
existing deadline are retained. Discovery probes and the optional Responses
input-token count do not use this retry path.

**Responses request shape and counting.** Requests send
`truncation: "disabled"` and an explicit `max_output_tokens` ceiling. Requests
default to 4,096; reasoning items and summaries exposed by the response are
recognized for later requests. An empty `max_output_tokens` incomplete response
gets the same bounded retry of up to 32,768 as chat completions when the
configured ceiling permits a larger attempt. The provider therefore cannot
silently compact or truncate input. Before every model request Omnesis probes
`POST /responses/input_tokens` with the same semantic request body, including
`previous_response_id` and new tool outputs on chained iterations. A successful
count is reported even when no limit is configured. A 404/405/501 marks counting
unsupported for that backend instance; transient or malformed count failures
fall through to the real request. A count blocks the request only when it exceeds
a configured input/context ceiling after reserving output and safety headroom.

**Context failures and usage.** Chat-completions has no universal counting
endpoint, so it relies on provider-reported `prompt_tokens` plus reactive,
structured context-limit errors. Responses uses its count endpoint when
available and otherwise does the same. Context rejection is terminal for the
turn and does not walk the compatibility ladder. Provider bodies are never
copied into client events or transcripts. Streaming usage fields are cumulative:
the last usage value for each request wins, then tool-loop request totals are
summed. A Responses `incomplete_details.reason` of `max_output_tokens` and a Chat
Completions `finish_reason` of `length` are explicit output-truncation failures,
not successful turns.

**Tools.** OpenAI function-calling schema; multi-round tool loop (default max 50,
`maxToolIterations`). Each round replays the **full** message list — the assistant
turn (`content` + `tool_calls`) followed by `role: "tool"` results. A tool call's
opaque `extra_content` (e.g. Gemini's `thought_signature`) is preserved through
the accumulator, persisted on the tool_use history part, and replayed verbatim on
later turns — both within a turn and across turns — so a multi-round reasoning
conversation stays valid.

**Parsing.** Streaming `choices[0].delta.content` (inline `<think>…</think>`
stripped by `createThinkTagFilter`, streaming-safe across deltas) and
`delta.tool_calls[]`; `delta.reasoning_content` is surfaced as a thinking event
and never echoed back in history. Usage read from
`usage.prompt_tokens` / `completion_tokens`. 120s timeout. Non-2xx bodies are
classified into privacy-safe Omnesis failures by `decodeHttpError`.

## Model roles and presets

### Role classification — `classifyModelRoles`

`packages/core/src/models/model-roles.ts`

The OpenAI-compatible `GET /models` response advertises only `{ id }` per model —
never the model's type or purpose. `classifyModelRoles` derives purpose from a
pure model-name heuristic (no network, no learned model), shared by the gateway
(applied server-side before shipping the `/admin/models` overview) and the CLI;
the portal reads the gateway-computed result.

- `transcriber`, `ocr`, and `embedder` are exclusive single-purpose roles matched
  by name families.
- Generative models serve every text role: `agent`, `privacy-reviewer`,
  `background-agent`, `watch-judge`, `entailment-verifier`, and `brief-judge`. The latter five
  deliberately offer exactly the models the Agent capability does, so a model
  that can hold a conversation can also be assigned to any of the bounded
  passes.

`watch-judge` is narrower at runtime than the shared generative classification:
it accepts Codex, a local GGUF, Anthropic, or an OpenAI-compatible HTTP backend
using Chat Completions. Replay and Responses-only HTTP backends are rejected
for this single-shot Watch role. Codex uses an independent inference turn.

- Non-generative, non-suggestable families classify to **no** role: TTS,
  image/video/music generation, moderation/guard, and cross-encoder scoring
  models — keeping ids like `tts-1`, `dall-e-3`, `*-moderation`, `bge-reranker-v2`
  out of every capability tab.
- The non-suggestable check runs **before** the embedder check, and that ordering
  is load-bearing. A pair-scoring model produces a relevance score, not a vector,
  yet a name like `bge-reranker-v2` carries the embed-family token `bge`; without
  the earlier check it would be suggested as an embedder and quietly yield
  meaningless embeddings.
- An id matching no known family defaults to generative — the safe default, since
  most models are generative and an unusually-named model can still be typed into
  the right tab by hand.

The heuristic is the **default, not the last word**: every capability tab pairs it
with a free-text box, so any model can be assigned by hand regardless of what the
name implies.

### Provider presets — URL auto-fill only

`packages/core/src/models/provider-presets.ts`

`PROVIDER_PRESETS` auto-fills a backend's base URL and `apiPathPrefix` when adding
a new HTTP backend from a known provider. Presets carry no model ids: model
suggestions come only from the backend's live `/models` probe, so an unprobed
backend shows no suggestions rather than a potentially stale hardcoded list.
`extractModelIds` accepts both the OpenAI shape
(`{ object: "list", data: [{ id }, …] }`) and the bare top-level array some
providers return, so a single probe works across providers without branching on
provider identity.
