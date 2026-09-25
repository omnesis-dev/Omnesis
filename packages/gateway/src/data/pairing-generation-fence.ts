// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isTokenActive } from "./repositories/TokenRepository.js";
import type Database from "better-sqlite3";
import type { DeviceId, TokenId } from "@omnesis/types";

type Db = Database.Database;

export interface PairingGenerationFence {
  deviceId: DeviceId;
  tokenId: TokenId;
}

export const STALE_PAIRING_WRITE_ERROR = "OMNESIS_STALE_PAIRING_GENERATION";

/**
 * Run a mobile lifecycle mutation only while the credential generation that
 * authorized it is still active. The check and mutation share one immediate
 * writer transaction, so repair cannot rotate credentials between them.
 */
export function withPairingGenerationFence<T>(
  db: Db,
  fence: PairingGenerationFence | undefined,
  mutate: () => T,
): T {
  return db
    .transaction(() => {
      if (fence && !isTokenActive(db, fence.tokenId, fence.deviceId)) {
        throw new Error(STALE_PAIRING_WRITE_ERROR);
      }
      return mutate();
    })
    .immediate();
}

export function isStalePairingWriteError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (current.message.includes(STALE_PAIRING_WRITE_ERROR)) return true;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}
