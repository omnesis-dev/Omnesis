// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import { BadRequestError, ForbiddenError, NotFoundError } from "../errors.js";
import type { MobilePermissionHealthReport } from "@omnesis/types/mobile-permission-health";
import type { DeviceId, SourceId } from "@omnesis/types";
import type { WriteGate } from "../../write-gate.js";
import type { SourcePermissionNotifier } from "../../push/producers/source-permission.js";

const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60_000;
const log = createLogger("gateway:http:mobile-permission-health");

export interface MobilePermissionHealthServiceOptions {
  writeGate: Pick<WriteGate, "replaceMobilePermissionHealth">;
  notifier?: Pick<SourcePermissionNotifier, "notify">;
  now?: () => number;
}

export class MobilePermissionHealthService {
  private readonly now: () => number;

  constructor(private readonly options: MobilePermissionHealthServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  async report(callerDeviceId: DeviceId, sourceId: SourceId, report: MobilePermissionHealthReport) {
    const receivedAt = this.now();
    if (report.checkedAt > receivedAt + MAX_FUTURE_CLOCK_SKEW_MS)
      throw new BadRequestError("checkedAt is too far in the future");
    const result = await this.options.writeGate.replaceMobilePermissionHealth({
      sourceId,
      deviceId: callerDeviceId,
      report,
      receivedAt,
    });
    if ("rejection" in result) {
      if (result.rejection === "source-not-found") throw new NotFoundError("source not found");
      if (result.rejection === "wrong-device")
        throw new ForbiddenError("a phone may report only its own source health");
      if (result.rejection === "source-paused") throw new BadRequestError("source is paused");
      if (result.rejection === "report-expired")
        throw new BadRequestError("permission health report is already expired");
      throw new BadRequestError("permission health is phone-only");
    }
    if (result.accepted) {
      try {
        await this.options.notifier?.notify(sourceId);
      } catch (error) {
        log.warn(
          `permission-health notification follow-up for ${sourceId} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return result;
  }
}
