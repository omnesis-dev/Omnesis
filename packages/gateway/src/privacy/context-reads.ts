// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readScopeHistoryPage } from "./answer-history.js";
import { assemblePrivacyReviewerContext } from "./store-audit.js";
import type { ReadPort } from "../scheduler/read-port.js";

/** Shared bounded history and final accounting reads, served by the IO worker. */
export const ANSWER_HISTORY_READS = {
  scopeHistoryPage: readScopeHistoryPage,
  scopeReviewerContext: assemblePrivacyReviewerContext,
};
export type AnswerHistoryReads = ReadPort<typeof ANSWER_HISTORY_READS>;
