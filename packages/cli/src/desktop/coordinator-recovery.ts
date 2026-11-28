// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { assertNever } from "@omnesis/core";
import type { DesktopRecoveryService } from "./recovery.js";

export async function handleDesktopRecovery(
  service: DesktopRecoveryService,
  command:
    "recoveryImport" | "recoveryStatus" | "recoveryPrepare" | "recoveryCommit" | "recoveryCancel",
  params: unknown,
  signal: AbortSignal,
) {
  switch (command) {
    case "recoveryImport": {
      const input = z
        .object({ envelope: z.unknown(), recoveryCode: z.string().min(1).max(512) })
        .strict()
        .parse(params);
      return service.restoreExisting(input.envelope, input.recoveryCode, signal);
    }
    case "recoveryStatus":
      z.object({})
        .strict()
        .parse(params ?? {});
      return service.status(signal);
    case "recoveryPrepare": {
      const input = z
        .object({ replaceExisting: z.boolean().optional() })
        .strict()
        .parse(params ?? {});
      return service.prepare({ ...input, signal });
    }
    case "recoveryCommit": {
      const input = z.object({ draftId: z.string().uuid() }).strict().parse(params);
      return service.commit(input.draftId, signal);
    }
    case "recoveryCancel": {
      const input = z.object({ draftId: z.string().uuid() }).strict().parse(params);
      service.cancel(input.draftId);
      return { cancelled: true as const };
    }
    default:
      return assertNever(command);
  }
}
