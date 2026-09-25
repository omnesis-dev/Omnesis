// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export { ApnsRelayCarrier, APNS_WAKE_BYTES, type ApnsRequest } from "./carriers/apns.js";
export { FcmRelayCarrier } from "./carriers/fcm.js";
export { runRelayAdminCommand, type RelayAdminIo } from "./admin.js";
export { APNS_WAKE_JSON, APNS_WAKE_PAYLOAD, FCM_WAKE_DATA, PUSH_WAKE } from "@omnesis/core/push";
export { loadRelayConfig, type RelayConfig } from "./config.js";
export {
  parseFcmServiceAccount,
  validateRelayCredentialFiles,
  type FcmServiceAccount,
} from "./credentials.js";
export { createRelayApp } from "./server.js";
export { RelayAbuseGuard, type RelayAbuseLimits } from "./abuse.js";
export {
  RelayService,
  RelayServiceError,
  RELAY_CHALLENGE_TTL_MS,
  RELAY_CREDENTIAL_PREFIX,
} from "./service.js";
export {
  RelayStore,
  digestSecret,
  RELAY_RATE_LIMIT_DAILY,
  RELAY_RATE_LIMIT_HOURLY,
} from "./store.js";
export { CarrierDispatchError } from "./types.js";
export type {
  CarrierCredentialPruneReason,
  CarrierDispatchErrorKind,
  CarrierHealth,
  Clock,
  RelayCarrier,
  RelayTarget,
} from "./types.js";
