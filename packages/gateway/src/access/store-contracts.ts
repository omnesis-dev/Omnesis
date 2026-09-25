// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export type AccessMutationError =
  | "not-found"
  | "expired"
  | "already-decided"
  | "authorization-pending"
  | "invalid-selection"
  | "inactive-grant"
  | "stale-revision"
  | "level-name-taken"
  | "level-managed"
  | "level-in-use"
  | "device-not-integration"
  | "invalid-code"
  | "invalid-client"
  | "invalid-request"
  | "invalid-binding"
  | "invalid-redirect-uri"
  | "invalid-pkce"
  | "invalid-scope"
  | "invalid-resource"
  | "invalid-grant"
  | "invalid-secret";

export type AccessMutationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AccessMutationError };
