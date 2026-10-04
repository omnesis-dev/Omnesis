// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { bodyLimit } from "hono/body-limit";
import { scope } from "../scope.js";
import { BadRequestError } from "../errors.js";
import { transcriptionContextSchema } from "../schemas/transcription.js";
import type { TranscriptionVocabularyService } from "../../transcribe/vocabulary/service.js";
import type { RouteApp } from "./types.js";

/** Vocabulary exposes corpus-derived phrases and requires bulk corpus read access. */
export function mountTranscriptionVocabularyRoutes(
  app: RouteApp,
  service: TranscriptionVocabularyService,
): void {
  app.post(
    "/inference/transcription-vocabulary",
    scope.readBulk(),
    bodyLimit({ maxSize: 16384 }),
    async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        throw new BadRequestError("Invalid JSON body");
      }
      const parsed = transcriptionContextSchema.safeParse(body);
      if (!parsed.success) throw new BadRequestError("Invalid transcription context");
      c.header("Cache-Control", "no-store");
      return c.json(await service.getSnapshot(parsed.data));
    },
  );
}
