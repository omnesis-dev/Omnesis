// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The shared, environment-agnostic push pipeline for the browser-capture
 * source. No `chrome.*` dependency — transport (`fetch`) and durable storage
 * are injected — so the same code runs in the MV3 service worker and, byte for
 * byte, under Node in the spawned-gateway `browser-capture.e2e.test.ts`.
 */

export {
  PushClient,
  parseRetryAfter,
  clearPushServerState,
  clearPushObservability,
  clearPushHealth,
  clearPushQueue,
  clearPushDataLoss,
} from "./client.js";
export type {
  PushClientConfig,
  PushHealth,
  PushFailure,
  PushRetry,
  PushServerState,
  RecentDelivery,
  Connectivity,
  AuthProbeResult,
} from "./client.js";
export {
  PersistentQueue,
  QUEUE_STORAGE_KEY,
  QUEUE_CORRUPTION_KEY,
  QUEUE_OVERFLOW_KEY,
} from "./queue.js";
export type { QueueCorruption, QueueOverflow, QueueLimits } from "./queue.js";
export {
  buildWebPageDocument,
  buildPageVisit,
  WEB_PROVIDER_ID,
  WEB_SOURCE_ID,
  PAGE_VISITS_SCHEMA,
} from "./documents.js";
export type { WebPageCapture, PageVisitCapture, AnalyticsSchemaLiteral } from "./documents.js";
export {
  pair,
  normalizeGatewayUrl,
  isIpLiteral,
  readGatewayVersion,
  GatewayUrlError,
  PairingOutcomeUnknownError,
  minimumGatewayVersionFor,
} from "./pairing.js";
export type { PairResult } from "./pairing.js";
export { CapturePolicyClient, CapturePolicyError } from "./capture-policy.js";
export type { ExcludedDomainResult } from "./capture-policy.js";
export {
  DEFAULT_BACKOFF,
  type BackoffConfig,
  type DrainResult,
  type DurableStore,
  type FetchLike,
  type FetchLikeResponse,
  type PageVisit,
  type QueueItem,
  type DocumentQueueItem,
  type VisitQueueItem,
} from "./types.js";
