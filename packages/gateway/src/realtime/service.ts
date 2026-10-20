// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { z } from "zod";
import { createLogger, experimentalEnabled, normalizeTimeZone } from "@omnesis/core";
import { REALTIME_MODEL, RealtimeBackend } from "./backend.js";
import { RealtimeInputSequencer } from "./input-sequencer.js";
import type { AgentService, RealtimeAgentSession } from "../agent/service.js";
import type { OmnesisConfig } from "@omnesis/config";

const MODEL = REALTIME_MODEL;
const MAX_FRAME_BYTES = 128 * 1024;
// session.updated echoes the complete interactive prompt and tool manifest.
const MAX_UPSTREAM_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const MAX_CALL_MS = 30 * 60 * 1000;
const MAX_CLIENT_DIAGNOSTICS = 12;
const diagnosticCounter = z.number().int().min(0).max(10_000_000);
const clientEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.end") }).strict(),
  z
    .object({
      type: z.literal("client.audio_diagnostics"),
      stage: z.enum(["starting", "ready", "configuration_changed", "timeout"]),
      rawBuffers: diagnosticCounter,
      pcmBuffers: diagnosticCounter,
      sentFrames: diagnosticCounter,
      engineRunning: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("input_audio_buffer.append"),
      audio: z
        .string()
        .min(1)
        .max(96_000)
        .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    })
    .strict(),
  z.object({ type: z.literal("input_audio_buffer.clear") }).strict(),
  z.object({ type: z.literal("response.cancel") }).strict(),
  z
    .object({
      type: z.literal("conversation.item.truncate"),
      item_id: z.string().min(1).max(256),
      content_index: z.literal(0),
      audio_end_ms: z.number().int().min(0).max(MAX_CALL_MS),
    })
    .strict(),
]);
const upstreamEvent = z.object({ type: z.string() }).passthrough();
const transcriptionUsage = z.object({
  item_id: z.string(),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
});

export interface RealtimePeer {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  bufferedAmount?: number;
}
export interface RealtimeConnection {
  receive(data: string): void;
  close(): void;
}
export interface RealtimeDeps {
  getConfig(): OmnesisConfig;
  getApiKey(backend: string): string | undefined;
  getAgent(): AgentService | undefined;
  isAuthorized(token: string, callerId: string): boolean;
  connect?: (apiKey: string) => WebSocket;
  logger?: Pick<ReturnType<typeof createLogger>, "info" | "warn">;
  recordUsage?: (
    usage: { promptTokens: number; completionTokens: number; cacheReadTokens?: number },
    model: string,
  ) => void;
}

/** Select only the real OpenAI service, never a backend named after it. */
export function realtimeBackend(
  config: OmnesisConfig,
  key: RealtimeDeps["getApiKey"],
): string | undefined {
  if (!experimentalEnabled() || !config.inference?.allowRemoteInference) return undefined;
  for (const [name, backend] of Object.entries(config.inference.backends ?? {})) {
    const url = new URL(backend.url);
    if (url.origin === "https://api.openai.com" && !url.username && !url.password && key(name))
      return name;
  }
  return undefined;
}

/** Each phone call owns its upstream socket and cancellation scope. No audio is persisted. */
export class RealtimeService {
  private readonly active = new Set<() => void>();
  private readonly log: Pick<ReturnType<typeof createLogger>, "info" | "warn">;
  constructor(private readonly deps: RealtimeDeps) {
    this.log = deps.logger ?? createLogger("gateway:realtime");
  }

  capability(): {
    available: boolean;
    model: string;
    directAgentTools: boolean;
    canonicalAgentEvents: boolean;
    protocol: { min: number; max: number };
    audio: { format: string; sampleRate: number };
  } {
    return {
      available: !!this.backend() && !!this.deps.getAgent(),
      model: MODEL,
      directAgentTools: true,
      canonicalAgentEvents: true,
      protocol: { min: 1, max: 2 },
      audio: { format: "pcm16", sampleRate: 24000 },
    };
  }

  private backend(): string | undefined {
    return realtimeBackend(this.deps.getConfig(), (name) => this.deps.getApiKey(name));
  }

  open(
    peer: RealtimePeer,
    callerId: string,
    options: { conversationId?: string; timeZone?: string; token: string; version?: 1 | 2 },
  ): RealtimeConnection {
    const backend = this.backend();
    const agent = this.deps.getAgent();
    const key = backend ? this.deps.getApiKey(backend) : undefined;
    if (!backend || !key || !agent || !this.deps.isAuthorized(options.token, callerId))
      throw new Error("Realtime voice is unavailable");
    if (this.active.size >= 4) throw new Error("All realtime voice slots are busy");
    const diagnosticId = randomUUID();
    const openedAt = Date.now();
    let audioFrames = 0;
    let audioBytes = 0;
    let forwardedFrames = 0;
    let outputFrames = 0;
    let outputBytes = 0;
    let speechStarts = 0;
    let speechStops = 0;
    let clientDiagnostics = 0;
    let closeReason = "client_closed";
    let inputWatchdog: ReturnType<typeof setTimeout> | undefined;
    this.log.info(`Call ${diagnosticId} opening`);
    const abort = new AbortController();
    let closed = false;
    let ending = false;
    let sessionId: string | undefined;
    let agentSession: RealtimeAgentSession | undefined;
    let unsubscribe: (() => void) | undefined;
    let running = false;
    let ready = false;
    let closeAfterTurn = false;
    const pendingTranscripts: Array<{ text: string; id: string }> = [];
    const accountedResponses = new Set<string>();
    const upstream =
      this.deps.connect?.(key) ??
      new WebSocket(`wss://api.openai.com/v1/realtime?model=${MODEL}`, {
        headers: { Authorization: `Bearer ${key}` },
        maxPayload: MAX_UPSTREAM_EVENT_BYTES,
        handshakeTimeout: 15_000,
      });
    const send = (event: unknown) => {
      if (closed) return;
      if ((peer.bufferedAmount ?? 0) > MAX_BUFFERED_BYTES) {
        close();
        return;
      }
      try {
        peer.send(JSON.stringify(event));
      } catch {
        close();
      }
    };
    const sendUpstream = (event: unknown) => {
      if (closed || upstream.readyState !== WebSocket.OPEN) return false;
      if (upstream.bufferedAmount > MAX_BUFFERED_BYTES) {
        close();
        return false;
      }
      try {
        upstream.send(JSON.stringify(event));
        return true;
      } catch {
        close();
        return false;
      }
    };
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(lifetime);
      clearTimeout(startup);
      clearInterval(authorityCheck);
      clearTimeout(inputWatchdog);
      this.log.info(
        `Call ${diagnosticId} closed reason=${closeReason} durationMs=${Date.now() - openedAt} audioFrames=${audioFrames} audioBytes=${audioBytes} forwardedFrames=${forwardedFrames} speechStarts=${speechStarts} speechStops=${speechStops} outputFrames=${outputFrames} outputBytes=${outputBytes}`,
      );
      abort.abort();
      unsubscribe?.();
      void agentSession?.close();
      void backendAdapter.dispose();
      inputSequencer.dispose();
      upstream.close();
      this.active.delete(close);
      peer.close(1000, "Voice call ended");
    };
    const fail = () => {
      closeReason = "connection_error";
      send({ type: "error", error: { message: "The voice connection failed. Please try again." } });
      close();
    };
    const lifetime = setTimeout(close, MAX_CALL_MS);
    const startup = setTimeout(fail, 30_000);
    const authorized = () =>
      this.capability().available && this.deps.isAuthorized(options.token, callerId);
    const authorityCheck = setInterval(() => {
      if (!authorized()) close();
    }, 5_000);
    authorityCheck.unref();
    lifetime.unref();
    startup.unref();
    this.active.add(close);
    const backendAdapter = new RealtimeBackend(
      (event) => {
        if (!authorized()) {
          close();
          return;
        }
        sendUpstream(event);
      },
      authorized,
      fail,
    );
    const drainTranscripts = () => {
      if (closed || ending || running || !agentSession || pendingTranscripts.length === 0) return;
      if (!authorized()) {
        close();
        return;
      }
      const input = pendingTranscripts.shift()!;
      backendAdapter.useInputItem(input.id);
      running = true;
      void agentSession
        .run(input.text, backendAdapter, abort.signal)
        .catch(fail)
        .finally(() => {
          running = false;
          if (ending) return;
          if (closeAfterTurn) fail();
          else drainTranscripts();
        });
    };
    const inputSequencer = new RealtimeInputSequencer((text, id) => {
      if (pendingTranscripts.length >= 4) {
        fail();
        return;
      }
      pendingTranscripts.push({ text, id });
      drainTranscripts();
    }, fail);
    upstream.on("open", () => {
      this.log.info(`Call ${diagnosticId} upstream connected`);
      void (async () => {
        const opened = await agent.openRealtimeSession(callerId, {
          conversationId: options.conversationId,
          ...(options.version === 2 ? {} : { missingConversationPolicy: "create" as const }),
          timeZone: normalizeTimeZone(options.timeZone) ?? undefined,
        });
        if (closed) {
          void opened.close();
          return;
        }
        agentSession = opened;
        sessionId = opened.sessionId;
        // Compatibility for older iOS callers; canonical conversation state stays on ordinary SSE.
        unsubscribe = opened.subscribe((event) => {
          if (
            event.type === "agent.message.end" &&
            event.payload.failure?.code === "provider_error" &&
            event.payload.failure.provider?.code === "context_window_exceeded"
          )
            closeAfterTurn = true;
          if (options.version === 2) return;
          if (event.type === "agent.tool.start")
            send({
              type: "tool.start",
              id: event.payload.toolCallId,
              name: event.payload.tool,
              summary: event.payload.argsSummary ?? event.payload.intent,
            });
          if (event.type === "agent.tool.result")
            send({
              type: "tool.end",
              id: event.payload.toolCallId,
              result: event.payload.result,
            });
        });
        const configuration = backendAdapter.configuration(opened.context);
        this.log.info(
          `Call ${diagnosticId} context tools=${configuration.tools.length} instructionBytes=${Buffer.byteLength(configuration.instructions)} manifestBytes=${Buffer.byteLength(JSON.stringify(configuration.tools))}`,
        );
        sendUpstream({
          type: "session.update",
          session: {
            type: "realtime",
            output_modalities: ["audio"],
            ...configuration,
            audio: {
              input: {
                format: { type: "audio/pcm", rate: 24000 },
                transcription: { model: "gpt-4o-mini-transcribe" },
                turn_detection: {
                  type: "server_vad",
                  interrupt_response: true,
                  create_response: false,
                },
              },
              output: { format: { type: "audio/pcm", rate: 24000 }, voice: "marin" },
            },
            tool_choice: "auto",
          },
        });
      })().catch(fail);
    });
    upstream.on("message", (raw) => {
      if (closed || ending) return;
      try {
        if (!authorized()) {
          close();
          return;
        }
        if (Buffer.byteLength(raw.toString()) > MAX_UPSTREAM_EVENT_BYTES)
          throw new Error("Upstream voice event too large");
        const event = upstreamEvent.parse(JSON.parse(raw.toString()));
        if (event.type === "input_audio_buffer.speech_started") {
          backendAdapter.interrupt();
          if (running) agentSession?.cancel();
          speechStarts += 1;
          this.log.info(
            `Call ${diagnosticId} speech started count=${speechStarts} audioFrames=${audioFrames} audioBytes=${audioBytes}`,
          );
        }
        if (event.type === "input_audio_buffer.speech_stopped") {
          speechStops += 1;
          this.log.info(`Call ${diagnosticId} speech stopped count=${speechStops}`);
        }
        if (event.type === "response.output_audio.delta" && typeof event.delta === "string") {
          outputFrames += 1;
          outputBytes += Buffer.byteLength(event.delta, "base64");
          if (outputFrames === 1)
            this.log.info(`Call ${diagnosticId} first output audio bytes=${outputBytes}`);
        }
        if (event.type === "conversation.item.input_audio_transcription.completed") {
          const sample = transcriptionUsage.safeParse(event);
          if (sample.success && !accountedResponses.has(`transcript:${sample.data.item_id}`)) {
            accountedResponses.add(`transcript:${sample.data.item_id}`);
            try {
              this.deps.recordUsage?.(
                {
                  promptTokens: sample.data.usage.input_tokens,
                  completionTokens: sample.data.usage.output_tokens,
                },
                "gpt-4o-mini-transcribe",
              );
            } catch {
              /* Accounting must not interrupt the call. */
            }
          }
        }
        if (event.type === "response.done") {
          const usage = z
            .object({
              response: z.object({
                id: z.string(),
                usage: z
                  .object({
                    input_tokens: z.number().nonnegative(),
                    output_tokens: z.number().nonnegative(),
                    input_token_details: z
                      .object({ cached_tokens: z.number().nonnegative().optional() })
                      .optional(),
                  })
                  .nullable()
                  .optional(),
              }),
            })
            .safeParse(event);
          if (
            usage.success &&
            usage.data.response.usage &&
            !accountedResponses.has(usage.data.response.id)
          ) {
            accountedResponses.add(usage.data.response.id);
            const sample = usage.data.response.usage;
            try {
              this.deps.recordUsage?.(
                {
                  promptTokens: sample.input_tokens,
                  completionTokens: sample.output_tokens,
                  cacheReadTokens: sample.input_token_details?.cached_tokens,
                },
                MODEL,
              );
            } catch {
              // Accounting failure must not interrupt an otherwise valid voice call.
            }
          }
        }
        if (event.type === "input_audio_buffer.committed") {
          const input = z.object({ item_id: z.string().min(1).max(256) }).parse(event);
          inputSequencer.commit(input.item_id);
        }
        if (event.type === "conversation.item.input_audio_transcription.failed") {
          fail();
          return;
        }
        if (event.type === "conversation.item.input_audio_transcription.completed") {
          const input = z
            .object({
              item_id: z.string().min(1).max(256),
              transcript: z.string().trim().max(100_000),
            })
            .parse(event);
          inputSequencer.transcribe(input.item_id, input.transcript);
        }
        const accepted = backendAdapter.receive(event);
        if (event.type.startsWith("response.") && !accepted) return;
        if (event.type === "session.updated") {
          if (!agentSession) {
            fail();
            return;
          }
          if (ready) return;
          ready = true;
          clearTimeout(startup);
          this.log.info(`Call ${diagnosticId} session ready`);
          if (!inputWatchdog) {
            inputWatchdog = setTimeout(() => {
              if (!closed && audioFrames === 0)
                this.log.warn(`Call ${diagnosticId} no input audio received after 10 seconds`);
            }, 10_000);
            inputWatchdog.unref();
          }
          send({
            type: "session.ready",
            protocolVersion: options.version ?? 1,
            conversationId: sessionId,
            model: MODEL,
            clientAudioDiagnostics: true,
          });
        } else if (event.type === "error") {
          const error = z
            .object({
              error: z.object({
                code: z.string().optional(),
                param: z.string().nullable().optional(),
              }),
            })
            .safeParse(event);
          const code = error.success ? error.data.error.code : undefined;
          const safeCode = code && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : "unknown";
          this.log.warn(`Call ${diagnosticId} upstream error code=${safeCode}`);
          if (error.success && error.data.error.code === "response_cancel_not_active") return;
          if (error.success && error.data.error.param === "audio_end_ms") return;
          if (running) {
            closeAfterTurn = true;
            backendAdapter.fail(safeCode);
            return;
          }
          fail();
        } else if (
          [
            "input_audio_buffer.speech_started",
            "input_audio_buffer.speech_stopped",
            "response.output_audio.delta",
            "response.output_audio.done",
            "response.output_audio_transcript.delta",
            "response.output_audio_transcript.done",
            "conversation.item.input_audio_transcription.completed",
            "conversation.item.created",
            "response.created",
            "response.done",
          ].includes(event.type)
        )
          send(event);
      } catch {
        fail();
      }
    });
    upstream.on("error", fail);
    upstream.on("close", (code) => {
      this.log.info(`Call ${diagnosticId} upstream closed code=${code}`);
      if (!closed) closeReason = "upstream_closed";
      close();
    });
    return {
      close,
      receive: (raw) => {
        if (closed || ending) return;
        if (!authorized()) {
          close();
          return;
        }
        try {
          if (Buffer.byteLength(raw) > MAX_FRAME_BYTES) throw new Error("Voice frame too large");
          const event = clientEvent.parse(JSON.parse(raw));
          if (event.type === "session.end") {
            if (options.version !== 2 || !ready || !agentSession)
              throw new Error("Graceful voice end requires a ready version 2 session");
            ending = true;
            pendingTranscripts.length = 0;
            inputSequencer.dispose();
            abort.abort();
            void agentSession.close().then(() => {
              if (closed) return;
              send({ type: "session.ended", conversationId: sessionId });
              close();
            }, fail);
            return;
          }
          if (event.type === "client.audio_diagnostics") {
            if (clientDiagnostics < MAX_CLIENT_DIAGNOSTICS) {
              clientDiagnostics += 1;
              this.log.info(
                `Call ${diagnosticId} client audio stage=${event.stage} rawBuffers=${event.rawBuffers} pcmBuffers=${event.pcmBuffers} sentFrames=${event.sentFrames} engineRunning=${event.engineRunning}`,
              );
            }
            return;
          }
          if (event.type === "input_audio_buffer.append") {
            audioFrames += 1;
            audioBytes += Buffer.byteLength(event.audio, "base64");
            if (audioFrames === 1)
              this.log.info(
                `Call ${diagnosticId} first input audio bytes=${audioBytes} upstreamReady=${upstream.readyState === WebSocket.OPEN}`,
              );
          }
          if (sendUpstream(event) && event.type === "input_audio_buffer.append")
            forwardedFrames += 1;
        } catch {
          fail();
        }
      },
    };
  }

  dispose(): void {
    for (const close of this.active) close();
  }
}
