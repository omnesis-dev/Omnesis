// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Public surface for collector's attachment extraction. The other
// per-format extractors (extract-pdf, extract-text, extract-office,
// extract-eml) are wired internally inside extract.ts; only the
// top-level orchestrator is consumed by main.ts. The previous broad
// re-export of @omnesis/core helpers was dead — kept only the live
// edge after the dead-code sweep (era core split + this
// bundle).
export { createAttachmentExtractor } from "./extract.js";
