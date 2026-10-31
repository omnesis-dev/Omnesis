// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomUUID } from "node:crypto";
import { callError, RealtimeAdmissionError } from "./call-error.js";
import { LiveCall, type LiveOffer, type LiveAnswer } from "./live-call.js";
import { OpenAILiveProvider, LIVE_MODEL, type LiveProvider } from "./live-provider.js";
import { observeLiveProvider, type ModelCallHealth } from "./model-health.js";
import type { AgentService } from "../agent/service.js";
import type { LiveVoiceUsageSample } from "./live-voice-usage.js";

interface LiveServiceDeps {
  backend(): string | undefined;
  getApiKey(backend: string): string | undefined;
  getAgent(): Pick<AgentService, "openVoiceSession"> | undefined;
  isAuthorized(token: string, callerId: string): boolean;
  hasCapacity(): boolean;
  recordUsage?(sample: LiveVoiceUsageSample): Promise<void>;
  provider?(key: string): LiveProvider;
  beginModelCall?(): ModelCallHealth;
  warn(code: string): void;
}
interface Entry {
  owner: string;
  token: string;
  request: string;
  fingerprint: string;
  call: LiveCall;
  answer?: Promise<LiveAnswer>;
  expiry?: ReturnType<typeof setTimeout>;
}

/** Authenticated media registry. Canonical work, tools and history remain in AgentService. */
export class LiveVoiceService {
  private readonly calls = new Map<string, Entry>();
  private readonly requests = new Map<string, Entry>();
  private closing = false;
  private disposal?: Promise<void>;

  constructor(private readonly deps: LiveServiceDeps) {}

  capability() {
    const agent = this.deps.getAgent();
    if (
      !this.deps.backend() ||
      !agent ||
      typeof agent.openVoiceSession !== "function" ||
      this.closing
    )
      return undefined;
    return {
      version: 1 as const,
      protocol: { min: 1 as const, max: 1 as const },
      transport: "webrtc" as const,
      model: LIVE_MODEL,
      configuredAgent: true as const,
    };
  }

  get activeCount(): number {
    return [...this.calls.values()].filter((entry) => entry.call.active).length;
  }

  create(
    owner: string,
    token: string,
    offer: LiveOffer,
    signal?: AbortSignal,
  ): Promise<LiveAnswer> {
    if (this.closing) throw new RealtimeAdmissionError(callError("server_shutdown"));
    this.authorize(owner, token);
    const request = `${owner}:${offer.clientSessionId}`;
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          sdp: offer.sdp,
          conversationId: offer.conversationId,
          timeZone: offer.timeZone,
        }),
      )
      .digest("hex");
    const prior = this.requests.get(request);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new RealtimeAdmissionError(callError("session_busy"));
      if (!prior.call.active || prior.call.status().status === "ending" || !prior.answer)
        throw new RealtimeAdmissionError(callError("session_not_found"));
      return prior.answer;
    }
    const backend = this.deps.backend();
    const key = backend ? this.deps.getApiKey(backend) : undefined;
    const agent = this.deps.getAgent();
    if (this.closing || !backend || !key || !agent)
      throw new RealtimeAdmissionError(callError("unavailable"));
    if (!this.deps.hasCapacity() || this.calls.size >= 256)
      throw new RealtimeAdmissionError(callError("session_busy"));
    const authorized = () =>
      this.deps.backend() === backend &&
      this.deps.getApiKey(backend) === key &&
      this.deps.getAgent() === agent &&
      this.deps.isAuthorized(token, owner);
    const id = randomUUID();
    const call = new LiveCall(id, {
      openAgent: () =>
        agent.openVoiceSession(owner, {
          conversationId: offer.conversationId,
          timeZone: offer.timeZone,
          authorized,
        }),
      provider: observeLiveProvider(
        this.deps.provider?.(key) ?? new OpenAILiveProvider({ apiKey: key }),
        this.deps.beginModelCall,
        authorized,
      ),
      authorized,
      authorityFailure: () =>
        callError(this.deps.isAuthorized(token, owner) ? "unavailable" : "pairing_rejected"),
      recordUsage: (usage) => this.deps.recordUsage?.(usage) ?? Promise.resolve(),
      warn: (code) => this.deps.warn(code),
      retired: () => {
        const entry = this.calls.get(id);
        if (!entry) return;
        // Keep safe terminal status briefly so a lost media connection can retrieve its cause.
        entry.expiry = setTimeout(() => {
          this.calls.delete(id);
          if (this.requests.get(request) === entry) this.requests.delete(request);
        }, 120_000);
        entry.expiry.unref();
      },
    });
    // Install identity before starting asynchronous admission; concurrent retries share one request.
    const entry: Entry = { owner, token, request, fingerprint, call };
    this.calls.set(id, entry);
    this.requests.set(request, entry);
    entry.answer = call.start(offer, signal);
    return entry.answer;
  }

  status(owner: string, token: string, id: string) {
    return this.own(owner, token, id).call.status();
  }

  ready(owner: string, token: string, id: string): void {
    this.own(owner, token, id).call.ready();
  }

  subscribe(
    owner: string,
    token: string,
    id: string,
    listener: Parameters<LiveCall["subscribe"]>[0],
  ) {
    return this.own(owner, token, id).call.subscribe(listener);
  }

  end(owner: string, token: string, id: string) {
    return this.own(owner, token, id).call.end();
  }

  private authorize(owner: string, token: string): void {
    if (!this.deps.isAuthorized(token, owner))
      throw new RealtimeAdmissionError(callError("pairing_rejected"));
  }

  private own(owner: string, token: string, id: string): Entry {
    this.authorize(owner, token);
    const entry = this.calls.get(id);
    if (!entry || entry.owner !== owner || entry.token !== token)
      throw new RealtimeAdmissionError(callError("session_not_found"));
    return entry;
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closing = true;
    let resolve!: () => void;
    this.disposal = new Promise<void>((done) => {
      resolve = done;
    });
    const drains = [...this.calls.values()].map((entry) => {
      const phase = entry.call.status().status;
      if (phase === "connecting" || phase === "connected")
        entry.call.fail(callError("server_shutdown"));
      return entry.call.end();
    });
    void Promise.allSettled(drains).then(() => {
      for (const entry of this.calls.values()) clearTimeout(entry.expiry);
      this.calls.clear();
      this.requests.clear();
      // Submitted writes remain owned by WriteGate's normal shutdown drain.
      resolve();
    });
    return this.disposal;
  }
}
