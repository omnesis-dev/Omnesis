// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Admission and audit around the fixed, read-only Direct MCP tool set. */

import { createLogger } from "@omnesis/core";

import { GatewayTimeoutError } from "../http/errors.js";
import { directMcpRateLimiter } from "../rate-limit.js";
import { tokenIdLogPrefix } from "../http/audit-format.js";
import type { DirectMcpService, DirectMcpToolName } from "../agent/direct-mcp.js";
import type { CorpusAuthorization } from "../access/corpus-authorization.js";

const DIRECT_MCP_MAX_IN_FLIGHT = 2;
const DIRECT_MCP_MAX_GLOBAL_IN_FLIGHT = 16;
const DEFAULT_DIRECT_MCP_INVOCATION_TIMEOUT_MS = 30_000;
const auditLog = createLogger("gateway:mcp-direct").child("audit");

export interface DirectMcpInvocationContext {
  clientIp: string;
  requestId: string;
  tokenId: string | null;
  deviceId: string | null;
  signal: AbortSignal;
  timeZone?: string;
  /** True when the route already charged the shared limiter before dispatch. */
  rateAlreadyCharged?: boolean;
  /** Server-derived corpus scope for an external OAuth principal. */
  authorization?: CorpusAuthorization;
  /** Stable per-credential admission identity; never derived from shared proxy egress. */
  admissionKey?: string;
}

export class DirectMcpRateLimitError extends Error {
  override readonly name = "DirectMcpRateLimitError";
}
export class DirectMcpBusyError extends Error {
  override readonly name = "DirectMcpBusyError";
}

/**
 * Admission boundary in front of every Direct tool invocation: rate,
 * concurrency, timeout and the egress audit line live here, behind the MCP
 * transport, so no caller can multiply its authority by reaching the service
 * another way.
 */
export class DirectMcpExecutionBoundary {
  private readonly limiter = directMcpRateLimiter();
  private readonly inFlight = new Map<string, number>();
  private globalInFlight = 0;
  private readonly invocationTimeoutMs: number;

  constructor(
    private readonly service: DirectMcpService,
    options: { invocationTimeoutMs?: number } = {},
  ) {
    this.invocationTimeoutMs =
      options.invocationTimeoutMs ?? DEFAULT_DIRECT_MCP_INVOCATION_TIMEOUT_MS;
  }

  manifest(authorization?: CorpusAuthorization) {
    return this.service.manifest(authorization);
  }

  instructions(authorization?: CorpusAuthorization): Promise<string> {
    return this.service.instructions(authorization);
  }

  charge(admissionKey: string): void {
    if (this.limiter.consume(admissionKey)) throw new DirectMcpRateLimitError();
  }

  async invoke(
    name: DirectMcpToolName,
    args: Readonly<Record<string, unknown>>,
    context: DirectMcpInvocationContext,
  ) {
    const admissionKey = context.admissionKey ?? context.tokenId ?? context.clientIp;
    if (!context.rateAlreadyCharged) this.charge(admissionKey);
    const active = this.inFlight.get(admissionKey) ?? 0;
    if (
      active >= DIRECT_MCP_MAX_IN_FLIGHT ||
      this.globalInFlight >= DIRECT_MCP_MAX_GLOBAL_IN_FLIGHT
    ) {
      throw new DirectMcpBusyError();
    }

    this.inFlight.set(admissionKey, active + 1);
    this.globalInFlight += 1;
    const startedAt = Date.now();
    const auditIdentity = `tok=${tokenIdLogPrefix(context.tokenId)} dev=${context.deviceId?.slice(0, 8) ?? "none"}`;
    try {
      const deadline = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new GatewayTimeoutError("Direct MCP tool invocation timed out."));
          deadline.abort();
        }, this.invocationTimeoutMs);
      });
      const signal = AbortSignal.any([context.signal, deadline.signal]);
      const invocation = this.service.invoke(name, args, {
        requestId: context.requestId,
        ...(context.timeZone ? { timeZone: context.timeZone } : {}),
        signal,
        ...(context.authorization ? { authorization: context.authorization } : {}),
      });
      // Hold the execution lease until the underlying work actually settles,
      // even if the transport deadline has already returned to the caller.
      void invocation.then(
        () => {
          this.release(admissionKey);
        },
        () => {
          this.release(admissionKey);
        },
      );
      let result;
      try {
        result = await Promise.race([invocation, timedOut]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
      const outcome = context.signal.aborted
        ? "cancelled"
        : result.kind === "error"
          ? "refused"
          : "ok";
      const reason = result.kind === "error" ? ` reason=${result.code}` : "";
      auditLog.info(
        `tool=${name} outcome=${outcome}${reason} bytes=${bytes} ${auditIdentity} in ${Date.now() - startedAt}ms [req=${context.requestId}]`,
      );
      return result;
    } catch (error) {
      const outcome =
        error instanceof GatewayTimeoutError
          ? "timed_out"
          : context.signal.aborted
            ? "cancelled"
            : "failed";
      auditLog.info(
        `tool=${name} outcome=${outcome} bytes=0 ${auditIdentity} in ${Date.now() - startedAt}ms [req=${context.requestId}]`,
      );
      throw error;
    }
  }

  private release(admissionKey: string): void {
    const remaining = (this.inFlight.get(admissionKey) ?? 1) - 1;
    if (remaining <= 0) this.inFlight.delete(admissionKey);
    else this.inFlight.set(admissionKey, remaining);
    this.globalInFlight = Math.max(0, this.globalInFlight - 1);
  }
}
