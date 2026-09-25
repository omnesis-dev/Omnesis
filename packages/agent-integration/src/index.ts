// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export {
  AgentIntegrationClient,
  defaultIntegrationCapability,
  newDeliveryCommandId,
  type AgentIntegrationClientOptions,
  type IntegrationConnectionState,
  type WebSocketFactory,
} from "./client.js";
export {
  integrationCredentialsSchema,
  loadIntegrationCredentials,
  subscriptionsAvailable,
  updateIntegrationCapabilities,
  loadOperationalIntegrationCredentials,
  hasIntegrationOAuth,
  upgradeLegacyIntegrationCredentials,
  writeIntegrationCredentials,
  type IntegrationCredentials,
  type LegacyIntegrationCredentials,
  type OperationalIntegrationCredentials,
} from "./credentials.js";
export { parseGatewayCapabilities, type GatewayCapabilities } from "./gateway-capabilities.js";
export { harnessClientName, type IntegrationHarness } from "./harness.js";
export {
  IntegrationOAuthProvider,
  SerializedIntegrationAuthProvider,
  authorizeIntegrationOAuth,
  authorizeIntegrationOAuthWithCredentialLock,
} from "./oauth.js";
export { agentIntegrationVersion, describeVersionDrift } from "./version.js";
export { capDeviceUpdateDetail, summarizeCommandFailure } from "./command-output.js";
export { integrationOAuthFetch } from "./native-answer-mcp.js";
export {
  AmbiguousDeliveryError,
  DeliveryConflictError,
  DeliveryAuthorityExpiredError,
  DeliveryCancelledError,
  DeliveryNotPreparedError,
  DurableIntegrationInbox,
  WorkflowBindingConflictError,
  type DeliveryStarter,
  type AnswerCompletionStarter,
  type DeliveryStartContext,
  type InboxState,
  type NativeRunIdentity,
  type WorkflowBinding,
} from "./inbox.js";
export {
  DurableTranscriptIngestor,
  type AgentConversationMessage,
  type DurableTranscriptIngestorOptions,
  type TranscriptPage,
  type TranscriptSink,
  type TranscriptSource,
} from "./ingestion.js";
export {
  describeAnswerOutcome,
  firingAnswerRequestId,
  integrationAnswerConversationHandle,
  integrationAnswerRequestId,
  requestFiringAnswer,
  requestIntegrationAnswer,
  AnswerPendingError,
  ANSWER_DEADLINE_MS,
  ANSWER_POLL_TIMEOUT_MS,
  ANSWER_SUBMIT_TIMEOUT_MS,
  type AnswerPoster,
  type AnswerWaitOptions,
  type FiringAnswerRequest,
  type IntegrationAnswerRequest,
} from "./answer-wait.js";
export {
  DEFAULT_GATEWAY_TIMEOUT_MS,
  GatewayRequestTimeoutError,
  IntegrationHttpError,
  PinnedGatewayHttpClient,
  type GatewayRequestOptions,
} from "./http.js";
export {
  AGENT_INTEGRATION_PROTOCOL_MIN_VERSION,
  AGENT_INTEGRATION_PROTOCOL_VERSION,
  answerCompletionDeliveryHash,
  answerCompletionDeliverySchema,
  answerCompletionCancelCommandSchema,
  answerCompletionCommitCommandSchema,
  answerCompletionPrepareCommandSchema,
  agentIntegrationCapabilitySchema,
  deliveryAcceptanceSchema,
  deliveryCancellationSchema,
  deliveryPreparationSchema,
  deliveryPayloadHash,
  subscriptionCancelCommandSchema,
  subscriptionCommitCommandSchema,
  subscriptionDeliverySchema,
  subscriptionPrepareCommandSchema,
  type AgentIntegrationCapability,
  type AnswerCompletionDelivery,
  type DeliveryAcceptance,
  type DeliveryCancellation,
  type DeliveryPreparation,
  type SubscriptionDelivery,
} from "./protocol.js";
export {
  certificateFingerprint,
  normalizeFingerprint,
  pinnedTlsOptions,
  TlsPinError,
  tlsTrustSchema,
  validateGatewayUrl,
  verifyPeerFingerprint,
  websocketUrl,
  type TlsTrust,
} from "./tls.js";
