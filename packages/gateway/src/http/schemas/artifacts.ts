// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";

export const artifactCatalogQuery = z
  .object({ kind: z.enum(["backup", "export"]).optional() })
  .strict();
export const artifactDownloadId = z.string().regex(/^[a-f0-9]{64}$/u);
export const readableArtifactConsent = z
  .object({ acknowledgeUnencryptedCopy: z.literal(true) })
  .strict();
