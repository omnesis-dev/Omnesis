// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Moved to `@omnesis/types/document`. This shim preserves the
// `from "./document.js"` and `from "@omnesis/core"` import edges for
// consumers that haven't migrated to the new package yet.
export type {
  DocumentType,
  KnownDocumentType,
  PersonRole,
  PersonMention,
  PersonIdentifier,
  PersonIdentifierKind,
  Document,
  DocumentMetadata,
  DocumentInput,
  ExtractedDate,
} from "@omnesis/types/document";

export {
  KNOWN_DOCUMENT_TYPES,
  PERSON_ROLES,
  PERSON_IDENTIFIER_KINDS,
  personIdentifiers,
  personIdentifierIsReadable,
} from "@omnesis/types/document";
