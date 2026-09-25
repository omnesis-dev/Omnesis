// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger, toErrorMessage } from "@omnesis/core";
import { SourceLifecycle } from "./source-lifecycle.js";
import type { GatewayClient } from "@omnesis/source-sdk";
import type { SourceRegistry } from "./source-registry.js";
import type { RegisteredSource } from "./sync-engine-types.js";

const log = createLogger("collector:sync");

/** Run one source operation with timeout, status fencing, and epoch revocation. */
export async function runWithSyncTimeout<T>(args: {
  source: RegisteredSource;
  registry: SourceRegistry;
  gateway: GatewayClient;
  timeoutMs: number;
  attemptId: string;
  isCurrent: () => boolean;
  finish: () => void;
  operation: (signal: AbortSignal, onEpochClaimed: (epoch: number) => void) => Promise<T>;
}): Promise<T> {
  const { source, registry, gateway, timeoutMs, attemptId, isCurrent, finish, operation } = args;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let claimedEpoch: number | undefined;
  const timeoutController = new AbortController();
  const markTimedOut = (error: unknown): void => {
    if (!isCurrent()) return;
    const status = registry.getStatus(source.id);
    if (!status || status.state !== "syncing") return;
    SourceLifecycle.toError(status, toErrorMessage(error), log);
    registry.emitStatusChange({
      event: "sync.error",
      sourceId: source.id,
      status: { ...status },
    });
    log.error(`Sync timeout for ${source.id}: ${toErrorMessage(error)}`);
  };
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(
        `Sync timed out after ${Math.round(timeoutMs / 60_000)}m for ${source.id} — provider may be stuck. Source flipped to error; next tick will retry.`,
      );
      timeoutController.abort(error);
      markTimedOut(error);
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      operation(timeoutController.signal, (epoch) => {
        claimedEpoch = epoch;
      }),
      timeout,
    ]);
  } catch (error) {
    markTimedOut(error);
    if (timeoutController.signal.aborted && isCurrent()) {
      try {
        if (gateway.revokeSyncAttempt) {
          await gateway.revokeSyncAttempt(source.id, claimedEpoch, attemptId);
        } else {
          await gateway.beginSyncAttempt?.(source.id);
        }
      } catch (revokeError) {
        log.warn(
          `Could not revoke timed-out sync authority for ${source.id}: ${toErrorMessage(revokeError)}`,
        );
      }
    }
    // Marking happens before revocation waits, and revocation is compare-and-
    // swap on the claimed epoch. A late result therefore cannot complete this
    // attempt or supersede a newer one.
    throw error;
  } finally {
    finish();
    if (timer !== undefined) clearTimeout(timer);
  }
}
