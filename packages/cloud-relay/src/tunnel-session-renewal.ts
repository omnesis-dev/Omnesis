// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

const MAX_TIMER_MS = 2_147_483_647;
const RENEWAL_LEAD_MS = 60_000;
const ACK_TIMEOUT_MS = 10_000;
const RETRY_MS = 1000;

interface RenewalOptions {
  expiresAt: number;
  session: string;
  acquire(controller: AbortController): Promise<string>;
  joined(): Promise<void>;
  invalidate(): void;
  send(session: string): void;
  adopt(session: string): void;
  observe(error: unknown): void;
  terminate(): void;
}

/** One proof exchange at a time; the accepted deadline remains binding until an acknowledgement. */
export class TunnelSessionRenewal {
  private expiresAt: number;
  private session: string;
  private closed = false;
  private acquiring = false;
  private pendingSession: string | undefined;
  private abort: AbortController | undefined;
  private renewalTimer: ReturnType<typeof setTimeout> | undefined;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private ackTimer: ReturnType<typeof setTimeout> | undefined;
  private operation: Promise<void> = Promise.resolve();

  constructor(private readonly options: RenewalOptions) {
    this.expiresAt = options.expiresAt;
    this.session = options.session;
    this.armExpiry();
    this.schedule();
  }

  /** Only an outstanding exchange can install a fresh token for subsequent data channels. */
  accept(expiresAt: number): boolean {
    if (
      this.closed ||
      !this.pendingSession ||
      !Number.isSafeInteger(expiresAt) ||
      !Number.isSafeInteger(expiresAt * 1000) ||
      expiresAt <= this.expiresAt ||
      Date.now() >= this.expiresAt * 1000
    )
      return false;
    const session = this.pendingSession;
    this.pendingSession = undefined;
    this.session = session;
    clearTimeout(this.ackTimer);
    this.expiresAt = expiresAt;
    this.options.adopt(session);
    this.armExpiry();
    this.schedule();
    return true;
  }

  private armExpiry(): void {
    clearTimeout(this.expiryTimer);
    this.expiryTimer = setTimeout(
      () => {
        if (Date.now() < this.expiresAt * 1000) this.armExpiry();
        else this.fail();
      },
      Math.min(MAX_TIMER_MS, Math.max(0, this.expiresAt * 1000 - Date.now())),
    );
  }

  private schedule(at?: number): void {
    if (this.closed) return;
    clearTimeout(this.renewalTimer);
    const remaining = this.expiresAt * 1000 - Date.now();
    const due = at ?? this.expiresAt * 1000 - Math.min(RENEWAL_LEAD_MS, remaining / 3);
    this.renewalTimer = setTimeout(
      () => {
        if (Date.now() < due) this.schedule(due);
        else this.attempt();
      },
      Math.min(MAX_TIMER_MS, Math.max(0, due - Date.now())),
    );
  }

  private attempt(): void {
    if (this.closed || this.acquiring || this.pendingSession) return;
    this.acquiring = true;
    const controller = new AbortController();
    this.abort = controller;
    this.operation = this.exchange(controller);
    // close() retains the result; this observer prevents an unhandled rejection meanwhile.
    void this.operation.catch(() => this.fail());
  }

  private async exchange(controller: AbortController): Promise<void> {
    try {
      this.options.invalidate();
      const session = await this.options.acquire(controller);
      if (this.closed) return;
      if (Date.now() >= this.expiresAt * 1000) {
        this.fail();
        return;
      }
      if (session === this.session) {
        // Cached and externally supplied sources can keep returning the accepted
        // credential. Wait for a fresh one without replaying it or changing expiry.
        await this.options.joined();
        if (!this.closed) this.schedule(Math.min(Date.now() + RETRY_MS, this.expiresAt * 1000));
        return;
      }
      this.pendingSession = session;
      // Arm before sending: even an immediate acknowledgement cancels its own timer.
      this.ackTimer = setTimeout(
        () => this.fail(),
        Math.min(ACK_TIMEOUT_MS, this.expiresAt * 1000 - Date.now()),
      );
      this.options.send(session);
    } catch (error) {
      this.options.observe(error);
      this.pendingSession = undefined;
      clearTimeout(this.ackTimer);
      // An aborted caller is not proof that its underlying credential work has joined.
      await this.options.joined();
      if (!this.closed) this.schedule(Math.min(Date.now() + RETRY_MS, this.expiresAt * 1000));
    } finally {
      this.acquiring = false;
      this.abort = undefined;
    }
  }

  private fail(): void {
    if (this.closed) return;
    this.stop();
    this.options.terminate();
  }

  stop(): void {
    this.closed = true;
    clearTimeout(this.renewalTimer);
    clearTimeout(this.expiryTimer);
    clearTimeout(this.ackTimer);
    this.pendingSession = undefined;
    this.abort?.abort();
  }

  async close(): Promise<void> {
    this.stop();
    await this.operation;
  }
}
