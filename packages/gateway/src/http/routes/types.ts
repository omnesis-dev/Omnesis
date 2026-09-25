// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Hono } from "hono";
import type { DeviceId, Scope, TokenId } from "@omnesis/types";
import type { RequestContext } from "../request-context.js";
import type { WsUpgradeAuth } from "../../ws.js";
import type { AccessGrantCapability } from "../../access/types.js";

interface AuthContextBase {
  deviceId: DeviceId | null;
  tokenId: TokenId | null;
  scopes: Scope[];
}

export interface BearerAuthContext extends AuthContextBase {
  authMethod: "bearer";
}

export interface PortalSessionAuthContext extends AuthContextBase {
  authMethod: "portal-session";
  deviceId: null;
  /**
   * The device whose token the session was opened with. A session speaks for
   * no device, but it asks `/answer` with that device's credential, so the
   * device's access level governs those answers exactly as it governs the
   * token itself.
   */
  credentialDeviceId: DeviceId | null;
  /** Synchronizer token derived from the opaque session id. */
  csrfToken: string;
}

export interface PrincipalOAuthAuthContext extends AuthContextBase {
  authMethod: "principal-oauth";
  deviceId: null;
  tokenId: null;
  accessTokenId: string;
  principalId: string;
  principalName: string;
  grantId: string;
  grantRevision: number;
  credentialId: string;
  oauthClientId: string;
  executionDeviceId: string | null;
  capabilities: AccessGrantCapability[];
  expiresAt: number;
}

export type AuthContext = BearerAuthContext | PortalSessionAuthContext | PrincipalOAuthAuthContext;

export type AppEnv = {
  Variables: {
    auth: AuthContext;
    requestId: string;
    ctx: RequestContext;
    wsAuth: WsUpgradeAuth;
    wsClientIp: string;
  };
};

export type RouteApp = Hono<AppEnv>;
