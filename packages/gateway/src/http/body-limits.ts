// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { bodyLimit } from "hono/body-limit";

const MIB = 1024 * 1024;

/**
 * Ceilings for the two push-ingest routes every write token can reach.
 *
 * The largest single document any shipped client produces is a Drive or
 * OneDrive text export capped at 10 MiB ({@link LARGEST_DOCUMENT_BYTES}); the
 * collector splits batches by count and by serialized size so no request
 * approaches the ceiling, and the browser extension caps a page at 200k
 * characters. The limits exist so a hostile or broken client holding any
 * write token cannot make the gateway buffer an unbounded body.
 */
export const DOCUMENTS_BODY_LIMIT_BYTES = 64 * MIB;
export const ANALYTICS_INGEST_BODY_LIMIT_BYTES = 16 * MIB;
/** The largest `content` a shipped source emits for one document (Drive / OneDrive text exports). */
export const LARGEST_DOCUMENT_BYTES = 10 * MIB;

/** A body-size ceiling that answers 413 with the same JSON shape as other route errors. */
export function ingestBodyLimit(maxSize: number) {
  return bodyLimit({
    maxSize,
    onError: (c) =>
      c.json(
        {
          error: `Request body too large (max ${formatMiB(maxSize)})`,
          code: "PAYLOAD_TOO_LARGE",
        },
        413,
      ),
  });
}

function formatMiB(bytes: number): string {
  const mib = bytes / MIB;
  return `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB`;
}
