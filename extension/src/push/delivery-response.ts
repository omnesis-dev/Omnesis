// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { boundedGatewayReason } from "./response-body.js";
import type { PushServerState } from "./observability.js";
import type { FetchLikeResponse, QueueItem } from "./types.js";

export type DeliveryOutcome =
  | { kind: "ok" }
  | {
      kind: "retry";
      retryAfterMs?: number;
      network?: boolean;
      reason?: string;
      status?: number;
    }
  | { kind: "drop"; reason: string; status: number }
  | { kind: "rejected"; state: PushServerState["state"]; reason: string }
  /** The gateway refused this page because the user deleted it for good. */
  | { kind: "suppressed" };

export function networkReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 120);
}

export async function responseReason(response: FetchLikeResponse): Promise<string> {
  try {
    const parsed = JSON.parse(await response.text()) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error) return boundedGatewayReason(parsed.error);
  } catch {
    // Keep the status-line fallback for empty or non-JSON bodies.
  }
  return `HTTP ${response.status}`;
}

/**
 * Validate the exact success contract before a queued upload is removed.
 * `externalId` is the document's id, so a page the gateway names as
 * suppressed — deleted for good by the user — is recognised as such rather than
 * counted as synced.
 */
export async function parseSuccessfulDelivery(
  response: FetchLikeResponse,
  kind: QueueItem["kind"],
  externalId?: string,
): Promise<DeliveryOutcome> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text()) as unknown;
  } catch {
    return invalidSuccess(response.status);
  }
  if (typeof parsed !== "object" || parsed === null) return invalidSuccess(response.status);
  const body = parsed as {
    ingested?: unknown;
    deleted?: unknown;
    rejected?: unknown;
    suppressed?: unknown;
  };
  if (body.rejected !== undefined) {
    if (!Array.isArray(body.rejected) || body.rejected.length === 0) {
      return invalidSuccess(response.status);
    }
    // The verdict is read from the first entry and applied to the whole
    // request: the extension delivers one queue item per request, so there is
    // exactly one document (and one source) a rejection can be about.
    const first = body.rejected[0] as { reason?: unknown };
    if (first?.reason === "paused" || first?.reason === "removed") {
      return { kind: "rejected", state: first.reason, reason: first.reason };
    }
    // The gateway may learn new rejection reasons before this extension does
    // (HTTP changes within a minor are additive). An unknown reason is still a
    // definitive verdict on this one item: drop it and surface the reason,
    // rather than retrying it every few minutes forever.
    if (typeof first?.reason === "string" && first.reason) {
      return {
        kind: "drop",
        reason: boundedGatewayReason(`Rejected by the gateway: ${first.reason}`),
        status: response.status,
      };
    }
    return invalidSuccess(response.status);
  }
  const ingestedOk = isFiniteNonNegativeInteger(body.ingested);
  const deletedOk = kind === "document" || isFiniteNonNegativeInteger(body.deleted);
  if (!ingestedOk || !deletedOk) return invalidSuccess(response.status);
  if (
    externalId !== undefined &&
    Array.isArray(body.suppressed) &&
    body.suppressed.includes(externalId)
  ) {
    return { kind: "suppressed" };
  }
  return { kind: "ok" };
}

/** The empty auth probe must acknowledge exactly zero ingested documents. */
export async function parseEmptyDocumentProbe(response: FetchLikeResponse): Promise<boolean> {
  try {
    const parsed = JSON.parse(await response.text()) as unknown;
    if (typeof parsed !== "object" || parsed === null) return false;
    const body = parsed as { ingested?: unknown; rejected?: unknown };
    return body.ingested === 0 && body.rejected === undefined;
  } catch {
    return false;
  }
}

function invalidSuccess(status: number): DeliveryOutcome {
  return { kind: "retry", status, reason: "Invalid gateway success response" };
}

function isFiniteNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0
  );
}
