// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isWebCapturePolicy, type WebCapturePolicy } from "@omnesis/provider-web/capture-policy";
import { boundedRequest } from "./bounded-request.js";
import { normalizeGatewayUrl } from "./pairing.js";
import { boundedGatewayReason } from "./response-body.js";
import type { FetchLike } from "./types.js";

/** A gateway verdict on a policy request, with the reason the gateway gave. */
export class CapturePolicyError extends Error {
  constructor(
    readonly status: number,
    reason: string,
  ) {
    super(reason);
    this.name = "CapturePolicyError";
  }
}

/** A domain exclusion as the gateway confirms it. */
export interface ExcludedDomainResult {
  policy: WebCapturePolicy;
  /** Pages already captured from the domain that were deleted for good. */
  purged: number;
}

/**
 * The browser's client for the gateway-owned capture policy. Every call
 * returns the whole policy the gateway now holds, so the caller replaces its
 * cache wholesale and two browsers editing at once converge on the same
 * settings. Environment-agnostic: transport is injected like the push client's.
 */
export class CapturePolicyClient {
  private readonly base: string;

  constructor(
    gatewayUrl: string,
    private readonly token: string,
    private readonly fetch: FetchLike,
    private readonly timeoutMs = 4_000,
  ) {
    this.base = normalizeGatewayUrl(gatewayUrl);
  }

  read(): Promise<WebCapturePolicy> {
    return this.policyRequest("GET", "/web-capture-policy");
  }

  async addExcludedDomain(domain: string, purge: boolean): Promise<ExcludedDomainResult> {
    const body = await this.jsonRequest("POST", "/web-capture-policy/excluded-domains", {
      domain,
      purge,
    });
    const result = body as { policy?: unknown; purged?: unknown };
    if (!isWebCapturePolicy(result.policy) || typeof result.purged !== "number") {
      throw new CapturePolicyError(200, "The gateway returned an unreadable capture policy");
    }
    return { policy: result.policy, purged: result.purged };
  }

  removeExcludedDomain(domain: string): Promise<WebCapturePolicy> {
    return this.policyRequest(
      "DELETE",
      `/web-capture-policy/excluded-domains/${encodeURIComponent(domain)}`,
    );
  }

  setPause(until: number | null): Promise<WebCapturePolicy> {
    return this.policyRequest("PUT", "/web-capture-policy/pause", { until });
  }

  clearPause(): Promise<WebCapturePolicy> {
    return this.policyRequest("DELETE", "/web-capture-policy/pause");
  }

  private async policyRequest(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<WebCapturePolicy> {
    const parsed = await this.jsonRequest(method, path, body);
    if (!isWebCapturePolicy(parsed)) {
      throw new CapturePolicyError(200, "The gateway returned an unreadable capture policy");
    }
    return parsed;
  }

  private async jsonRequest(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await boundedRequest(
      this.fetch,
      `${this.base}${path}`,
      {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? "" : JSON.stringify(body),
        redirect: "error",
      },
      this.timeoutMs,
    );
    const text = await response.text();
    if (response.status < 200 || response.status >= 300) {
      let reason = `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(text) as { error?: unknown };
        if (typeof parsed.error === "string" && parsed.error) {
          reason = boundedGatewayReason(parsed.error);
        }
      } catch {
        // Keep the status-line reason for an empty or non-JSON body.
      }
      throw new CapturePolicyError(response.status, reason);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new CapturePolicyError(
        response.status,
        "The gateway returned an unreadable capture policy",
      );
    }
  }
}
