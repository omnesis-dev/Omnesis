// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { bodyLimit } from "hono/body-limit";
import {
  recordingRestoreReview,
  resumeRecordingRestoreReview,
  RecordingReviewChanged,
  RecordingTranscriberRequired,
} from "../../../recordings/restore-review.js";
import { scope } from "../../scope.js";
import { requireStepUp } from "../../step-up.js";
import { validateJson } from "../../validate.js";
import { ConflictError } from "../../errors.js";
import type { ConfigStore } from "../../../config-store.js";
import type { RouteApp } from "../types.js";

/** Restore review stays reachable while experimental recording ingress is off. */
export function mountRecordingReviewRoutes(
  app: RouteApp,
  store: ConfigStore,
  hasPendingChunks: () => boolean,
): void {
  app.get("/admin/recordings/restore-review", scope.admin(), (c) =>
    c.json(recordingRestoreReview(store.get(), hasPendingChunks())),
  );
  app.post(
    "/admin/recordings/restore-review/resume",
    scope.admin(),
    bodyLimit({ maxSize: 1024 }),
    requireStepUp(),
    validateJson(
      z
        .object({
          version: z
            .string()
            .length(64)
            .regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ),
    async (c) => {
      try {
        await resumeRecordingRestoreReview(store, c.req.valid("json").version, hasPendingChunks);
      } catch (error) {
        if (
          error instanceof RecordingReviewChanged ||
          error instanceof RecordingTranscriberRequired
        )
          throw new ConflictError(error.message);
        throw error;
      }
      return c.json(recordingRestoreReview(store.get(), hasPendingChunks()));
    },
  );
}
