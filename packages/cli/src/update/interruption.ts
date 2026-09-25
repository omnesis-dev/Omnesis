// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export type UpdateSignal = "SIGINT" | "SIGTERM";

export type UpdateInterruptionHandler = (signal: UpdateSignal) => void;

export interface UpdateSignalSource {
  on(signal: UpdateSignal, handler: () => void): unknown;
  off(signal: UpdateSignal, handler: () => void): unknown;
}

/**
 * Transfers signal ownership to the source apply transaction while it can
 * leave ignored dependencies or build output inconsistent with the checkout.
 * Outside that window the CLI keeps its normal signal exit semantics.
 */
export class UpdateInterruptionRouter {
  private handler: UpdateInterruptionHandler | null = null;

  constructor(private readonly exit: (code: number) => void = (code) => process.exit(code)) {}

  dispatch(signal: UpdateSignal): void {
    if (this.handler) {
      this.handler(signal);
      return;
    }
    this.exit(signal === "SIGINT" ? 130 : 143);
  }

  claim(handler: UpdateInterruptionHandler): () => void {
    if (this.handler) throw new Error("The update interruption handler is already claimed");
    this.handler = handler;
    return () => {
      if (this.handler === handler) this.handler = null;
    };
  }
}

export const updateInterruptionRouter = new UpdateInterruptionRouter();

/** Install the persistent OS routes an update needs, returning exact cleanup. */
export function installUpdateSignalHandlers(
  router: UpdateInterruptionRouter,
  source: UpdateSignalSource = process,
): () => void {
  const onSigint = (): void => router.dispatch("SIGINT");
  const onSigterm = (): void => router.dispatch("SIGTERM");
  source.on("SIGINT", onSigint);
  source.on("SIGTERM", onSigterm);
  return () => {
    source.off("SIGINT", onSigint);
    source.off("SIGTERM", onSigterm);
  };
}
