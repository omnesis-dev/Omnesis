// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Root barrel — kept for back-compat with consumers that already
// import from `@omnesis/core`. New code should prefer the named
// subpath exports (`@omnesis/core/protocol`, `/triggers`, `/config`,
// `/sources`, `/people`, `/models`, `/terminal`, `/devices`); they
// expose the same symbols with narrower per-domain surfaces. The
// subpaths land via `package.json#exports`. The multi-package split (real `@omnesis/protocol`,
// `@omnesis/config`, …) is the next increment after consumers
// migrate.
export {
  ProviderType,
  ProviderId,
  SourceType,
  SourceId,
  AccountId,
  tryProviderType,
  tryProviderId,
  trySourceType,
  trySourceId,
  tryAccountId,
  BrandedIdError,
  makeSourceId,
  makeProviderId,
  parseSourceId,
  parseProviderId,
} from "./ids.js";

export { NOTIFY_IOS_TITLE_MAX, NOTIFY_IOS_BODY_MAX } from "./notify.js";
export { runningSourceCommit, SOURCE_COMMIT_PATTERN } from "./source-build-identity.js";
export type { Page, PageInfo } from "./pagination.js";
export { buildPage, clampLimit } from "./pagination.js";

export {
  TEMPORAL_ORIGINS,
  TEMPORAL_KINDS,
  TEMPORAL_MODALITIES,
  TEMPORAL_STATUSES,
  TEMPORAL_PRECISIONS,
  RETIRED_TEMPORAL_KINDS,
  ACCEPTED_TEMPORAL_KINDS,
  isTemporalOrigin,
  isTemporalKind,
  isTemporalModality,
  isTemporalStatus,
  isTemporalPrecision,
  canonicalTemporalKind,
  temporalVocabularyCheck,
  canonicalInstant,
  toCanonicalInstant,
  toCanonicalWallClock,
  canonicalizeInterval,
  intervalOverlapsWindow,
  isCalendarDay,
  MAX_TIME_ZONE_SHIFT_MS,
} from "./temporal-vocabulary.js";

export type { CanonicalInterval, TemporalIntervalPrecision } from "./temporal-vocabulary.js";

export type {
  TemporalOrigin,
  TemporalKind,
  TemporalModality,
  TemporalStatus,
  TemporalPrecision,
  TemporalQueryInput,
  TemporalProjectionProvenance,
  TemporalAnnotationProvenance,
  TemporalItem,
  TemporalProjectionCoverage,
  TemporalSpecialistCoverage,
  TemporalCoverage,
  TemporalQueryResult,
} from "./temporal.js";

export type {
  Document,
  DocumentMetadata,
  DocumentInput,
  DocumentType,
  KnownDocumentType,
  PersonMention,
  PersonRole,
} from "./document.js";

export { KNOWN_DOCUMENT_TYPES, PERSON_ROLES } from "./document.js";

export type { Provider } from "./provider.js";

export type {
  SourceIcon,
  SourceAttribution,
  SyncCursor,
  SyncResult,
  SourceWatermark,
  SyncProgress,
  ImportField,
  HistoryImportSpec,
  ImportProgress,
  ImportCallbacks,
  ImportSummary,
} from "./source.js";

export type {
  ColumnDefinition,
  ColumnReference,
  ColumnType,
  AnalyticsTableSchema,
  BoundDocumentSpec,
  RecordDisplaySpec,
  RecordKeyField,
  RecordCitationFields,
  AnalyticsTemporalProjectionSpec,
  DocumentTemporalProjectionSpec,
  TemporalProjectionSpec,
  DocumentProjectionField,
  MappedProjectionField,
  StructuredSyncResult,
  AnalyticsCatalogEntry,
} from "./structured-source.js";

export {
  normalizeAnalyticsColumnType,
  normalizeAnalyticsSchemaColumnTypes,
  validateAnalyticsSchemaColumnTypes,
  validateAnalyticsDeleteKeys,
  validateAnalyticsSchemasHavePrimaryKey,
  validateBoundDocuments,
  validateRecordCitationContract,
  validateTemporalProjectionContracts,
  validateDocumentTemporalProjectionContracts,
  deriveRecordTitle,
  deriveRecordCitationFields,
  REDACTED_VALUE,
} from "./structured-source.js";

export type {
  GatewayClient,
  SyncState,
  SourceStats,
  IndexStats,
  ListedDocument,
  ListDocumentsOptions,
  GatewaySearchQuery,
  GatewaySearchResponse,
  ReconcileResponse,
  DocumentCountResponse,
  DocumentExistsResponse,
  DeleteAllResponse,
  DocumentIdsResponse,
  DbSizeResponse,
  IngestAnalyticsResponse,
  UpsertWithCursorResponse,
} from "./gateway-client.js";

export {
  StandardRateLimitTracker,
  type RateLimitTracker,
  type StandardRateLimitTrackerOptions,
} from "./rate-limiter.js";

export { htmlToMarkdown } from "./html-to-markdown.js";

export {
  extractSchemaOrgDatesFromHtml,
  isAutoSubmittedGenerated,
  mailHeaderRelevancePenalty,
} from "./mail-markup.js";

export { atomicWriteFile, atomicWriteFileSync } from "./atomic-write.js";

export {
  acquireGatewayLock,
  holderIsAlive,
  liveGatewayHolder,
  readGatewayLockHolder,
  GatewayLockHeldError,
  GATEWAY_LOCK_FILE,
  GATEWAY_SHUTDOWN_BUDGET_MS,
  GATEWAY_EXIT_TIMEOUT_SECONDS,
  type GatewayLock,
  type GatewayLockHolder,
} from "./gateway-lock.js";

export {
  acquireUpdateLock,
  adoptUpdateLock,
  getUpdateLockProcessGroup,
  UpdateLockBusyError,
  UpdateLockWaitTimeoutError,
  UPDATE_LOCK_ENV,
  updateLockHolderLabel,
  waitForUpdateLock,
  type UpdateLock,
  type AdoptUpdateLockOptions,
  type UpdateLockOptions,
  type UpdateLockProcessGroup,
  type UpdateLockWaitOptions,
} from "./update-lock.js";

export {
  BACKUP_FULL_MANIFEST_NAME,
  BACKUP_MANIFEST_NAME,
  BACKUP_RECOVERY_ENVELOPE_NAME,
  KEYRING_PASSPHRASE_FILE_NAME,
  DEFAULT_PRE_UPDATE_BACKUP_COUNT,
  backupConfigCopyNames,
  backupManifestSchema,
  createBackupDir,
  gatewayStoreFiles,
  listBackups,
  prunePreUpdateBackups,
  writeOfflineBackup,
  type BackupLog,
  type BackupManifest,
  type BackupPurpose,
  type GatewayStoreFile,
  type ListedBackup,
  type OfflineBackupOptions,
  type OfflineBackupResult,
} from "./backup-layout.js";

export { capDeviceUpdateDetail, summarizeCommandFailure } from "./command-output.js";
export { DEVICE_UPDATE_DETAIL_MAX_CHARS } from "./ws-messages.js";

export {
  ensureGatewayTrust,
  GatewayCertificateChangedError,
  isTlsCertError,
  fetchPeerCert,
  normalizeCertFingerprint,
  retrustGateway,
  tlsErrorCode,
  type TofuResult,
} from "./tofu.js";

export { retry, type RetryOptions } from "./retry.js";

export {
  normalizeTimeZone,
  hostTimeZone,
  utcOffsetLabel,
  MAX_TIME_ZONE_LENGTH,
} from "./time-zone.js";

export { normalizeForQuoteMatch } from "./quote-normalize.js";

export {
  experimentalEnabled,
  experimentalVisible,
  syntheticEnabled,
  devModeEnabled,
  EXPERIMENTAL_ENV_VAR,
  DEV_MODE_ENV_VAR,
} from "./experimental-features.js";

export type { SourceMeta, SourceMetaEntry } from "./source-meta.js";

export { resolveSourcePatterns, type SourceEntry } from "./source-patterns.js";

export {
  PAIRING_PROTOCOL_MIN_VERSION,
  PAIRING_PROTOCOL_VERSION,
  buildPairingPayloadV2,
  buildPairingPayloadV3,
  buildPairingPayloadV4,
  decodePairingPayload,
  type PairingPayload,
  type PairingPayloadV1,
  type PairingPayloadV2,
  type PairingPayloadV3,
  type PairingPayloadV4,
  type PairingPayloadDecodeError,
  type PairingTlsTrust,
} from "./pairing-protocol.js";

export {
  buildCompatManifest,
  HTTP_API_COMPAT,
  type CompatManifest,
  type StoreCompat,
  type StorePolicy,
  type HttpApiCompat,
  type ClientCompat,
} from "./compat.js";

export {
  SOURCE_CONTRACT_WIRE_VERSION,
  SOURCE_CONTRACT_WIRE_MIN_VERSION,
  SOURCE_CONTRACT_WIRE_RANGE,
  assertGatewaySourceContract,
  sourceContractWireRangeSchema,
} from "./source-contract-wire.js";

export {
  MINIMUM_CLIENT_VERSIONS,
  compareProductVersions,
  parseProductVersion,
  computeClientVersionState,
  summarizeFleetVersions,
  formatFleetVersionSummary,
  type ClientVersionState,
  type ClientVersionInput,
  type FleetVersionSummary,
} from "./client-version.js";

export {
  localDeviceUpdateCommands,
  planDeviceCommitUpdate,
  planDeviceUpdate,
  type FleetUpdateCandidate,
  type FleetUpdateDisposition,
  type FleetUpdateEntry,
  type FleetUpdateOutcome,
  type FleetUpdatePlan,
  type FleetUpdateRefusalCode,
} from "./fleet-update.js";

export {
  formatCognitionRunEnvelope,
  parseCognitionRunEnvelope,
  cognitionRunPromptBody,
  type CognitionRunEnvelope,
} from "./cognition-envelope.js";

export { makeCursorValidator, type CursorValidator } from "./cursor-validator.js";

export { createLogger, setLogLevel, setLogFile, LogLevel, type Logger } from "./logger.js";

export {
  computeContentHash,
  toErrorMessage,
  assertNever,
  DEFAULT_CONFIG_DIR,
  GATEWAY_ANALYTICS_STORE_FILE,
  GATEWAY_INDEX_STORE_FILE,
  GATEWAY_STORE_FILE,
  OPERATOR_INSTRUCTIONS_FILENAME,
  WATCH_JOURNAL_FILENAME,
  stripThinkTags,
  createThinkTagFilter,
} from "./utils.js";
export type { ThinkTagFilter } from "./utils.js";

export {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  PRIVATE_UMASK,
  applyPrivateUmask,
  ensurePrivateDirSync,
  ensurePrivateFileSync,
} from "./security-files.js";

export {
  clearSecretFileKeyCacheForTests,
  primeSecretFileKeyCache,
  secretFileScope,
  secretFileEncryptionRequired,
  markSecretFileEncryptionRequired,
  markSecretFileEncryptionRequiredSync,
  isEncryptedSecretFile,
  readSecretTextFile,
  readSecretTextFileSync,
  readSecretJsonFile,
  readSecretJsonFileSync,
  SecretFileRootKeyUnavailableError,
  isSecretFileRootKeyUnavailableError,
  writeSecretTextFile,
  writeSecretTextFileSync,
  writeSecretJsonFile,
  writeSecretJsonFileSync,
  migrateSecretTextFile,
  type SecretFileOptions,
  type SecretFileWriteResult,
  type SecretFileMigrationResult,
} from "./secret-file.js";

export {
  ENCRYPTED_ARTIFACT_SUFFIX,
  encryptArtifactFileInPlace,
  decryptArtifactFileToFile,
  isEncryptedArtifactBuffer,
  isEncryptedArtifactFile,
  decryptArtifactFileToBuffer,
  type DecryptArtifactFileToFileOptions,
  type DecryptArtifactFileToFileResult,
  type EncryptArtifactFileOptions,
  type EncryptArtifactFileResult,
} from "./encrypted-artifact.js";

export {
  STORAGE_KEY_NAMES,
  StorageKeyRootKeyUnavailableError,
  ensureStorageKey,
  inspectStorageKey,
  markStorageEncryptionRequired,
  markStorageEncryptionRequiredSync,
  parseStorageKeyName,
  readStorageKey,
  readStorageKeySync,
  rotateStorageKey,
  storageEncryptionRequired,
  storageKeyHex,
  storageKeyNamesForHost,
  storageKeyPath,
} from "./storage-keys.js";
export type {
  EnsureStorageKeyResult,
  StorageKeyHost,
  StorageKeyName,
  StorageKeyOptions,
  StorageKeyState,
} from "./storage-keys.js";
export {
  detectStorageKeyHosts,
  enforceMarkerIntegrity,
  resolveStorageEncryptionReadiness,
  storageKeyNamesForHosts,
} from "./storage-readiness.js";
export type { StorageEncryptionReadiness } from "./storage-readiness.js";
export {
  classifySecureMarker,
  clearMarkerKeyringState,
  readMarkerKeyringState,
  renderSecureMarker,
  secureMarkerPath,
  setMarkerKeyringState,
  verifySecureMarker,
  writeSecureMarker,
  writeSecureMarkerSync,
} from "./secure-marker.js";
export type { SecureMarkerKind, SecureMarkerOptions, SecureMarkerStatus } from "./secure-marker.js";
export {
  createRecoveryEnvelope,
  generateRecoveryCode,
  normalizeRecoveryCode,
  openRecoveryEnvelope,
  parseRecoveryEnvelope,
  recoveryEnvelopePath,
  RecoveryCodeInvalidError,
} from "./recovery-envelope.js";
export type { RecoveryEnvelopeV1 } from "./recovery-envelope.js";

export {
  DEFAULT_SYNC_INTERVAL_MS,
  getSyncIntervalMs,
  parseDuration,
  parseSourceKey,
  getDataCutoffDate,
  getSourceCutoffDate,
  resolveSourceMaxAge,
  readTokenFile,
  resolveToken,
  readCollectorTokenFile,
  writeCollectorTokenFile,
} from "./config.js";

export type {
  GatewayPolicyConfig,
  IndexerConfig,
  SourceConfig,
  DataRetentionConfig,
  SearchConfig,
} from "./config.js";

// The collector's own record of whether it is still paired. Written by the
// collector daemon, read by `omnesis service status`.
export {
  COLLECTOR_PAIRING_STATE_FILE,
  classifyCollectorAuth,
  credentialEverAuthenticated,
  needsPairingLogLine,
  readCollectorPairingState,
  repairCommandFor,
  tokenFingerprint,
  writeCollectorPairingState,
} from "./collector-pairing-state.js";
export type { CollectorPairingState } from "./collector-pairing-state.js";

// `./config-schema.js` here is the `export * from "@omnesis/config"` shim, so
// these resolve to the @omnesis/config package — including the schema-describe
// helpers (`describeConfigSchema` et al.) defined in its `config-describe.ts`.
export {
  omnesisConfigSchema,
  validateConfig,
  toJsonPointer,
  applyMergePatch,
  changedPathsFromPatch,
  resolveSourceSettings,
  pickSourceSettings,
  SOURCE_SETTINGS_KEYS,
  describeConfigSchema,
  flattenConfigNodes,
  CONFIG_PATHS_OWNED_ELSEWHERE,
  CONFIG_DEFAULTS,
  NO_STATIC_DEFAULT_PATHS,
  configDefaultAt,
} from "./config-schema.js";

export type {
  OmnesisConfig,
  SourceSettings,
  ConfigValidationError,
  ConfigNode,
  ConfigObjectNode,
  ConfigRecordNode,
  ConfigLeafNode,
  ConfigLeafKind,
  ConfigConstraints,
  ConfigOwnership,
  FlatConfigEntry,
} from "./config-schema.js";

export type {
  SourceDescriptor,
  SourceParam,
  ProviderInfo,
  AuthType,
  WidgetOrigins,
  WidgetRendererSpec,
  AuthFlowCallbacks,
  SerializedDescriptor,
} from "./source-descriptor.js";

export { serializeDescriptor } from "./source-descriptor.js";

export {
  MissingCredentialsError,
  isMissingCredentialsError,
  providerCredentialsPath,
  readProviderCredentials,
  writeProviderCredentials,
  clearProviderCredentials,
  hasProviderCredentials,
  CredentialPersistError,
  isCredentialPersistError,
  providerAccountCredentialsPath,
  listProviderAccountDirs,
  hasProviderAccountCredentials,
  listProviderAccountIds,
  readProviderAccountCredentials,
  readProviderAccountOrLegacyCredentials,
  writeProviderAccountCredentials,
  clearProviderAccountCredentials,
  clearProviderAccountAndLegacyCredentials,
  loadOrAdoptProviderAccountCredentials,
  redactSecrets,
  serializeCredentialsSpec,
  validateCredentialFields,
} from "./credentials.js";

export { AUTH_ERROR_CODES, isAuthErrorCode, type AuthErrorCode } from "./auth-error-codes.js";

export type {
  ProviderCredentialsSpec,
  ProviderCredentialsField,
  ProviderCredentialsWizardStep,
  SerializedProviderCredentialsSpec,
} from "./credentials.js";

export {
  GATEWAY_ORIGIN_TOKEN,
  resolveGatewayOrigin,
  expandGatewayOriginToken,
  publicBaseUrlFromAdminConfig,
  expandSpecTokens,
} from "./credentials-tokens.js";

export {
  OMNESIS_SECRET_SERVICE,
  OMNESIS_INSTALL_ROOT_KEY,
  SECRET_STORE_BACKENDS,
  PASSPHRASE_ENV,
  PASSPHRASE_FILE_ENV,
  PASSPHRASE_CREDENTIAL_NAME,
  KEYRING_ENV_KEYS,
  SecretStoreUnavailableError,
  PassphraseMismatchError,
  createSecretStore,
  parseSecretStoreBackend,
  inspectInstallRootKey,
  ensureInstallRootKey,
  readInstallRootKey,
  readInstallRootKeySync,
  writeInstallRootKey,
  generateInstallRootKey,
  installRootKeyBytes,
  isInstallRootKey,
} from "./secret-store.js";
export type {
  SecretStoreBackend,
  ResolvedSecretStoreBackend,
  SecretStoreStatus,
  SecretStore,
  SecretCommandResult,
  SecretCommandOptions,
  SecretCommandRunner,
  CreateSecretStoreOptions,
  InstallRootKeyState,
  EnsureInstallRootKeyResult,
} from "./secret-store.js";
export {
  SealedEnvelopeInvalidError,
  openStringEnvelope,
  parseSealedEnvelope,
  sealStringEnvelope,
} from "./sealed-envelope.js";
export type { SealedEnvelopeScope, SealedEnvelopeV1 } from "./sealed-envelope.js";

export {
  CONFIG_SECRET_REF_PREFIX,
  makeConfigSecretRef,
  parseConfigSecretRef,
  configSecretPath,
  readConfigSecretRefSync,
  writeConfigSecretSync,
  clearConfigSecretRefSync,
} from "./config-secrets.js";
export {
  cleanupConfigSecretMaterialization,
  inferenceBackendApiKeySecretName,
  materializeConfigSecrets,
  type ConfigSecretMaterialization,
} from "./config-secret-materialization.js";

export {
  discoverNetworkIdentities,
  realLanIpv4s,
  safeNetworkInterfaces,
  networkInterfacesUsable,
  isVirtualInterface,
  isCertificateIpAddress,
  localMdnsHostname,
  swapHost,
  type NetworkIdentity,
  type NetworkIdentityKind,
} from "./network-discovery.js";

export {
  isTailnetName,
  judgePairingAddress,
  pairingHost,
  pairingPlatformForKind,
  pairingReachRank,
  type AwayFromHomeHint,
  type PairingAddressContext,
  type PairingAddressOption,
  type PairingAddressPlan,
  type PairingAddressReach,
  type PairingAddressVerdict,
  type PairingPlatform,
} from "./pairing-address.js";

export { discoverGatewayViaMdns, type DiscoveredGateway } from "./mdns-discovery.js";

export {
  extractUrls,
  normalizeUrl,
  urlToExternalId,
  canonicalDomain,
  hostIsOwned,
  buildCanonicalizerRegistry,
} from "./url-utils.js";
export type { UrlCanonicalizerSpec } from "./url-utils.js";

export {
  openReadonlySqliteSnapshot,
  SqliteSnapshotChangedError,
  type SqliteSnapshot,
} from "./sqlite-snapshot.js";

export {
  isCompiledModule,
  resolveWorkerEntry,
  resolveSubprocessEntry,
  type WorkerEntry,
  type SubprocessEntry,
} from "./worker-entry.js";

export { readPackageVersion } from "./package-version.js";

export { applyCaTrustInProcess } from "./tofu.js";
export {
  certificateCoversHost,
  certificateNames,
  inspectTlsMaterial,
  normalizeRequiredHost,
  resolveTlsMaterial,
  type InspectTlsMaterialInput,
  type ResolvedTlsMaterial,
  type TlsLifecycleSnapshot,
  type TlsMaterialInspection,
  type TlsMaterialPaths,
  type TlsMaterialState,
  type TlsOwnership,
  type TlsRenewalMode,
} from "./tls-material.js";

export {
  extractLinks,
  type ExtractedLink,
  type LinkType,
  type SourceEdgeType,
  SOURCE_EDGE_TYPES,
  isSourceEdgeType,
} from "./link-extractor.js";

export type { DiffSummary, RunTrigger, CognitionDocumentRef } from "./cognition-run-trigger.js";
export type { SqlGrantRefusal } from "./sql-grant-refusal.js";
export { describeSqlGrantRefusal } from "./sql-grant-refusal.js";
export type { DocumentRef, EdgeDeclaration } from "./edge-declaration.js";
export { WEB_PAGE_SOURCE_ID, webPageEdgeTarget } from "./edge-declaration.js";

export type {
  GraphVertexKind,
  GraphVertex,
  GraphEdgeType,
  NearDuplicateEdgeType,
  SameEntityEdgeType,
  GraphEdgeProvenanceKind,
  GraphEdgeStorage,
  GraphEdgeEndpoints,
  GraphEdgeDescriptor,
  GraphEdge,
  DocumentGraph,
  BuildDocumentGraphOptions,
  GraphWalkFilters,
  RecordReference,
} from "./graph.js";

export {
  NEAR_DUPLICATE_EDGE_TYPE,
  SAME_ENTITY_EDGE_TYPE,
  analyticsRowKey,
  parseAnalyticsRowKey,
  recordReference,
  GRAPH_EDGE_TYPES,
  graphEdgeDescriptors,
  graphEdgeDescriptor,
  graphEdgeProvenance,
  isGraphEdgeType,
} from "./graph.js";

export {
  normalizeEmail,
  formatLid,
  normalizeLid,
  isUnstableLid,
  WHATSAPP_LID_PLATFORM,
  isNonIdentifyingEmail,
  isAutomatedSenderAddress,
  hasValidEmailTld,
  normalizePhone,
  setDefaultPhoneRegion,
  looksLikePhone,
  isPlaceholderPersonName,
  parseEmailHeader,
  splitEmailList,
  extractEmailsFromText,
  extractPhonesFromText,
  extractEmailsAndPhonesFromText,
  deriveAuthor,
  cleanPersonName,
  countryNameToISO2,
} from "./people-utils.js";

export {
  resolveAttachmentConfig,
  shouldExtractAttachment,
  fileKindName,
  resolveEffectiveMimeType,
  buildAttachmentDocument,
  deriveAttachmentStableId,
  assignAttachmentSeqs,
  formatAttachmentMarkers,
  DEFAULT_MAX_SIZE_BYTES,
  DEFAULT_ATTACHMENT_TYPES,
  STT_AUDIO_TYPES,
  DEFAULT_MAX_TEXT_LENGTH,
} from "./attachments.js";

export type {
  AttachmentInfo,
  AttachmentExtractionConfig,
  ExtractionResult,
  AttachmentExtractFn,
} from "./attachments.js";

export type { AudioTranscribeFn } from "./transcription.js";

export type { OcrFn, OcrResult } from "./ocr.js";

export {
  defineSource,
  defineProvider,
  defineStructuredSource,
  resolveProvider,
} from "./define-source.js";

export type {
  SourceDefinition,
  ProviderDefinition,
  SourceOrProviderDefinition,
  SourceInstance,
  CreateOptions,
  ProviderSourceEntry,
} from "./define-source.js";

export { syncPage, emptySync, applyDataCutoff } from "./source.js";

export {
  SyncError,
  isTransientSyncError,
  type SyncErrorKind,
  type SyncErrorOptions,
} from "./sync-error.js";

export { pMap } from "./p-map.js";

// Device + scope types (star-topology architecture).
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
  SCOPE_WRITE_ALL,
  SCOPE_SUBSCRIPTIONS_MANAGE,
  SCOPE_SUBSCRIPTIONS_RECEIVE,
  SCOPE_SUBSCRIPTIONS_ANSWER,
  SCOPE_SUBSCRIPTIONS_OUTCOME,
  SCOPE_PUSH_CLAIM,
  PUSH_TRANSPORTS,
  isPushTransport,
  writeScope,
  isValidScope,
  parseScope,
  classifyScope,
  scopeSatisfies,
} from "./device.js";

export type {
  DeviceKind,
  ScopeClass,
  DeviceCapability,
  DeviceRecord,
  ApnsRegistration,
  FcmRegistration,
  PushTransport,
  TokenRecord,
} from "./device.js";

// WebSocket protocol envelope.
export {
  WsCorrelationId,
  newCorrelationId,
  isWsCommand,
  isWsResponse,
  isWsEvent,
  isWsEnvelope,
  makeCommand,
  makeResponseOk,
  makeResponseErr,
  makeEvent,
  WS_INVALID_INPUT,
  WsInvalidInputError,
} from "./ws-protocol.js";

export type {
  WsCommand,
  WsResponse,
  WsResponseOk,
  WsResponseErr,
  WsEvent,
  WsEnvelope,
} from "./ws-protocol.js";

// Typed registry of every known WS message (request/response/event payload
// schemas). Producers and consumers consult this for compile-time inference
// and zod-backed runtime validation.
export {
  WS_AUTH_PROTOCOL_PREFIX,
  websocketAuthProtocol,
  parseWebSocketAuthProtocolHeader,
} from "./ws-auth.js";

export {
  PROTOCOL_VERSION,
  wsCommandSchemas,
  wsEventSchemas,
  isKnownCommandType,
  isKnownEventType,
  parseRequestPayload,
  parseResponsePayload,
  parseEventPayload,
  deviceUpdateResultEvent,
} from "./ws-messages.js";

export type {
  WsCommandRegistry,
  WsCommandType,
  WsEventRegistry,
  WsEventType,
  WsRequestPayload,
  WsResponsePayload,
  WsEventPayload,
} from "./ws-messages.js";

// Agent-harness protocol (demo agent that lives inside the gateway).
export {
  KNOWN_AGENT_ERROR_CODES,
  docBodySchema,
  docRefSchema,
  breadcrumbSchema,
  docLoopRefSchema,
  docAnnotationHintSchema,
  docTemporalAnnotationRefSchema,
  loopSummarySchema,
  loopDetailSchema,
  personSummarySchema,
  trailEventDocSchema,
  trailEventPersonSchema,
  trailEventRelatedSchema,
  trailRecordKeyFieldSchema,
  trailRecordSchema,
  trailEventSchema,
  eventTrailSchema,
  planItemSchema,
  toolResultSchema,
  chatMessageSchema,
  agentSessionCreateRequest,
  agentSessionCreateResponse,
  agentMessageSendRequest,
  agentMessageSendResponse,
  agentSessionCancelRequest,
  agentSessionCancelResponse,
  agentMessageStartEvent,
  agentTextDeltaEvent,
  agentThinkingDeltaEvent,
  agentToolStartEvent,
  agentToolResultEvent,
  agentCitationEvent,
  agentCitationsUpdateEvent,
  agentUsageSchema,
  agentContextAssessmentSchema,
  agentTerminalFailureSchema,
  agentConversationTerminalFailureSchema,
  subagentStatusSchema,
  deepResearchStoppedReasonSchema,
  agentSubagentSpawnedEvent,
  agentSubagentEventEvent,
  agentSubagentResultEvent,
  deepResearchPlanItemSchema,
  deepResearchVerificationSchema,
  agentDeepResearchSummaryEvent,
  agentMessageEndEvent,
  agentErrorEvent,
  isSelfQuoteAuthor,
  agentProviderFailureDetailSchema,
  sanitizeProviderFailureField,
  formatProviderFailureDetail,
} from "./agent-protocol.js";

export type {
  KnownAgentErrorCode,
  DocBody,
  DocRef,
  Breadcrumb,
  DocLoopRef,
  DocAnnotationHint,
  DocTemporalAnnotationRef,
  LoopSummary,
  LoopDetail,
  PersonSummary,
  TrailEventDoc,
  TrailEventPerson,
  TrailEventRelated,
  TrailRecordKeyField,
  TrailRecord,
  TrailEvent,
  EventTrail,
  PlanItem,
  ToolResult,
  StructuredToolResult,
  ChatMessageWire,
  AgentSessionCreateRequest,
  AgentSessionCreateResponse,
  AgentMessageSendRequest,
  AgentMessageSendResponse,
  AgentSessionCancelRequest,
  AgentSessionCancelResponse,
  AgentMessageStartEvent,
  AgentTextDeltaEvent,
  AgentThinkingDeltaEvent,
  AgentToolStartEvent,
  AgentToolResultEvent,
  AgentCitationEvent,
  AgentCitationsUpdateEvent,
  AgentUsage,
  AgentContextAssessment,
  AgentTerminalFailure,
  AgentConversationTerminalFailure,
  SubagentStatus,
  DeepResearchStoppedReason,
  SubagentJoinedEntry,
  AgentSubagentSpawnedEvent,
  AgentSubagentEventEvent,
  AgentSubagentResultEvent,
  DeepResearchPlanItem,
  DeepResearchVerification,
  AgentDeepResearchSummaryEvent,
  AgentMessageEndEvent,
  AgentErrorEvent,
  AgentEvent,
  AgentEventType,
  AgentProviderFailureDetail,
  Citation,
} from "./agent-protocol.js";

// Terminal UX primitives: inline images + OSC 8 hyperlinks, iTerm2-only.
// Every function returns a string that can be concatenated into normal
// output; degrades to an empty string (images) or `text (url)` (links) on
// terminals that don't support the feature. See terminal-fx/index.ts
// (tmux / Kitty / Ghostty / WezTerm support is not yet implemented).
export {
  imagesSupported,
  hyperlinksSupported,
  inlineImage,
  hyperlink,
  type InlineImageOptions,
  type HyperlinkOptions,
} from "./terminal-fx/index.js";

// Model management — bundled catalog, on-disk manifest, inference types.
// See packages/core/src/models/index.ts for the architecture.
export {
  MODEL_ROLES,
  CATALOG_ROLE_CAPABILITY,
  CAPABILITY_ROLES,
  CODEX_SUPPORTED_ROLES,
  CAPABILITY_METADATA,
  CATALOG,
  catalogForRole,
  defaultForRole,
  getCatalogEntry,
  getCatalogEntryByFilename,
  loadManifest,
  saveManifest,
  upsertManifestEntry,
  removeManifestEntry,
  findManifestEntry,
  findManifestEntryByFilename,
  ANTHROPIC_CREDENTIALS_SPEC,
  PROVIDER_PRESETS,
  getPreset,
  PROVIDER_BRANDS,
  getProviderBrand,
  resolveModelDisplay,
  classifyModelRoles,
  classifyModels,
  fuzzyMatchModelId,
  MAX_RECENT_MODELS_PER_ROLE,
  siblingRolesForRecentModels,
  mergeRecentCandidates,
  recordRecentHistory,
  normalizeApiPathPrefix,
  extractModelIds,
  CLOUD_EGRESS_DISABLED_REASON,
  InferenceUrlPolicyError,
  assertInferenceUrlAllowed,
  classifyInferenceIp,
  fetchWithInferenceUrlPolicy,
  BACKGROUND_RATE_LIMIT_PATIENCE,
  rateLimitRetryDelayMs,
  retryRateLimitedRequest,
} from "./models/index.js";

export type {
  RateLimitPatience,
  ModelRole,
  CatalogEntry,
  GgufCatalogEntry,
  AnthropicCatalogEntry,
  Manifest,
  ManifestEntry,
  ModelsOverview,
  ModelControlKey,
  ModelControlDescriptor,
  ModelBehaviorValues,
  ModelControls,
  ModelSettings,
  ModelSettingsByRole,
  LoadResult,
  EmbedCapability,
  CompleteCapability,
  TranscribeCapability,
  TranscriptionResult,
  OcrCapability,
  EntailCapability,
  EntailVerdict,
  CapabilityRole,
  CapabilityMetadata,
  BackendType,
  HttpBackendConfig,
  AgentProtocol,
  AssignmentValue,
  ResolvedAssignment,
  ResolvedLocal,
  OcrNativeRuntime,
  ResolvedHttp,
  ResolvedAnthropic,
  ResolvedDisabled,
  ResolvedUnresolved,
  ResolvedReplay,
  ResolvedCodex,
  BackendStatus,
  CodexBackendStatus,
  CodexLoginFlow,
  CodexModelStatus,
  CodexRuntimeStatus,
  CodexRuntimeUpdateOperation,
  CodexRuntimeUpdateOperationState,
  CodexRuntimeUpdatePlan,
  CodexRuntimeUpdateSnapshot,
  CapabilityVerdict,
  InferenceOverview,
  InferenceConfig,
  DegradedRole,
  ConfigHealth,
  ProviderPreset,
  ProviderBrand,
  ModelDisplay,
  RecentModelHistory,
  RecentModelCurrent,
  RecentModelCandidate,
  InferenceAddressClass,
  InferenceFetchPolicy,
  InferenceUrlPolicy,
  HttpRateLimitRetryOptions,
} from "./models/index.js";

export {
  AGENT_CONVERSATION_RENDER_VERSION,
  localDayKey,
  localDayBounds,
  localHourMinute,
  platformLabel,
  conversationExternalId,
  renderConversationDay,
  type ConversationMessage,
  type ConversationChat,
  type ConversationDay,
  type RenderConversationDayOptions,
} from "./agent-conversations.js";

// ── Service unit naming / paths ─────────────────────────────────────────
export {
  SERVICE_COMPONENTS,
  HARDENED_ADMIN_COMMAND,
  HARDENED_ADMIN_PATH,
  HARDENED_BOOTSTRAP_URL,
  HARDENED_CONFIG_DIR,
  HARDENED_PASSPHRASE_PATH,
  HARDENED_RELEASE_ROOT,
  HARDENED_REPO_URL,
  HARDENED_STATE_DIR,
  HARDENED_UNIT_NAME,
  HARDENED_UNIT_PATH,
  isServiceComponent,
  launchdLabel,
  launchdLabelInstance,
  launchdPlistPath,
  systemdEscapeArg,
  systemdUnitInstance,
  systemdUnitName,
  systemdUnitPath,
  type ServiceComponent,
} from "./service-paths.js";

// ── Codex runtime state layout ──────────────────────────────────────────
export {
  CODEX_HOME_DIR,
  CODEX_POOL_HOME_DIR,
  CODEX_POOL_WORKSPACE_DIR,
  CODEX_WORKSPACE_DIR,
  codexPaths,
  CODEX_RUNTIME_STORE_DIR,
} from "./codex-paths.js";

// The doctor's checks and its narrow wire-shape mirrors are reached through
// the `@omnesis/core/doctor` subpath — see `subpath/doctor.ts` for why they
// are deliberately not on the root barrel.

// ── Structured sync remediation ─────────────────────────────────────────
export { fullDiskAccessRemediation, syncRemediationSchema } from "./sync-remediation.js";
export {
  boundSyncIssues,
  syncIssueIdentity,
  syncIssueAssessmentsSchema,
  syncIssueSchema,
  syncIssuesSchema,
  syncIssueStatusSchema,
  MAX_SYNC_ISSUES,
} from "./sync-issues.js";

export { createPrivateScratch, type PrivateScratch } from "./private-scratch.js";
export {
  localGatewayRequestUrl,
  resolveHostToLoopback,
  resolvesToLoopback,
  servedCertificateCoversHost,
  servedCertificateCoversLocalhost,
} from "./local-gateway-url.js";
export {
  TAILSCALE_STATUS_TIMEOUT_MS,
  tailscaleCliCandidates,
  tailscaleCliEnv,
  tailscaleIsRunningStatus,
  type TailscaleCliCandidate,
} from "./tailscale-cli.js";
