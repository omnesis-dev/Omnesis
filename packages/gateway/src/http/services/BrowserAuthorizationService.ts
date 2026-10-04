// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { experimentalEnabled } from "@omnesis/core";
import { Scope, type DeviceId, type TokenId } from "@omnesis/types";
import { ForbiddenError, NotFoundError, HttpError } from "../errors.js";
import type { AuthContext } from "../routes/types.js";
import type { DeviceService } from "./DeviceService.js";
import type { WriteGate } from "../../write-gate.js";

const REQUEST_TTL_MS = 10 * 60_000;
const MAX_PENDING_REQUESTS = 256;
export interface BrowserAuthorizationCredential {
  token: string;
  tokenId: TokenId;
  scopes: string[];
  deviceId: DeviceId;
}
interface Authorization {
  requestId: string;
  deviceId: DeviceId;
  tokenId: TokenId;
  expiresAt: number;
  credential?: BrowserAuthorizationCredential;
  approving?: Promise<void>;
}

/** Owner-approved optional authority, bound to one browser capture credential. */
export class BrowserAuthorizationService {
  private readonly authorizations = new Map<string, Authorization>();
  constructor(
    private readonly deps: {
      devices: DeviceService;
      writeGate: Pick<WriteGate, "createToken" | "revokeToken">;
      now?: () => number;
      scope: string;
      label: string;
      feature: string;
    },
  ) {}
  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
  private requireExperimental(): void {
    if (!experimentalEnabled()) throw new NotFoundError("Browser feature unavailable");
  }
  browser(auth: AuthContext, required: string): { deviceId: DeviceId; tokenId: TokenId } {
    this.requireExperimental();
    if (
      auth.authMethod !== "bearer" ||
      !auth.deviceId ||
      !auth.tokenId ||
      !auth.scopes.includes(Scope(required))
    ) {
      throw new ForbiddenError(`Forbidden: browser ${required} credential required`);
    }
    const device = this.deps.devices.getById(auth.deviceId);
    if (
      !device ||
      device.kind !== "browser" ||
      device.revokedAt !== null ||
      !this.deps.devices.tokenIsActive(auth.tokenId, auth.deviceId)
    ) {
      throw new ForbiddenError("Forbidden: active browser device required");
    }
    return { deviceId: auth.deviceId, tokenId: auth.tokenId };
  }
  private active(request: Authorization): boolean {
    const device = this.deps.devices.getById(request.deviceId);
    return (
      !!device &&
      device.revokedAt === null &&
      this.deps.devices.tokenIsActive(request.tokenId, request.deviceId)
    );
  }
  private request(id: string): Authorization {
    this.requireExperimental();
    const request = this.authorizations.get(id);
    if (!request || request.expiresAt <= this.now()) {
      this.authorizations.delete(id);
      throw new NotFoundError(
        `Authorization expired; enable ${this.deps.feature === "browser-notes" ? "Tell Omnesis" : "Find"} again in the extension`,
      );
    }
    if (!this.active(request))
      throw new ForbiddenError("Browser authorization is no longer active");
    return request;
  }
  createAuthorization(auth: AuthContext, id: string) {
    const browser = this.browser(auth, "write:web");
    for (const [key, request] of this.authorizations)
      if (request.expiresAt <= this.now()) this.authorizations.delete(key);
    for (const [key, request] of this.authorizations) {
      if (
        request.tokenId === browser.tokenId &&
        request.credential &&
        !this.deps.devices
          .listTokens(request.deviceId)
          .some((token) => token.id === request.credential!.tokenId)
      )
        this.authorizations.delete(key);
    }
    const existing = this.authorizations.get(id);
    if (
      existing &&
      (existing.deviceId !== browser.deviceId || existing.tokenId !== browser.tokenId)
    )
      throw new NotFoundError("Authorization not found");
    if (!existing && this.authorizations.size >= MAX_PENDING_REQUESTS)
      throw new HttpError(429, "AUTHORIZATION_LIMIT", "Too many pending authorizations");
    // One outstanding request per credential prevents a paired client from filling the pending queue.
    const sameBrowser = [...this.authorizations.values()].find(
      (request) => request.tokenId === browser.tokenId,
    );
    const request = existing ??
      sameBrowser ?? { requestId: id, ...browser, expiresAt: this.now() + REQUEST_TTL_MS };
    this.authorizations.set(request.requestId, request);
    if (!existing && !sameBrowser) {
      const expiration = setTimeout(() => {
        if (this.authorizations.get(request.requestId) === request)
          this.authorizations.delete(request.requestId);
      }, REQUEST_TTL_MS);
      expiration.unref();
    }
    return {
      requestId: request.requestId,
      expiresAt: request.expiresAt,
      approvalPath: `/portal/${this.deps.feature}?request=${encodeURIComponent(request.requestId)}`,
    };
  }
  private requireUnrevokedCredential(request: Authorization): void {
    if (
      request.credential &&
      !this.deps.devices.tokenIsActive(request.credential.tokenId, request.deviceId)
    ) {
      throw new NotFoundError(
        `Permission was revoked; enable ${this.deps.label} again in the extension`,
      );
    }
  }
  authorization(id: string) {
    const request = this.request(id);
    this.requireUnrevokedCredential(request);
    return {
      requestId: id,
      deviceName: this.deps.devices.getById(request.deviceId)!.name,
      expiresAt: request.expiresAt,
      status: request.credential ? "approved" : "pending",
    };
  }
  async approve(id: string): Promise<void> {
    const request = this.request(id);
    if (request.credential) {
      this.requireUnrevokedCredential(request);
      return;
    }
    if (!request.approving) {
      request.approving = (async () => {
        const minted = await this.deps.writeGate.createToken(
          request.deviceId,
          [Scope(this.deps.scope)],
          this.deps.label,
        );
        const enabled = experimentalEnabled();
        if (!enabled || !this.active(request) || request.expiresAt <= this.now()) {
          await this.deps.writeGate.revokeToken(minted.id);
          if (!enabled) throw new NotFoundError("Browser feature unavailable");
          throw new ForbiddenError("Browser authorization is no longer active");
        }
        request.credential = {
          token: minted.token,
          tokenId: minted.id,
          scopes: [Scope(this.deps.scope)],
          deviceId: request.deviceId,
        };
      })();
    }
    try {
      await request.approving;
    } finally {
      request.approving = undefined;
    }
  }
  poll(auth: AuthContext, id: string) {
    const browser = this.browser(auth, "write:web");
    const request = this.request(id);
    if (request.deviceId !== browser.deviceId || request.tokenId !== browser.tokenId)
      throw new NotFoundError("Authorization not found");
    if (!request.credential) return { status: "pending" };
    if (
      !this.deps.devices
        .listTokens(request.deviceId)
        .some((token) => token.id === request.credential!.tokenId)
    )
      return { status: "revoked" };
    return { status: "approved", credential: request.credential };
  }
  status(auth: AuthContext) {
    this.browser(auth, this.deps.scope);
    return { enabled: true };
  }
}
