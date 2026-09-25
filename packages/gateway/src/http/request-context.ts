// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { scopeSatisfies, type DeviceId, type Scope, type TokenId } from "@omnesis/types";
import { ForbiddenError } from "./errors.js";
import type { Context } from "hono";

export interface RequestAuth {
  deviceId: DeviceId | null;
  tokenId: TokenId | null;
  scopes: Scope[];
}

export class RequestContext {
  constructor(
    public readonly c: Context,
    public readonly auth: RequestAuth,
    public readonly requestId: string,
  ) {}

  requireScope(scope: Scope): void {
    if (!scopeSatisfies(this.auth.scopes, scope)) {
      throw new ForbiddenError(`Forbidden: ${scope} scope required`);
    }
  }

  requireAnyScope(scopes: readonly Scope[]): void {
    for (const s of scopes) {
      if (scopeSatisfies(this.auth.scopes, s)) return;
    }
    throw new ForbiddenError(`Forbidden: one of [${scopes.join(", ")}] scope required`);
  }
}

export function getRequestContext(c: Context): RequestContext {
  const ctx = c.get("ctx") as RequestContext | undefined;
  if (!ctx) {
    throw new Error("RequestContext missing — request-context middleware not installed");
  }
  return ctx;
}
