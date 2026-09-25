// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { PAGE_VISITS_SCHEMA, WEB_SOURCE_ID } from "./documents.js";
import { normalizeGatewayUrl } from "./pairing.js";
import {
  networkReason,
  parseSuccessfulDelivery,
  responseReason,
  type DeliveryOutcome,
} from "./delivery-response.js";
import { boundedRequest } from "./bounded-request.js";
import { boundedGatewayReason } from "./response-body.js";
import type { FetchLike, FetchLikeResponse, QueueItem } from "./types.js";

/** Bounded HTTP transport and response classification for the push facade. */
export class PushTransport {
  private readonly base: string;

  constructor(
    gatewayUrl: string,
    private readonly token: string,
    private readonly fetch: FetchLike,
    private readonly timeoutMs: number,
  ) {
    const normalized = normalizeGatewayUrl(gatewayUrl);
    if (normalized !== gatewayUrl) {
      throw new Error("Gateway URL must be its canonical HTTPS origin.");
    }
    this.base = normalized;
  }

  probeEmptyDocuments(): Promise<FetchLikeResponse> {
    return this.request(`${this.base}/documents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ documents: [] }),
      redirect: "error",
    });
  }

  /** Deliver one queue item and classify every transport/gateway outcome. */
  async deliver(item: QueueItem): Promise<DeliveryOutcome> {
    const { path, body } =
      item.kind === "document"
        ? { path: "/documents", body: { documents: [item.doc] } }
        : {
            path: "/analytics/ingest",
            body: {
              tableName: "page_visits",
              sourceId: WEB_SOURCE_ID,
              records: [item.visit],
              // Re-sending the schema is idempotent and creates the DuckDB
              // table on the first visit ingest.
              schema: PAGE_VISITS_SCHEMA,
            },
          };

    let response: FetchLikeResponse;
    try {
      response = await this.request(`${this.base}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(body),
        redirect: "error",
      });
    } catch (error) {
      return { kind: "retry", network: true, reason: networkReason(error) };
    }

    if (response.status >= 200 && response.status < 300) {
      return parseSuccessfulDelivery(
        response,
        item.kind,
        item.kind === "document" ? item.doc.externalId : undefined,
      );
    }
    if ([404, 405, 408, 409, 425, 429, 503].includes(response.status)) {
      return {
        kind: "retry",
        status: response.status,
        reason: await responseReason(response),
        retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
      };
    }
    if (response.status >= 500) {
      return {
        kind: "retry",
        status: response.status,
        reason: await responseReason(response),
      };
    }

    let reason = `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(await response.text()) as { error?: string };
      if (parsed?.error) reason = boundedGatewayReason(parsed.error);
    } catch {
      // Keep the status-line fallback for an empty or non-JSON error body.
    }
    return { kind: "drop", reason, status: response.status };
  }

  private request(input: string, init: Parameters<FetchLike>[1]): Promise<FetchLikeResponse> {
    return boundedRequest(this.fetch, input, init, this.timeoutMs);
  }
}

/** Parse either Retry-After delta-seconds or an HTTP date into milliseconds. */
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}
