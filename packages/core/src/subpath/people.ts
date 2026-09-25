// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `@omnesis/core/people` — name / email / phone normalisation helpers.
 *
 * Used across the gateway's people resolution + the collector's
 * structured-source pipeline. Importing from this subpath signals
 * the consumer is doing identity work; the helpers are stable and
 * have been the home for cross-source person normalisation.
 */

export {
  normalizeEmail,
  isNonIdentifyingEmail,
  normalizePhone,
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
} from "../people-utils.js";
