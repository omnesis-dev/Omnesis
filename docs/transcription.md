# Transcription

How Omnesis turns audio into searchable text, what a transcriber can be, and
what the gateway does to keep an assignment that cannot transcribe from
looking like one that can. User-facing setup lives in
`website/docs/operating.html` (the transcriber on a GPU) and
`website/docs/apps.html` (gateway dictation); the wire shapes are in
`docs/model-support.md`.

## Two kinds of audio

**Tell Omnesis voice notes** (`POST /notes/voice`, from the apps and the
watch) are stored with their audio in `voice_note_transcriptions` and
transcribed by `packages/gateway/src/voice-notes/service.ts`. A note waits
for a runnable transcriber: while there is none the queue rechecks every 30
minutes, and a failed attempt is retried on a backoff (1 min, 5 min, 30 min,
2 h, 12 h) up to six times. The phone's own transcript stays on the note
until the gateway's replaces it.

**Source audio** (a WhatsApp or iMessage voice message) is transcribed during
the sync: the collector posts the bytes to `POST /inference/transcribe` and
the gateway answers with the transcript or `{ available: false }`. The audio
is held for the request only. When no transcriber can run, the message keeps
its placeholder and is only transcribed again on a resync of the source;
changing the transcriber model later does not reprocess it either.

## What a transcriber is

The `transcriber` role resolves to one of:

- a **local Whisper model** from the catalog (`local/whisper-*`), run in a
  worker subprocess through whisper.cpp; audio never leaves the machine;
- an **HTTP backend** that serves the OpenAI audio transcription API,
  `POST {url}{apiPathPrefix}/audio/transcriptions` (`HttpTranscriber`).
  Known to work: whisper.cpp's `whisper-server` started with
  `--inference-path /v1/audio/transcriptions`, speaches, vLLM serving a
  Whisper model, llama.cpp's `llama-server` with Qwen3-ASR (both protocols),
  Ollama 0.40 and later serving `frozenlab/qwen3-asr` (both protocols), and
  the hosted transcription APIs of OpenAI (`whisper-1`, `gpt-4o-transcribe`),
  Groq (`whisper-large-v3-turbo`) and Mistral (`voxtral-mini-latest`), which
  the backend presets mark as transcribing providers. A backend off loopback
  needs `inference.allowRemoteInference`, and personal vocabulary hints are
  sent only to a loopback backend;
- the **replay** transcriber for tests.

The chat backends (Anthropic, Codex, Claude Code) have no transcription
model and resolve to nothing with a log line.

### Two wire protocols

An HTTP backend reaches its speech model one of two ways
(`TranscriptionProtocol`):

- **`audio`**: `POST /audio/transcriptions`, multipart with a WAV file
  (`HttpTranscriber`). Ten-minute chunks, the upload limit.
- **`chat-audio`**: `POST /chat/completions` with an `input_audio` content
  part carrying the WAV as base64 and a short instruction
  (`ChatAudioTranscriber`). For a speech model served only through a chat
  API: an audio language model on vLLM or llama-server, Ollama's chat API,
  OpenAI's audio chat models. One-minute chunks, since an audio language model
  is accurate over a short stretch at a time (Qwen3-ASR holds to about a
  minute and falls off by two).

The operator can pin either, and the chunk length, per backend:

```json
"inference": {
  "backends": {
    "ollama": {
      "type": "http",
      "url": "http://127.0.0.1:11434",
      "transcription": { "protocol": "chat-audio", "maxChunkSeconds": 45 }
    }
  }
}
```

Unset, the transcription probe finds out (below) and the resolved assignment
carries `transcription: { protocol, maxChunkSeconds? }`, which the loader
reads to build the right client. Both clients split at the quietest moment
near each chunk limit (`splitPcm`) and join the chunks' words.

Qwen3-ASR writes its detected language ahead of the words
(`language English<asr_text>…`), and a server that passes the model's output
through puts that whole string in `text`. `parseTranscriptText` keeps the
words and turns the language into a code when the server reported none.

## The transcription probe

`/v1/models` says nothing about what a model does, so a chat-only server
that happens to list a model named `*-asr` looks exactly like a transcription
server. The registry therefore verifies a transcriber the way it verifies an
embedder: `InferenceRegistry.verifyModel(key, model, "transcriber")` sends one
second of a quiet tone as WAV to the backend's transcription endpoint and
records a `CapabilityVerdict`:

- `supported` when the endpoint answered with a `text` field; an answer in
  Qwen3-ASR's `language …<asr_text>` format marks the model as one that takes
  a minute at a time, and the verdict records a one-minute chunk;
- when the transcription endpoint is missing (a 404, 405 or 501 whose body
  does not name the model) and no protocol is pinned, the probe sends the
  same second of audio as a chat completion with an `input_audio` part. A
  transcript back means `chat-audio`; a refusal (vLLM, llama-server and
  Ollama all answer 400 for a model without audio input) is conclusive and
  names both failures;
- refused, with the backend's words, on any other 4xx or 5xx (a model the
  server does not have, a rejected key);
- `inconclusive` when there was no answer at all (a timeout, a refused
  connection, a URL the inference policy blocks). The probe waits up to a
  minute because speaches loads the model on the first request. An
  inconclusive verdict is reported but not cached: the assignment stays
  usable (the backend answered its model list, and a failed transcription is
  retried), and the backend re-probe task asks again on its active cadence
  until the backend answers (`transcriberAwaitsVerification`).

The verdict is cached per `(backend, model, role)` and dropped when the
backend's address or key changes. It is used in three places:

1. **Assignment.** `PATCH /admin/config` runs `InferenceRegistry.vetAssignment`
   for every assignment the body sets. A transcriber on a backend that
   answered it cannot transcribe is refused with HTTP 400 and the reason as
   `error`; the portal and `omnesis model assign` show that sentence. A
   backend that gave no answer is let through and verified again later. The
   portal checks before it
   writes, so the user sees "Checking that … can transcribe" and the refusal
   without a config write.
2. **Resolution.** `resolveHttpAssignment` reads the cached verdict for the
   transcriber role and resolves the assignment as `available: false` with
   the reason. The role card reads "Configured, but unavailable", `omnesis
model status` prints the reason, `TranscribeService.readiness()` reports
   it to `GET /status` (`dictation.reason`) and the loader builds nothing.
3. **The picker.** `GET /admin/models` carries each backend's verdicts; the
   model list marks a refused model with the backend's answer instead of a
   Use button.

The gateway verifies the assigned transcriber after the boot probe and on
every config change touching the assignment, a backend or the remote
inference flag (`verifyTranscriberAssignment`), and logs one line saying what
to do when it cannot transcribe.
