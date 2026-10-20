// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { z } from "zod";
import { createLogger, experimentalEnabled, normalizeTimeZone } from "@omnesis/core";
import { AgentError, type AgentService, type CreateSessionOptions } from "../agent/service.js";
import type { AgentEvent } from "@omnesis/core";
import type { OmnesisConfig } from "@omnesis/config";

const MODEL = "gpt-realtime";
const MAX_FRAME_BYTES = 128 * 1024;
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const MAX_CALL_MS = 30 * 60 * 1000;
const clientEvent = z.discriminatedUnion("type", [
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
const functionCall = z.object({
  type: z.literal("response.function_call_arguments.done"),
  name: z.literal("ask_omnesis"),
  call_id: z.string().min(1).max(256),
  arguments: z.string().max(32_000),
});
const question = z.object({ question: z.string().trim().min(1).max(10_000) }).strict();
const responseUsage = z.object({
  response: z.object({
    id: z.string(),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative(),
        input_token_details: z
          .object({ cached_tokens: z.number().int().nonnegative().optional() })
          .optional(),
      })
      .nullable()
      .optional(),
  }),
});
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
    audio: { format: string; sampleRate: number };
  } {
    return {
      available: !!this.backend() && !!this.deps.getAgent(),
      model: MODEL,
      audio: { format: "pcm16", sampleRate: 24000 },
    };
  }

  private backend(): string | undefined {
    return realtimeBackend(this.deps.getConfig(), (name) => this.deps.getApiKey(name));
  }

  open(
    peer: RealtimePeer,
    callerId: string,
    options: { conversationId?: string; timeZone?: string; token: string },
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
    let closeReason = "client_closed";
    let inputWatchdog: ReturnType<typeof setTimeout> | undefined;
    this.log.info(`Call ${diagnosticId} opening`);
    const abort = new AbortController();
    let closed = false;
    let sessionId: string | undefined;
    let busy = false;
    let responseActive = false;
    let pendingResponse = false;
    const calls = new Set<string>();
    const accountedResponses = new Set<string>();
    const upstream =
      this.deps.connect?.(key) ??
      new WebSocket(`wss://api.openai.com/v1/realtime?model=${MODEL}`, {
        headers: { Authorization: `Bearer ${key}` },
        maxPayload: MAX_FRAME_BYTES,
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
    const emitTool = (event: AgentEvent) => {
      if (event.type === "agent.tool.start")
        send({
          type: "tool.start",
          id: event.payload.toolCallId,
          name: event.payload.tool,
          summary: event.payload.argsSummary ?? event.payload.intent,
        });
      if (event.type === "agent.tool.result")
        send({ type: "tool.end", id: event.payload.toolCallId, result: event.payload.result });
      if (event.type.startsWith("agent.tool.")) send({ type: "agent.event", event });
    };
    const requestResponse = () => {
      if (responseActive) {
        pendingResponse = true;
        return;
      }
      responseActive = true;
      sendUpstream({ type: "response.create" });
    };
    const delegate = async (raw: unknown) => {
      const call = functionCall.safeParse(raw);
      if (!call.success || closed) return;
      if (!authorized()) {
        close();
        return;
      }
      const { call_id: id } = call.data;
      if (calls.has(id)) return;
      if (calls.size >= 256) {
        fail();
        return;
      }
      calls.add(id);
      let result: string;
      if (busy || !sessionId) result = "Another request is still running. Wait for its answer.";
      else {
        busy = true;
        send({ type: "tool.start", id, name: "ask_omnesis", summary: "Asking Omnesis" });
        try {
          const args = question.parse(JSON.parse(call.data.arguments));
          result = await agent.realtimeTurn(
            callerId,
            sessionId,
            args.question,
            abort.signal,
            emitTool,
          );
        } catch {
          result = "Omnesis could not complete this request. Please try again.";
        } finally {
          busy = false;
        }
        send({ type: "tool.end", id, result: { kind: "text", text: result } });
      }
      if (closed) return;
      sendUpstream({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: id, output: result },
      });
      requestResponse();
    };
    upstream.on("open", () => {
      this.log.info(`Call ${diagnosticId} upstream connected`);
      void (async () => {
        const sessionOptions = {
          profile: "voice",
          caller: { kind: "operator" },
          ...(options.timeZone
            ? { timeZone: normalizeTimeZone(options.timeZone) ?? undefined }
            : {}),
        } satisfies CreateSessionOptions;
        let created: Awaited<ReturnType<AgentService["createSession"]>>;
        try {
          created = await agent.createSession(callerId, {
            ...sessionOptions,
            ...(options.conversationId ? { resumeFromId: options.conversationId } : {}),
          });
        } catch (error) {
          if (
            !options.conversationId ||
            !(error instanceof AgentError) ||
            error.code !== "session_not_found"
          )
            throw error;
          if (closed) return;
          this.log.info(`Call ${diagnosticId} starting fresh after missing conversation`);
          created = await agent.createSession(callerId, sessionOptions);
        }
        if (closed) return;
        sessionId = created.sessionId;
        sendUpstream({
          type: "session.update",
          session: {
            type: "realtime",
            output_modalities: ["audio"],
            instructions:
              "You are Omnesis, a warm and concise voice interface to the owner's personal agent. For every substantive user request, call ask_omnesis with their full request, preserving context and details. Never invent personal facts or claim to have performed an action yourself. Speak the agent's answer naturally and faithfully. Casual greetings and clarifying questions can be answered directly. If interrupted, listen and continue naturally. Do not read tool syntax aloud.",
            audio: {
              input: {
                format: { type: "audio/pcm", rate: 24000 },
                transcription: { model: "gpt-4o-mini-transcribe" },
                turn_detection: {
                  type: "server_vad",
                  interrupt_response: true,
                  create_response: true,
                },
              },
              output: { format: { type: "audio/pcm", rate: 24000 }, voice: "marin" },
            },
            tools: [
              {
                type: "function",
                name: "ask_omnesis",
                description:
                  "Ask the owner's Omnesis agent to answer or act using their personal data and full tools. Use for every substantive request.",
                parameters: {
                  type: "object",
                  properties: { question: { type: "string" } },
                  required: ["question"],
                  additionalProperties: false,
                },
              },
            ],
            tool_choice: "auto",
          },
        });
      })().catch(fail);
    });
    upstream.on("message", (raw) => {
      if (closed) return;
      try {
        const event = upstreamEvent.parse(JSON.parse(raw.toString()));
        if (event.type === "input_audio_buffer.speech_started") {
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
        if (event.type === "response.created") responseActive = true;
        if (event.type === "response.done") {
          responseActive = false;
          const sample = responseUsage.safeParse(event);
          if (
            sample.success &&
            sample.data.response.usage &&
            !accountedResponses.has(sample.data.response.id)
          ) {
            accountedResponses.add(sample.data.response.id);
            const usage = sample.data.response.usage;
            try {
              this.deps.recordUsage?.(
                {
                  promptTokens: usage.input_tokens,
                  completionTokens: usage.output_tokens,
                  cacheReadTokens: usage.input_token_details?.cached_tokens,
                },
                MODEL,
              );
            } catch {
              /* Accounting must not interrupt the call. */
            }
          }
          if (pendingResponse) {
            pendingResponse = false;
            requestResponse();
          }
        }
        if (event.type === "session.updated") {
          clearTimeout(startup);
          this.log.info(`Call ${diagnosticId} session ready`);
          if (!inputWatchdog) {
            inputWatchdog = setTimeout(() => {
              if (!closed && audioFrames === 0)
                this.log.warn(`Call ${diagnosticId} no input audio received after 10 seconds`);
            }, 10_000);
            inputWatchdog.unref();
          }
          send({ type: "session.ready", conversationId: sessionId, model: MODEL });
        } else if (event.type === "response.function_call_arguments.done")
          void delegate(event).catch(fail);
        else if (event.type === "error") {
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
          if (
            error.success &&
            ["conversation_already_has_active_response", "response_in_progress"].includes(
              error.data.error.code ?? "",
            )
          ) {
            responseActive = true;
            pendingResponse = true;
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
        if (closed) return;
        if (!authorized()) {
          close();
          return;
        }
        try {
          if (Buffer.byteLength(raw) > MAX_FRAME_BYTES) throw new Error("Voice frame too large");
          const event = clientEvent.parse(JSON.parse(raw));
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
