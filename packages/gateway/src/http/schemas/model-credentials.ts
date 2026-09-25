// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Request-body schema for routes mounted in `routes/model-credentials.ts`.
 *
 * Per-field pattern matching (e.g. Anthropic key prefix `sk-ant-`) lives on
 * the `ModelProviderSpec` and is enforced after schema parse — the schema
 * only enforces the envelope and that values are strings.
 */
import { z } from "zod";

// POST /admin/model-credentials/:fileKey
export const setModelCredentialsBody = z.object({
  fields: z.record(z.string(), z.string()),
});
export type SetModelCredentialsBody = z.infer<typeof setModelCredentialsBody>;
