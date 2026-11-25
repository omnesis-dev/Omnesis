// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { assertManagedDesktopDataAuthority, assertNever } from "@omnesis/core";
import { assertDesktopProfileGeneration } from "./generation.js";
import { finishDesktopErase } from "./removal.js";
import { restoreUnderDesktopDataAuthority } from "./data-operation-restore.js";
import { recoverDesktopRestoreTransaction } from "./restore-transaction.js";
import type { DesktopDataRequest } from "./data-operation-channel.js";

const requestSchema = z
  .object({
    version: z.literal(1),
    purpose: z.enum(["erase", "restore", "rollback", "update-snapshot", "update-rollback"]),
    operationId: z.string().uuid(),
    profile: z
      .object({
        configDir: z
          .string()
          .min(1)
          .max(4096)
          .refine(
            (value) => isAbsolute(value) && resolve(value) === value && !value.includes("\0"),
          ),
        instance: z.string().regex(/^desktop-[a-f0-9]{16}$/u),
        secretService: z.string().regex(/^dev\.omnesis\.desktop\.[a-f0-9]{64}$/u),
      })
      .strict(),
    payload: z.unknown(),
  })
  .strict();
const empty = z.object({}).strict();
const defaults = {
  authorize: assertManagedDesktopDataAuthority,
  erase: finishDesktopErase,
  restore: restoreUnderDesktopDataAuthority,
  rollback: (profile: DesktopDataRequest["profile"], operationId: string, signal: AbortSignal) =>
    recoverDesktopRestoreTransaction(profile, operationId, signal, { sessionAlreadyOwned: true }),
};

/** Only these fixed operation-bound actions are admitted by the native descriptor. */
export async function handleDesktopDataOperation(
  input: unknown,
  signal: AbortSignal,
  dependencies: Partial<typeof defaults> = {},
): Promise<unknown> {
  const request = requestSchema.parse(input),
    deps = { ...defaults, ...dependencies };
  deps.authorize(request.profile, request.purpose, request.operationId);
  assertDesktopProfileGeneration(request.profile);
  signal.throwIfAborted();
  switch (request.purpose) {
    case "erase":
      empty.parse(request.payload);
      return deps.erase(request.profile, request.operationId, signal);
    case "restore":
      return deps.restore(request, signal);
    case "rollback":
      empty.parse(request.payload);
      return deps.rollback(request.profile, request.operationId, signal);
    case "update-snapshot": {
      empty.parse(request.payload);
      const { finishDesktopUpdateSnapshot } = await import("./update-data-operation.js");
      return finishDesktopUpdateSnapshot(request.profile, request.operationId, signal);
    }
    case "update-rollback": {
      empty.parse(request.payload);
      const { finishDesktopUpdateRollback } = await import("./update-data-operation.js");
      return finishDesktopUpdateRollback(request.profile, request.operationId, signal);
    }
    default:
      return assertNever(request.purpose);
  }
}
