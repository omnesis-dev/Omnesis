// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Ws from "ws";
import { z } from "zod";
import { SPEECH_TO_SPEECH_MODEL } from "@omnesis/core";
import {
  callError,
  providerCallError,
  RealtimeAdmissionError,
  type RealtimeCallError,
} from "./call-error.js";
import { readHandshakeError } from "./handshake-error.js";

export const LIVE_MODEL = SPEECH_TO_SPEECH_MODEL;
const API = "https://api.openai.com/v1/live/sessions";
const MAX_SDP = 64 * 1024;
const MAX_BODY = 128 * 1024;
const DEADLINE_MS = 15_000;
const eventSchema = z.object({ type: z.string().max(128) }).passthrough();
const answerSchema = z.object({
  session: z.object({ id: z.string().min(1).max(512) }),
  transport: z.object({ type: z.literal("webrtc"), sdp: z.string().min(1).max(MAX_SDP) }),
});
const inputSchema = z
  .array(
    z.object({
      role: z.enum(["user", "assistant"]),
      content: z
        .array(z.object({ type: z.literal("input_text"), text: z.string().max(64 * 1024) }))
        .length(1),
    }),
  )
  .max(128);

export type LiveTextMessage = z.infer<typeof inputSchema>[number];
export type LiveProviderEvent = z.infer<typeof eventSchema>;
export type LiveProviderCommand =
  | {
      type: "session.thinking.append" | "session.commentary.append" | "session.instructions.append";
      event_id: string;
      delegation_id: string | null;
      content: string;
    }
  | { type: "session.close"; event_id?: string };
export interface LiveProviderSession {
  /** Provider identity omitted from gateway signaling responses. */
  readonly id: string;
  readonly sdp: string;
  send(event: LiveProviderCommand): void;
  close(): Promise<{ usageConfirmed: boolean; seconds?: number }>;
}
export interface LiveProviderCallbacks {
  onEvent(event: LiveProviderEvent): void;
  onFailure(error: RealtimeCallError): void;
}
export interface LiveProvider {
  create(
    input: { sdp: string; instructions: string; input?: LiveTextMessage[]; signal?: AbortSignal },
    callbacks: LiveProviderCallbacks,
  ): Promise<LiveProviderSession>;
}
export interface OpenAILiveProviderOptions {
  apiKey: string;
  fetch?: typeof fetch;
  connect?: (url: string, options: Ws.ClientOptions) => Ws;
  timeoutMs?: number;
}

/** Bounded JSON reads cover success and rejection; provider prose is never used as an error. */
async function jsonBody(response: Response): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_BODY) throw new RealtimeAdmissionError(callError("protocol_error"));
      chunks.push(next.value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new RealtimeAdmissionError(callError("protocol_error"));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function httpFailure(status: number, body: unknown): RealtimeCallError {
  if (status === 401 || status === 403) return callError("authentication_failed");
  if (status === 404) return callError("model_unavailable");
  if (status >= 500) return callError("provider_error");
  const detail = providerCallError(body);
  return detail.code !== "provider_error"
    ? detail
    : callError(status === 429 ? "rate_limited" : "provider_error");
}
function safeFailure(error: unknown, signal?: AbortSignal): RealtimeCallError {
  if (error instanceof RealtimeAdmissionError) return error.detail;
  return callError(signal?.aborted ? "timeout" : "connection_error");
}

/** Owns only the provider transport. The gateway owns conversation state, authority and agent work. */
export class OpenAILiveProvider implements LiveProvider {
  private readonly request: typeof fetch;
  private readonly connect: NonNullable<OpenAILiveProviderOptions["connect"]>;
  private readonly timeout: number;
  constructor(private readonly options: OpenAILiveProviderOptions) {
    this.request = options.fetch ?? fetch;
    this.connect = options.connect ?? ((url, opts) => new Ws(url, opts));
    this.timeout = options.timeoutMs ?? DEADLINE_MS;
  }

  async create(
    input: Parameters<LiveProvider["create"]>[0],
    callbacks: LiveProviderCallbacks,
  ): Promise<LiveProviderSession> {
    const valid = z
      .object({
        sdp: z.string().min(1).max(MAX_SDP),
        instructions: z.string().max(64 * 1024),
        input: inputSchema.optional(),
      })
      .safeParse(input);
    if (
      !valid.success ||
      Buffer.byteLength(JSON.stringify(valid.data)) > MAX_BODY ||
      (valid.success &&
        (valid.data.input ?? []).reduce(
          (bytes, message) => bytes + Buffer.byteLength(message.content[0]!.text),
          0,
        ) > 8192)
    )
      throw new RealtimeAdmissionError(callError("protocol_error"));
    const timeout = AbortSignal.timeout(this.timeout);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    let id: string | undefined;
    try {
      const response = await this.request(API, {
        method: "POST",
        signal,
        redirect: "error",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session: {
            model: LIVE_MODEL,
            store: false,
            instructions: valid.data.instructions,
            input: (valid.data.input ?? []).map((message) => ({
              type: "message",
              role: message.role,
              content: [
                {
                  type: message.role === "assistant" ? "output_text" : "input_text",
                  text: message.content[0]!.text,
                },
              ],
            })),
            delegation: { type: "client" },
            audio: { output: { voice: "marin" } },
            client: {
              data_channel: {
                allowed_client_events: [],
                allowed_server_events: [
                  "session.started",
                  "session.closed",
                  "session.input_transcript.delta",
                  "session.output_transcript.delta",
                ].map((type) => ({ type })),
              },
            },
          },
          transport: { type: "webrtc", sdp: valid.data.sdp },
        }),
      });
      const body = await jsonBody(response).catch((error) => {
        if (!response.ok) return null;
        throw error;
      });
      if (!response.ok) throw new RealtimeAdmissionError(httpFailure(response.status, body));
      // Retain a valid identity even when the remaining answer is malformed, so cleanup can run.
      const identity = z
        .object({ session: z.object({ id: z.string().min(1).max(512) }) })
        .safeParse(body);
      if (identity.success) id = identity.data.session.id;
      const answer = answerSchema.safeParse(body);
      if (!answer.success) throw new RealtimeAdmissionError(callError("protocol_error"));
      signal.throwIfAborted();
      return await this.attach(answer.data, callbacks, signal);
    } catch (error) {
      if (id) await this.hangup(id).catch(() => {});
      throw new RealtimeAdmissionError(safeFailure(error, signal));
    }
  }

  /** Documented session hangup endpoint; independent timeout also covers an aborted caller. */
  private async hangup(id: string, timeout = this.timeout): Promise<void> {
    const response = await this.request(`${API}/${encodeURIComponent(id)}/hangup`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
      headers: { Authorization: `Bearer ${this.options.apiKey}` },
    });
    await response.body?.cancel().catch(() => {});
    if (!response.ok) throw new RealtimeAdmissionError(httpFailure(response.status, null));
  }

  private attach(
    answer: z.infer<typeof answerSchema>,
    callbacks: LiveProviderCallbacks,
    signal: AbortSignal,
  ): Promise<LiveProviderSession> {
    return new Promise((resolve, reject) => {
      const socket = this.connect(
        `wss://api.openai.com/v1/live/sessions/${encodeURIComponent(answer.session.id)}/attach`,
        {
          headers: { Authorization: `Bearer ${this.options.apiKey}` },
          maxPayload: MAX_BODY,
          handshakeTimeout: this.timeout,
        },
      );
      let opened = false;
      let ended = false;
      let closed = false;
      let failing = false;
      let rejectingHandshake = false;
      let closeTask: Promise<{ usageConfirmed: boolean; seconds?: number }> | undefined;
      let finalSeconds: number | undefined;
      let finalized: (() => void) | undefined;
      const report = (detail: RealtimeCallError) => {
        if (failing || closed) return;
        failing = true;
        if (!opened) reject(new RealtimeAdmissionError(detail));
        else callbacks.onFailure(detail);
        socket.terminate();
      };
      const aborted = () => report(callError("timeout"));
      signal.addEventListener("abort", aborted, { once: true });
      const send = (event: LiveProviderCommand) => {
        if (closed || ended || socket.readyState !== Ws.OPEN)
          throw new RealtimeAdmissionError(callError("connection_error"));
        if (
          event.type !== "session.close" &&
          (!event.event_id ||
            (event.delegation_id !== null && !event.delegation_id) ||
            Buffer.byteLength(event.content) > 500)
        )
          throw new RealtimeAdmissionError(callError("protocol_error"));
        if (socket.bufferedAmount > 2 * 1024 * 1024) {
          report(callError("connection_error"));
          throw new RealtimeAdmissionError(callError("connection_error"));
        }
        socket.send(JSON.stringify(event));
      };
      const close = () =>
        (closeTask ??= (async () => {
          if (ended) {
            closed = true;
            socket.close();
            return { usageConfirmed: finalSeconds !== undefined, seconds: finalSeconds };
          }
          try {
            await new Promise<void>((done, fail) => {
              const timer = setTimeout(
                () => fail(new RealtimeAdmissionError(callError("session_end_failed"))),
                Math.max(1, this.timeout - Math.max(1, Math.floor(this.timeout / 3))),
              );
              finalized = () => {
                clearTimeout(timer);
                done();
              };
              try {
                send({ type: "session.close" });
              } catch (error) {
                clearTimeout(timer);
                fail(error);
              }
            });
          } catch {
            // The REST endpoint is documented for SIP. It is a best-effort orphan fallback,
            // never evidence of finalized WebRTC usage.
            await this.hangup(answer.session.id, Math.max(1, Math.floor(this.timeout / 3))).catch(
              () => {},
            );
          } finally {
            closed = true;
            socket.terminate();
          }
          return { usageConfirmed: ended && finalSeconds !== undefined, seconds: finalSeconds };
        })());
      socket.on("message", (bytes) => {
        let event: LiveProviderEvent;
        try {
          event = eventSchema.parse(JSON.parse(bytes.toString()));
        } catch {
          report(callError("protocol_error"));
          return;
        }
        if (closed || failing) return;
        // Reflected ambient audio is not needed by the gateway; do not retain or project it.
        if (
          event.type === "session.input_audio.append" ||
          event.type === "session.output_audio.delta"
        )
          return;
        if (event.type === "session.closed") {
          const usage = z
            .object({ usage: z.object({ seconds: z.number().finite().nonnegative() }) })
            .safeParse(event);
          finalSeconds = usage.success ? usage.data.usage.seconds : undefined;
          ended = true;
          finalized?.();
        }
        if (event.type === "error") {
          report(providerCallError(event));
          return;
        }
        callbacks.onEvent(event);
        if (ended) socket.close();
      });
      socket.on("unexpected-response", (_request, response) => {
        rejectingHandshake = true;
        void readHandshakeError(response, signal).then(report);
      });
      socket.on("error", () => {
        if (!rejectingHandshake) report(callError("connection_error"));
      });
      socket.on("close", () => {
        if (!ended && !rejectingHandshake) report(callError("connection_error"));
      });
      socket.once("open", () => {
        if (signal.aborted || failing) {
          aborted();
          return;
        }
        opened = true;
        signal.removeEventListener("abort", aborted);
        resolve({ id: answer.session.id, sdp: answer.transport.sdp, send, close });
      });
      if (signal.aborted) aborted();
    });
  }
}
