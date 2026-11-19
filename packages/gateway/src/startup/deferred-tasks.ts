// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

interface StopHandle {
  stop(): void;
}

interface Registration {
  register: () => StopHandle;
  registered: boolean;
  cancelled: boolean;
  stopped: boolean;
  handle?: StopHandle;
}

/** A one-time dependency barrier for registering background jobs. The regular
 * Scheduler owns their execution; this only delays registration until repairs
 * finish and lets shutdown cancel work before that barrier is released. */
export class DeferredStartupTasks {
  private state: "pending" | "active" | "stopped" = "pending";
  private readonly registrations: Registration[] = [];

  defer(register: () => StopHandle): StopHandle {
    if (this.state === "stopped") return { stop() {} };
    const registration: Registration = {
      register,
      registered: false,
      cancelled: false,
      stopped: false,
    };
    this.registrations.push(registration);
    if (this.state === "active") this.activate(registration);
    return {
      stop: () => {
        registration.cancelled = true;
        this.stopRegistration(registration);
      },
    };
  }

  start(): void {
    if (this.state !== "pending") return;
    // Set state before invoking user callbacks: a callback may call start,
    // defer or stop on this group, or cancel its own previously returned handle.
    this.state = "active";
    for (const registration of this.registrations) this.activate(registration);
  }

  stop(): void {
    if (this.state === "stopped") return;
    this.state = "stopped";
    const errors: unknown[] = [];
    for (const registration of this.registrations) {
      registration.cancelled = true;
      try {
        this.stopRegistration(registration);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Deferred startup task cleanup failed");
  }

  private activate(registration: Registration): void {
    if (this.isStopped() || registration.cancelled || registration.registered) return;
    registration.registered = true;
    try {
      registration.handle = registration.register();
      // Cancellation may have happened inside register(), before its handle
      // existed. The new resource still belongs to the cancelled registration.
      if (this.isStopped() || registration.cancelled) this.stopRegistration(registration);
    } catch (error) {
      try {
        this.stop();
      } catch {
        // Stop attempts every handle; retain the original registration failure.
      }
      throw error;
    }
  }

  private stopRegistration(registration: Registration): void {
    if (!registration.handle || registration.stopped) return;
    registration.stopped = true;
    registration.handle.stop();
  }

  private isStopped(): boolean {
    return this.state === "stopped";
  }
}
