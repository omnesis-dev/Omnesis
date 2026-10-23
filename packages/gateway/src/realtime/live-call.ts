// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { cognitionSpendDay } from "../brain/storage/spend.js";
import {
  callError,
  RealtimeAdmissionError,
  transportCallError,
  type RealtimeCallError,
} from "./call-error.js";
import { LiveConversation, LIVE_INSTRUCTIONS, liveHistory } from "./live-conversation.js";
import {
  LIVE_MODEL,
  type LiveProvider,
  type LiveProviderEvent,
  type LiveProviderSession,
} from "./live-provider.js";
import type { VoiceAgentSession } from "../agent/voice-session.js";
import type { LiveVoiceUsageSample } from "./live-voice-usage.js";

export interface LiveOffer {
  sdp: string;
  clientSessionId: string;
  conversationId?: string;
  timeZone?: string;
}
export interface LiveAnswer {
  id: string;
  conversationId: string;
  model: string;
  backend: string;
  transport: { type: "webrtc"; sdp: string };
  voice: { model: string };
}
export interface LiveCallHost {
  openAgent(): Promise<VoiceAgentSession>;
  provider: LiveProvider;
  authorized(): boolean;
  authorityFailure?(): RealtimeCallError;
  recordUsage(usage: LiveVoiceUsageSample): Promise<void>;
  warn(code: string): void;
  retired(): void;
}
const secondsSchema = z.object({ usage: z.object({ seconds: z.number().finite().nonnegative() }) });
const CALL_LIMIT_MS = 30 * 60 * 1000;

/** One authenticated media lease. Agent work and its durable queue outlive media detachment. */
export class LiveCall {
  private phase: "connecting" | "connected" | "ending" | "ended" | "failed" = "connecting";
  private failure: RealtimeCallError | undefined;
  private replyFailure: RealtimeCallError | undefined;
  private agent: VoiceAgentSession | undefined;
  private conversation: LiveConversation | undefined;
  private provider: LiveProviderSession | undefined;
  private pendingProvider: Promise<LiveProviderSession> | undefined;
  private readonly abort = new AbortController();
  private ending: Promise<ReturnType<LiveCall["endResult"]>> | undefined;
  private seconds = 0;
  private confirmed = false;
  private recordedSeconds = 0;
  private recordedConfirmed = false;
  private hasRecorded = false;
  private readonly listeners = new Set<(status: ReturnType<LiveCall["status"]>) => void>();
  private readonly day = cognitionSpendDay(Date.now());
  private readonly setupTimer: ReturnType<typeof setTimeout>;
  private readonly lifetime: ReturnType<typeof setTimeout>;
  private readonly authority: ReturnType<typeof setInterval>;

  constructor(
    readonly id: string,
    private readonly host: LiveCallHost,
  ) {
    this.setupTimer = setTimeout(() => this.fail(callError("timeout")), 30_000);
    this.lifetime = setTimeout(() => this.fail(callError("call_limit_reached")), CALL_LIMIT_MS);
    this.authority = setInterval(() => {
      if (!this.host.authorized()) {
        void this.agent?.cancel().catch(() => this.host.warn("agent_cancel_failed"));
        this.fail(this.host.authorityFailure?.() ?? callError("pairing_rejected"));
      }
    }, 5000);
    this.setupTimer.unref();
    this.lifetime.unref();
    this.authority.unref();
  }

  get active(): boolean {
    return this.phase === "connecting" || this.phase === "connected" || this.phase === "ending";
  }

  status() {
    return {
      id: this.id,
      conversationId: this.agent?.sessionId ?? "",
      status: this.phase,
      ...(this.failure ? { failure: this.failure } : {}),
      ...(this.replyFailure ? { replyFailure: this.replyFailure } : {}),
      usage: { seconds: this.seconds, confirmed: this.confirmed },
    };
  }

  subscribe(listener: (status: ReturnType<LiveCall["status"]>) => void): () => void {
    if (this.listeners.size >= 4) throw new RealtimeAdmissionError(callError("session_busy"));
    this.listeners.add(listener);
    try {
      listener(this.status());
    } catch (error) {
      this.listeners.delete(listener);
      throw error;
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publish(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.status());
      } catch {
        this.listeners.delete(listener);
        this.host.warn("status_observer_failed");
      }
    }
  }

  async start(offer: LiveOffer, signal?: AbortSignal): Promise<LiveAnswer> {
    const aborted = () => this.fail(callError("connection_error"));
    signal?.addEventListener("abort", aborted, { once: true });
    try {
      if (signal?.aborted) throw new RealtimeAdmissionError(callError("connection_error"));
      this.agent = await this.host.openAgent();
      if (this.ending) {
        await this.agent.close();
        throw new RealtimeAdmissionError(this.failure ?? callError("connection_error"));
      }
      this.conversation = new LiveConversation({
        agent: this.agent,
        callId: this.id,
        authorized: () => this.requireAuthority(),
        send: (event) => {
          if (!this.requireAuthority()) return;
          if (!this.provider) throw new RealtimeAdmissionError(callError("connection_error"));
          this.provider.send(event);
        },
        fail: (error) => this.fail(error),
        replyFailure: (error) => {
          this.replyFailure = error;
          this.publish();
        },
      });
      this.pendingProvider = this.host.provider.create(
        {
          sdp: offer.sdp,
          instructions: LIVE_INSTRUCTIONS,
          input: liveHistory(this.agent.visibleHistory),
          signal: this.abort.signal,
        },
        {
          onEvent: (event) => this.receive(event),
          onFailure: (error) => this.fail(error),
        },
      );
      this.provider = await this.pendingProvider;
      if (this.ending) {
        await this.provider.close();
        throw new RealtimeAdmissionError(this.failure ?? callError("connection_error"));
      }
      return {
        id: this.id,
        conversationId: this.agent.sessionId,
        model: this.agent.model,
        backend: this.agent.backend,
        transport: { type: "webrtc", sdp: this.provider.sdp },
        voice: { model: LIVE_MODEL },
      };
    } catch (error) {
      const detail =
        error instanceof RealtimeAdmissionError
          ? error.detail
          : transportCallError("session_open_failed", error);
      this.failure ??= detail;
      await this.end();
      throw new RealtimeAdmissionError(this.failure);
    } finally {
      signal?.removeEventListener("abort", aborted);
    }
  }

  ready(): void {
    if (this.phase === "connected") return;
    if (this.phase !== "connecting" || !this.provider || !this.agent || !this.host.authorized())
      throw new RealtimeAdmissionError(this.failure ?? callError("session_not_found"));
    clearTimeout(this.setupTimer);
    this.phase = "connected";
    this.publish();
    this.conversation?.ready();
  }

  private receive(event: LiveProviderEvent): void {
    if (event.type === "session.usage.updated" || event.type === "session.closed") {
      const usage = secondsSchema.safeParse(event);
      if (usage.success) {
        this.seconds = Math.max(this.seconds, usage.data.usage.seconds);
        if (event.type === "session.closed") this.confirmed = true;
        this.persistUsage();
      }
    }
    if (event.type === "session.closed") {
      if (!this.ending) this.fail(callError("connection_error"));
      return;
    }
    if (!this.ending) this.conversation?.receive(event);
  }

  private requireAuthority(): boolean {
    if (this.host.authorized() && !this.ending) return true;
    if (!this.ending) {
      void this.agent?.cancel().catch(() => this.host.warn("agent_cancel_failed"));
      this.fail(this.host.authorityFailure?.() ?? callError("pairing_rejected"));
    }
    return false;
  }

  fail(detail: RealtimeCallError): void {
    if (this.phase === "ended" || this.phase === "failed") return;
    this.failure ??= detail;
    this.host.warn(detail.code);
    void this.end();
  }

  end(): Promise<ReturnType<LiveCall["endResult"]>> {
    if (this.ending) return this.ending;
    let resolve!: (result: ReturnType<LiveCall["endResult"]>) => void;
    this.ending = new Promise((done) => {
      resolve = done;
    });
    this.phase = "ending";
    clearTimeout(this.setupTimer);
    clearTimeout(this.lifetime);
    clearInterval(this.authority);
    this.conversation?.stop();
    this.abort.abort();
    this.publish();
    void this.finish().then(resolve, () => {
      this.failure ??= callError("session_end_failed");
      this.phase = "failed";
      resolve(this.endResult());
    });
    return this.ending;
  }

  private async finish() {
    try {
      // Release the canonical owner independently from provider/network and background accounting.
      await this.agent?.close();
      const provider = this.provider ?? (await this.pendingProvider?.catch(() => undefined));
      if (provider) {
        const result = await provider.close();
        if (result.seconds !== undefined) this.seconds = Math.max(this.seconds, result.seconds);
        this.confirmed ||= result.usageConfirmed;
        if (!result.usageConfirmed) this.failure ??= callError("session_end_failed");
      }
    } catch {
      this.failure ??= callError("session_end_failed");
    } finally {
      this.persistUsage(true);
      this.phase = this.failure ? "failed" : "ended";
      this.publish();
      this.host.retired();
    }
    return this.endResult();
  }

  private endResult() {
    return {
      ended: true as const,
      usageConfirmed: this.confirmed,
      ...(this.failure ? { failure: this.failure } : {}),
    };
  }

  private persistUsage(final = false): void {
    if (!final && !this.confirmed && this.seconds - this.recordedSeconds < 30) return;
    if (
      this.hasRecorded &&
      this.seconds === this.recordedSeconds &&
      this.confirmed === this.recordedConfirmed
    )
      return;
    this.hasRecorded = true;
    this.recordedSeconds = this.seconds;
    this.recordedConfirmed = this.confirmed;
    // Accounting owns no lease and must not make a caller wait for background writer admission.
    const sample: LiveVoiceUsageSample = {
      callId: this.id,
      model: LIVE_MODEL,
      day: this.day,
      seconds: this.seconds,
      confirmed: this.confirmed,
    };
    const record = async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await this.host.recordUsage(sample);
          return;
        } catch {
          // MAX upserts are idempotent; one bounded retry cannot double-charge a session.
          if (attempt === 1) {
            if (
              this.recordedSeconds === sample.seconds &&
              this.recordedConfirmed === sample.confirmed
            ) {
              this.hasRecorded = false;
              this.recordedSeconds = 0;
              this.recordedConfirmed = false;
            }
            this.host.warn("usage_recording_failed");
          }
        }
      }
    };
    void record();
  }
}
