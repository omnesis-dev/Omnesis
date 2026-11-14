// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";

export const cloudRelayConfigureBody = z
  .object({
    relayUrl: z.string().url().max(2048).optional(),
    publicOrigin: z.string().url().max(2048).optional(),
    acmeDirectoryUrl: z.string().url().max(2048).optional(),
    termsAccepted: z.boolean().optional(),
  })
  .strict();
export const cloudRelayEnableBody = z
  .object({ invitation: z.string().min(1).max(8192).optional() })
  .strict();
export const cloudRelayActionBody = z.object({}).strict();
export const cloudRelayEnrollmentBody = z.object({ policy: z.enum(["automatic", "ask"]) }).strict();
/** `revokeDevices=true` also revokes every device that joined with the sign-in. */
export const cloudRelayRemoveSignInQuery = z
  .object({ revokeDevices: z.enum(["true", "false"]).optional() })
  .strict();
export const cloudRelayConnectBody = z
  .object({ termsAccepted: z.literal(true), intent: z.enum(["create", "existing"]).optional() })
  .strict();
