// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `@omnesis/types` — branded IDs, document model, device + scope types,
 * sync error envelopes, pagination shapes.
 *
 * Foundation package every other package in the workspace can depend
 * on. The branded ID constructors carry minimal runtime (validation
 * only); device/scope helpers similarly. Everything else is pure
 * types — consumers can import via the per-domain subpaths
 * (`@omnesis/types/ids`, `/device`, `/document`, `/sync-error`,
 * `/pagination`) and let TypeScript erase the imports at runtime.
 *
 * `@omnesis/core` re-exports every symbol here for back-compat;
 * consumers that already `import { … } from "@omnesis/core"` keep
 * working unchanged. New code SHOULD prefer `@omnesis/types` (or its
 * subpaths) for the narrower dep edge.
 */

export type { Brand } from "./brand.js";
export * from "./ids.js";
export * from "./device.js";

// Compile-time guard: every branded type this package defines must stay a
// distinct type. They share one `Brand<>` symbol (see brand.ts), so a literal
// collision would silently unify two brands; this assertion turns that into a
// `tsc --build` failure. Type-only — erased at runtime.
import type { AllDistinct, Expect } from "./brand.js";
import type { ProviderType, ProviderId, SourceType, SourceId, AccountId } from "./ids.js";
import type { DeviceId, TokenId, Scope } from "./device.js";
type _BrandsArePairwiseDistinct = Expect<
  AllDistinct<[ProviderType, ProviderId, SourceType, SourceId, AccountId, DeviceId, TokenId, Scope]>
>;
export type {
  DocumentType,
  KnownDocumentType,
  PersonRole,
  PersonMention,
  PersonIdentifier,
  PersonIdentifierSource,
  PersonIdentifierKind,
  DocumentIngestionContext,
  Document,
  DocumentMetadata,
  NoteCaptureContext,
  DocumentInput,
  ExtractedDate,
} from "./document.js";

export {
  KNOWN_DOCUMENT_TYPES,
  PERSON_ROLES,
  PERSON_IDENTIFIER_KINDS,
  personIdentifiers,
  personIdentifierIsReadable,
} from "./document.js";
export * from "./sync-error.js";
export * from "./failure-scope.js";
export * from "./temporal-vocabulary.js";
export * from "./temporal-interval.js";
export * from "./pagination.js";
export * from "./privacy.js";
export * from "./subscriptions.js";
export * from "./mobile-permission-health.js";
export type * from "./source-notice.js";
