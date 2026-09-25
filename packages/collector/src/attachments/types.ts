// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Re-export all attachment types and helpers from core
export type {
  AttachmentInfo,
  AttachmentExtractionConfig,
  ExtractionResult,
  AttachmentExtractFn,
} from "@omnesis/core";

export {
  DEFAULT_MAX_SIZE_BYTES,
  DEFAULT_ATTACHMENT_TYPES,
  DEFAULT_MAX_TEXT_LENGTH,
} from "@omnesis/core";
