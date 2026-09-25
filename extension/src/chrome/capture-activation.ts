// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

interface CaptureActivationDeps {
  readAllowed: () => Promise<boolean>;
  start: () => void;
  stop: () => void;
  markInactive: () => void;
  setTimer?: (callback: () => void, delayMs: number) => number;
  clearTimer?: (handle: number) => void;
  retryBaseMs?: number;
  retryMaxMs?: number;
  isTerminalError?: (error: unknown) => boolean;
  onTerminalError?: (error: unknown) => void;
}

/** Orders asynchronous config/permission observations for one content script. */
export class CaptureActivation {
  #generation = 0;
  #active = false;
  #terminal = false;
  #retryTimer: number | null = null;
  #retryAttempt = 0;

  constructor(private readonly deps: CaptureActivationDeps) {}

  get active(): boolean {
    return this.#active;
  }

  async refresh(): Promise<void> {
    if (this.#terminal || this.#active) return;
    this.#cancelRetry();
    const generation = this.#generation;
    let allowed: boolean;
    try {
      allowed = await this.deps.readAllowed();
    } catch (error) {
      if (this.deps.isTerminalError?.(error)) {
        this.terminate();
        this.deps.onTerminalError?.(error);
        return;
      }
      if (!this.#terminal && !this.#active && generation === this.#generation) {
        this.#scheduleRetry(generation);
      }
      return;
    }
    if (this.#terminal || this.#active || generation !== this.#generation) return;
    if (!allowed) {
      this.#retryAttempt = 0;
      this.deps.markInactive();
      return;
    }
    this.#retryAttempt = 0;
    this.#active = true;
    this.deps.start();
  }

  /** Stop current capture but allow a later pairing to activate this tab. */
  deactivate(): void {
    if (this.#terminal) return;
    this.#generation += 1;
    this.#cancelRetry();
    this.#retryAttempt = 0;
    if (this.#active) this.deps.stop();
    this.#active = false;
    this.deps.markInactive();
  }

  /** Restart from a fresh authorization snapshot after config replacement. */
  async reconcile(): Promise<void> {
    this.deactivate();
    await this.refresh();
  }

  /** Permanently stop this injected instance after permission/context loss. */
  terminate(): void {
    if (this.#terminal) return;
    this.deactivate();
    this.#terminal = true;
  }

  #scheduleRetry(generation: number): void {
    if (this.#retryTimer !== null) return;
    const base = this.deps.retryBaseMs ?? 1_000;
    const maximum = this.deps.retryMaxMs ?? 30_000;
    const delay = Math.min(maximum, base * 2 ** Math.min(this.#retryAttempt, 10));
    this.#retryAttempt += 1;
    const setTimer = this.deps.setTimer ?? ((callback, ms) => window.setTimeout(callback, ms));
    this.#retryTimer = setTimer(() => {
      this.#retryTimer = null;
      if (!this.#terminal && generation === this.#generation) void this.refresh();
    }, delay);
  }

  #cancelRetry(): void {
    if (this.#retryTimer === null) return;
    const clearTimer = this.deps.clearTimer ?? ((handle) => window.clearTimeout(handle));
    clearTimer(this.#retryTimer);
    this.#retryTimer = null;
  }
}
