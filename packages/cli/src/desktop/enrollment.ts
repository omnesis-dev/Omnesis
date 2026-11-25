// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { authorizeAccountDesktop, pairAccountDevice } from "@omnesis/cloud-relay";

export type DesktopEnrollmentRole = "interactive" | "collector";
type PairOptions = Parameters<typeof pairAccountDevice>[0];
export type DesktopGatewayChoice = Parameters<PairOptions["selectGateway"]>[0][number];
export type DesktopPairing = Awaited<ReturnType<typeof pairAccountDevice>>;
export type DesktopConnectCode = Parameters<NonNullable<PairOptions["onConnectCode"]>>[0];
export type DesktopCodeComparison = Parameters<PairOptions["confirm"]>[0];

export interface DesktopEnrollmentUI {
  openBrowser(url: string, signal: AbortSignal): Promise<void>;
  connectCode(value: DesktopConnectCode): void;
  chooseGateway(choices: readonly DesktopGatewayChoice[], signal: AbortSignal): Promise<string>;
  compareCode(value: DesktopCodeComparison, signal: AbortSignal): Promise<boolean>;
}

/** Safe to send to a native view; device credentials only appear in the returned pairing. */
export interface DesktopEnrollmentEvent {
  role: DesktopEnrollmentRole;
  phase:
    "signing-in" | "choosing" | "comparing" | "finishing" | "connected" | "cancelled" | "failed";
}

/**
 * Interactive and collection authority stay in distinct existing device grants. The caller
 * persists each returned role independently so a cancelled second enrollment can resume.
 */
export async function enrollDesktopRole(
  options: {
    role: DesktopEnrollmentRole;
    relayUrl: string;
    name: string;
    deviceKeyFile: string;
    deviceKeySecretOptions?: PairOptions["deviceKeySecretOptions"];
    signal: AbortSignal;
    ui: DesktopEnrollmentUI;
    onEvent(event: DesktopEnrollmentEvent): void;
  },
  dependencies: {
    pair?: typeof pairAccountDevice;
    authorize?: typeof authorizeAccountDesktop;
  } = {},
): Promise<DesktopPairing> {
  const { signal, ui } = options;
  const emit = (phase: DesktopEnrollmentEvent["phase"]) =>
    options.onEvent({ role: options.role, phase });
  try {
    signal.throwIfAborted();
    emit("signing-in");
    const pairing = await (dependencies.pair ?? pairAccountDevice)(
      {
        kind: options.role === "interactive" ? "cli" : "collector",
        relayUrl: options.relayUrl,
        name: options.name,
        deviceKeyFile: options.deviceKeyFile,
        deviceKeySecretOptions: options.deviceKeySecretOptions,
        signal,
        onConnectCode: (value) => {
          signal.throwIfAborted();
          ui.connectCode(value);
        },
        selectGateway: async (choices, operationSignal) => {
          operationSignal.throwIfAborted();
          emit("choosing");
          return whileCurrent(operationSignal, () => ui.chooseGateway(choices, operationSignal));
        },
        confirm: async (value, operationSignal) => {
          operationSignal.throwIfAborted();
          emit("comparing");
          const confirmed = await whileCurrent(operationSignal, () =>
            ui.compareCode(value, operationSignal),
          );
          if (confirmed) emit("finishing");
          return confirmed;
        },
      },
      {
        authorize: (authorization, authorizationDependencies) =>
          (dependencies.authorize ?? authorizeAccountDesktop)(authorization, {
            ...authorizationDependencies,
            openBrowser: async (url) => {
              await whileCurrent(authorization.signal, () =>
                ui.openBrowser(url, authorization.signal),
              );
            },
          }),
      },
    );
    signal.throwIfAborted();
    emit("connected");
    return pairing;
  } catch (error) {
    emit(signal.aborted ? "cancelled" : "failed");
    throw error;
  }
}

/** A dismissed or cancelled native prompt cannot finish an obsolete enrollment. */
async function whileCurrent<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let cancel!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    const result = await Promise.race([work(), cancelled]);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
