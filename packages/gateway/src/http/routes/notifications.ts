// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { cloudRelayEnabled } from "@omnesis/core";
import { z } from "zod";
import { NotFoundError } from "../errors.js";
import { scope } from "../scope.js";
import { validateJson } from "../validate.js";
import type { ClaimedNotificationDelivery } from "../../push/queue.js";
import type { DeviceId } from "@omnesis/types";
import type { RouteApp } from "./types.js";

const emptyBody = z.object({}).strict();
const confirmBody = z.object({ id: z.string().uuid() }).strict();

export interface NotificationRoutesDeps {
  claim(
    deviceId: DeviceId,
    supportsPairingNotifications?: boolean,
  ): Promise<ClaimedNotificationDelivery | null>;
  confirm(deviceId: DeviceId, deliveryId: string): Promise<boolean>;
}

export function mountNotificationRoutes(app: RouteApp, deps: NotificationRoutesDeps): void {
  app.post("/notifications/claim", scope.pushClaim(), validateJson(emptyBody), async (c) => {
    const deviceId = c.get("auth").deviceId!;
    // The header is part of the cloud relay opt-in and is ignored without it.
    const claimed =
      cloudRelayEnabled() && c.req.header("X-Omnesis-Pairing-Notifications") === "1"
        ? await deps.claim(deviceId, true)
        : await deps.claim(deviceId);
    return claimed ? c.json(claimed) : c.body(null, 204);
  });

  app.post("/notifications/confirm", scope.pushClaim(), validateJson(confirmBody), async (c) => {
    const deviceId = c.get("auth").deviceId!;
    const { id } = c.req.valid("json");
    const confirmed = await deps.confirm(deviceId, id);
    if (!confirmed) throw new NotFoundError("notification lease not found");
    return c.json({ ok: true });
  });
}
