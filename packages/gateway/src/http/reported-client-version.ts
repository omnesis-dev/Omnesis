// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { DeviceId, DeviceKind } from "@omnesis/types";

/**
 * The query parameter an HTTP-only client puts its product version in.
 *
 * The browser extension never opens a device socket, so the version it paired
 * with would otherwise stand on its row through every Chrome update. It
 * carries its manifest version on the requests it already makes
 * (`POST /documents`, `POST /analytics/ingest`) as `?clientVersion=0.7.0`.
 *
 * A query parameter rather than a header or a body field: a custom header
 * from a `chrome-extension://` origin can need a CORS preflight that an
 * operator's `gateway.cors.allowedHeaders` does not list, and a body field
 * would tie the report to one route's schema. An older gateway ignores the
 * parameter, and an older extension that omits it simply leaves the reading
 * where it was.
 */
export const CLIENT_VERSION_PARAM = "clientVersion";

/** Longer than any product version; bounds what a request can make us parse. */
export const MAX_REPORTED_VERSION_CHARS = 64;

/** `MAJOR.MINOR.PATCH` with an optional pre-release or build suffix. */
const PRODUCT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][\w.-]+)?$/u;

/** The device kinds whose version arrives on HTTP requests rather than a hello. */
const HTTP_REPORTING_KINDS: ReadonlySet<DeviceKind> = new Set<DeviceKind>(["browser"]);

/**
 * A reported version, or null for anything that is not a product version. A
 * malformed value is ignored, never an error: it must not fail the request
 * that carried it.
 */
export function parseReportedClientVersion(raw: string | undefined): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_REPORTED_VERSION_CHARS) {
    return null;
  }
  return PRODUCT_VERSION.test(raw) ? raw : null;
}

/** How long one (device, version) write attempt suppresses another. */
const ATTEMPT_COOLDOWN_MS = 60_000;
/** Cap the attempt map so a long-running gateway cannot leak. */
const ATTEMPT_CAP = 500;

export interface ReportedVersionRecorderOpts {
  /** Write the version to the device's row; resolves once the writer has. */
  record(id: DeviceId, version: string): unknown;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface ReportedVersionRecorder {
  /**
   * Note the version one authenticated request reported for its own device.
   * `device` is the row the auth middleware already read for the request.
   */
  note(device: { id: DeviceId; kind: DeviceKind; version: string | null }, raw?: string): void;
}

/**
 * Turn per-request version reports into writer work only when the reading
 * changes. The row read on every authenticated request is the comparison, so
 * an unchanged version costs nothing; a changed one costs a single
 * background write, and the same (device, version) is not attempted again for
 * a minute however many requests carry it before the write lands — a page
 * push storm adds no writer load.
 */
export function createReportedVersionRecorder(
  opts: ReportedVersionRecorderOpts,
): ReportedVersionRecorder {
  const now = opts.now ?? Date.now;
  const attempts = new Map<DeviceId, { version: string; at: number }>();
  return {
    note(device, raw) {
      if (raw === undefined || !HTTP_REPORTING_KINDS.has(device.kind)) return;
      const version = parseReportedClientVersion(raw);
      if (version === null || version === device.version) return;
      const at = now();
      const last = attempts.get(device.id);
      if (last && last.version === version && at - last.at < ATTEMPT_COOLDOWN_MS) return;
      attempts.delete(device.id);
      attempts.set(device.id, { version, at });
      if (attempts.size > ATTEMPT_CAP) {
        // Evict the oldest insertion. Map iteration order is insertion order.
        const first = attempts.keys().next().value;
        if (first !== undefined) attempts.delete(first);
      }
      // The reading is informational: a failed write is retried by a later
      // request once the cooldown passes, and never surfaces to this one.
      void Promise.resolve()
        .then(() => opts.record(device.id, version))
        .catch(() => undefined);
    },
  };
}
