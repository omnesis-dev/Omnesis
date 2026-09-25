// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { hashText } from "../capture/content-hash.js";
import {
  CAPTURE_HANDOFF_OVERFLOW_KEY,
  CAPTURE_PENDING_PREFIX,
  isCaptureHandoffOverflow,
  isStoredCaptureHandoff,
  type CaptureHandoffOverflow,
  type StoredCaptureHandoff,
} from "./messages.js";
import type { CaptureEmission } from "../capture/lifecycle.js";
import type { ExtensionConfig } from "./storage.js";

/** Keep the short-lived tab-to-worker outbox bounded independently of the push queue. */
export const CAPTURE_HANDOFF_MAX_RECORDS = 20;

export interface HandoffStorage {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  getKeys(): Promise<string[]>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

/** Token-free identity binding: staged page bodies must never cross a pairing change. */
export function capturePairingId(
  config: Pick<ExtensionConfig, "gatewayUrl" | "deviceId">,
): Promise<string> {
  return hashText(`${config.gatewayUrl.replace(/\/+$/, "")}\0${config.deviceId}`);
}

/** A bounded, collision-resistant key for one exact emission. */
export async function captureHandoffKey(
  instanceId: string,
  emission: CaptureEmission,
  order: string,
): Promise<string> {
  const semanticId =
    emission.kind === "visit"
      ? `${emission.normalizedUrl}\0${emission.visitedAt}`
      : `${emission.normalizedUrl}\0${emission.contentHash}\0${emission.title}`;
  return `${CAPTURE_PENDING_PREFIX}${instanceId}.${emission.kind}.${await hashText(`${semanticId}\0${order}`)}`;
}

export async function pendingHandoffKeys(storage: HandoffStorage): Promise<string[]> {
  return (await storage.getKeys()).filter((key) => key.startsWith(CAPTURE_PENDING_PREFIX));
}

/** Persist one emission, then evict the oldest excess records from this small outbox. */
export async function persistCaptureHandoff(
  storage: HandoffStorage,
  key: string,
  record: StoredCaptureHandoff,
): Promise<void> {
  await storage.set({ [key]: JSON.stringify(record) });
  let keys = await pendingHandoffKeys(storage);
  let raw = await storage.get(keys);

  // Re-extracts are replaceable snapshots. Keep the greatest observation
  // order for one pairing+URL, regardless of asynchronous write completion,
  // and only remove older records after the newest record is durable.
  if (record.emission.kind === "re-extract") {
    const samePage = keys
      .map((candidate) => {
        try {
          const parsed = JSON.parse(String(raw[candidate])) as unknown;
          return isStoredCaptureHandoff(parsed) &&
            parsed.pairingId === record.pairingId &&
            parsed.emission.kind === "re-extract" &&
            parsed.emission.normalizedUrl === record.emission.normalizedUrl
            ? { key: candidate, order: parsed.order }
            : null;
        } catch {
          return null;
        }
      })
      .filter((candidate): candidate is { key: string; order: string } => candidate !== null);
    const newestOrder = samePage.reduce(
      (newest, candidate) => (candidate.order > newest ? candidate.order : newest),
      record.order,
    );
    const superseded = samePage
      .filter((candidate) => candidate.order < newestOrder)
      .map((candidate) => candidate.key);
    if (superseded.length > 0) await storage.remove(superseded);
    if (record.order < newestOrder) await storage.remove(key);
    keys = await pendingHandoffKeys(storage);
    raw = await storage.get(keys);
  }
  if (keys.length <= CAPTURE_HANDOFF_MAX_RECORDS) return;
  const ordered = keys
    .map((candidate) => {
      try {
        const parsed = JSON.parse(String(raw[candidate])) as unknown;
        return { key: candidate, at: isStoredCaptureHandoff(parsed) ? parsed.at : 0 };
      } catch {
        return { key: candidate, at: 0 };
      }
    })
    .sort((a, b) => a.at - b.at);
  const discard = ordered.slice(0, keys.length - CAPTURE_HANDOFF_MAX_RECORDS);
  if (discard.length === 0) return;
  await storage.remove(discard.map((entry) => entry.key));

  let previous = 0;
  const overflowRaw = await storage.get(CAPTURE_HANDOFF_OVERFLOW_KEY);
  try {
    const parsed = JSON.parse(String(overflowRaw[CAPTURE_HANDOFF_OVERFLOW_KEY])) as unknown;
    if (isCaptureHandoffOverflow(parsed)) previous = parsed.discarded;
  } catch {
    previous = 0;
  }
  await storage.set({
    [CAPTURE_HANDOFF_OVERFLOW_KEY]: JSON.stringify({
      at: Date.now(),
      discarded: previous + discard.length,
    } satisfies CaptureHandoffOverflow),
  });
}

/** Remove a write that completed after its content-script authorization changed. */
export async function persistCaptureHandoffGuarded(
  storage: HandoffStorage,
  key: string,
  record: StoredCaptureHandoff,
  stillAuthorized: () => boolean,
): Promise<void> {
  try {
    await persistCaptureHandoff(storage, key, record);
  } finally {
    if (!stillAuthorized()) await storage.remove(key);
  }
}

export async function readPendingHandoffs(
  storage: HandoffStorage,
): Promise<Array<{ key: string; record: StoredCaptureHandoff | null }>> {
  const keys = await pendingHandoffKeys(storage);
  if (keys.length === 0) return [];
  const raw = await storage.get(keys);
  return keys
    .map((key) => {
      try {
        const parsed = JSON.parse(String(raw[key])) as unknown;
        return { key, record: isStoredCaptureHandoff(parsed) ? parsed : null };
      } catch {
        return { key, record: null };
      }
    })
    .sort((a, b) => (a.record?.at ?? 0) - (b.record?.at ?? 0));
}

export async function clearPendingHandoffs(storage: HandoffStorage): Promise<void> {
  const keys = await pendingHandoffKeys(storage);
  if (keys.length > 0) await storage.remove(keys);
}
