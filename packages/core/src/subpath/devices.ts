// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `@omnesis/core/devices` — device + scope types (star-topology
 * architecture).
 *
 * Every gateway / collector / iOS path that reasons about devices,
 * tokens, or scopes consults this surface. Stable contract — wire
 * format, audit semantics, and the device-record shape all depend
 * on it.
 */

export {
  DeviceId,
  TokenId,
  tryDeviceId,
  tryTokenId,
  DEVICE_KINDS,
  isDeviceKind,
  Scope,
  tryScope,
  SCOPE_READ,
  SCOPE_ADMIN,
  SCOPE_PUSH_CLAIM,
  SCOPE_WRITE_ALL,
  writeScope,
  isValidScope,
  parseScope,
  classifyScope,
  scopeSatisfies,
  PUSH_TRANSPORTS,
  isPushTransport,
} from "../device.js";

export type {
  DeviceKind,
  ScopeClass,
  DeviceCapability,
  DeviceRecord,
  ApnsRegistration,
  FcmRegistration,
  PushTransport,
  TokenRecord,
} from "../device.js";
