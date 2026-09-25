// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";

export interface LinkExtractionInput {
  source_id: string;
  external_id: string;
  content_hash: string;
  metadata: string;
  extracted_content_hash: string | null;
}

/** Exact OCC token for every persisted document field that affects link output. */
export function linkExtractionInputDigest(input: LinkExtractionInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.source_id,
        input.external_id,
        input.content_hash,
        input.metadata,
        input.extracted_content_hash,
      ]),
    )
    .digest("hex");
}
