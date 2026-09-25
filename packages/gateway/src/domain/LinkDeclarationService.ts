// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  collectorDeclarationConnected,
  connectCollectorDeclarations,
  disconnectCollectorDeclarations,
} from "../collector-declaration-roster.js";
import type { WriteGate } from "../write-gate.js";

let updateQueue: Promise<void> = Promise.resolve();
let presenceQueue: Promise<void> = Promise.resolve();

/**
 * Publish a process-local URL declaration under a durable seqlock.
 *
 * Odd revisions mean an update is in progress, so background readers wait.
 * The final writer bump publishes an even revision after the in-memory value
 * is visible. The promise chain serializes concurrent collector POSTs.
 */
export function updateLinkDeclarations(writeGate: WriteGate, apply: () => void): Promise<void> {
  const update = updateQueue.then(async () => {
    await writeGate.beginLinkDeclarationUpdate();
    try {
      apply();
    } finally {
      await writeGate.finishLinkDeclarationUpdate();
    }
  });
  updateQueue = update.catch(() => undefined);
  return update;
}

/**
 * Publish a collector's first-connect/last-disconnect transition. Repeated
 * sockets for one device are no-ops, so ordinary reconnect fan-out never
 * adds avoidable work to the single writer.
 */
export function updateCollectorDeclarationPresence(
  writeGate: WriteGate,
  deviceId: string,
  connected: boolean,
): Promise<void> {
  const update = presenceQueue.then(async () => {
    if (collectorDeclarationConnected(deviceId) === connected) return;
    await updateLinkDeclarations(writeGate, () => {
      if (connected) connectCollectorDeclarations(deviceId);
      else disconnectCollectorDeclarations(deviceId);
    });
  });
  presenceQueue = update.catch(() => undefined);
  return update;
}
