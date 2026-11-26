// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export interface DesktopCollectorRestartResult {
  kind: "desktopCollectorRestart";
  status: "ready";
  deviceId: string;
  permissionRecheckRequired: true;
}
interface Child {
  exited: Promise<unknown>;
  collectorReady?: Promise<string>;
}
export interface CollectorIdentity {
  deviceId: string;
  fingerprint: string;
}

/** Only the supervisor loop mutates its owned child; control requests wake that loop. */
export class DesktopCollectorRestart {
  private wake = new AbortController();
  private current?: Child;
  private pending?: {
    identity: CollectorIdentity;
    lifetime: AbortController;
    resolve(value: DesktopCollectorRestartResult): void;
    reject(error: Error): void;
  };
  private starting = false;
  private strictPairing = false;
  private requesting = false;
  constructor(private readonly verify: () => Promise<CollectorIdentity>) {}

  get signal(): AbortSignal {
    return this.wake.signal;
  }
  get savedPairingOnly(): boolean {
    return this.strictPairing;
  }

  consume(): boolean {
    if (!this.wake.signal.aborted) return false;
    this.wake = new AbortController();
    this.starting = true;
    this.strictPairing = true;
    return true;
  }

  started(child: Child): void {
    this.current = child;
    void child.exited.then(
      () => {
        if (this.current === child) this.current = undefined;
      },
      () => {
        if (this.current === child) this.current = undefined;
      },
    );
    if (!this.starting) return;
    this.starting = false;
    const pending = this.pending;
    if (!pending) return;
    const failed = () => {
      throw new Error("The restarted collector did not become ready");
    };
    let onCancel!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onCancel = () => reject(new Error("Collector restart is no longer awaited"));
      pending.lifetime.signal.addEventListener("abort", onCancel, { once: true });
      if (pending.lifetime.signal.aborted) onCancel();
    });
    void Promise.race([
      cancelled,
      child.collectorReady ?? Promise.reject(new Error("Collector readiness is unavailable")),
      child.exited.then(failed, failed),
    ])
      .then(async (deviceId) => {
        const now = await this.verify();
        if (
          deviceId !== pending.identity.deviceId ||
          now.deviceId !== deviceId ||
          now.fingerprint !== pending.identity.fingerprint ||
          this.current !== child
        )
          throw new Error("The local collector identity changed during restart");
        if (this.pending === pending)
          pending.resolve({
            kind: "desktopCollectorRestart",
            status: "ready",
            deviceId,
            permissionRecheckRequired: true,
          });
      })
      .catch(() => {
        if (this.pending === pending)
          pending.reject(new Error("The local collector did not confirm a paired restart"));
      })
      .finally(() => pending.lifetime.signal.removeEventListener("abort", onCancel));
  }

  async request(signal: AbortSignal): Promise<DesktopCollectorRestartResult> {
    signal.throwIfAborted();
    if (this.requesting || this.starting || this.wake.signal.aborted || !this.current)
      throw new Error("An owned local collector must be running before it can restart");
    this.requesting = true;
    try {
      const identity = await this.verify();
      signal.throwIfAborted();
      if (!this.current) throw new Error("The local collector stopped before restart");
      return await new Promise<DesktopCollectorRestartResult>((resolve, reject) => {
        const aborted = () =>
          reject(new Error("Collector restart was interrupted; check collection again"));
        const finish =
          <T>(callback: (value: T) => void) =>
          (value: T) => {
            signal.removeEventListener("abort", aborted);
            callback(value);
          };
        this.pending = {
          identity,
          lifetime: new AbortController(),
          resolve: finish(resolve),
          reject: finish(reject),
        };
        signal.addEventListener("abort", aborted, { once: true });
        this.wake.abort();
      });
    } finally {
      this.pending?.lifetime.abort();
      this.pending = undefined;
      this.requesting = false;
    }
  }

  close(): void {
    this.pending?.reject(new Error("The owned desktop service stopped during collector restart"));
  }
}
