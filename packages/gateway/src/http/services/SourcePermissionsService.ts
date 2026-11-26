// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  sourcePermissionScopeDigest,
  parseSourceKey,
  type SourcePermissionsRequest,
  type SourcePermissionsResponse,
} from "@omnesis/core";
import { DeviceId, SourceId } from "@omnesis/types";
import {
  BadGatewayError,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
} from "../errors.js";
import type { DeviceWsServer } from "../../ws.js";
import type { DeviceService } from "./DeviceService.js";
import type { SourceService } from "./SourceService.js";

/** Scope checks precede the fixed collector command; the gateway never probes local provider files. */
export class SourcePermissionsService {
  constructor(
    private readonly sources: Pick<SourceService, "settingsForAdmin">,
    private readonly devices: Pick<DeviceService, "getById">,
    private readonly sockets: Pick<DeviceWsServer, "sendCommand"> | undefined,
  ) {}
  async check(
    deviceId: string,
    input: SourcePermissionsRequest,
  ): Promise<SourcePermissionsResponse & { deviceId: string }> {
    const device = this.devices.getById(DeviceId(deviceId));
    if (!device || device.revokedAt !== null)
      throw new ForbiddenError("The collection computer is unavailable or needs pairing");
    let accountId = input.accountId;
    let params: unknown = input.params ?? {};
    if (input.sourceId) {
      if (input.params !== undefined)
        throw new BadRequestError(
          "Configured access uses stored settings; omit candidate parameters",
        );
      const source = this.sources.settingsForAdmin(SourceId(input.sourceId), DeviceId(deviceId));
      if (!source) throw new NotFoundError("The source is not hosted by this computer");
      accountId = String(source.source.accountId);
      params = source.source.config.params ?? {};
      if (
        String(parseSourceKey(input.sourceId).sourceType) !== input.descriptorId ||
        (input.accountId !== undefined && input.accountId !== source.source.accountId)
      ) {
        throw new BadRequestError("Permission scope does not match the configured source");
      }
    }
    const expectedScopeDigest = sourcePermissionScopeDigest(input.descriptorId, accountId, params);
    if (device.capabilities.sourcePermissions !== true)
      return {
        deviceId,
        descriptorId: input.descriptorId,
        ...(input.sourceId ? { sourceId: input.sourceId } : {}),
        checkedAt: new Date().toISOString(),
        scopeDigest: expectedScopeDigest,
        status: "unsupported",
        target: "unverified",
      };
    if (!this.sockets) throw new ServiceUnavailableError("The collection computer is unavailable");
    const payload = { ...input, ...(accountId ? { accountId } : {}), expectedScopeDigest };
    const result = await this.sockets.sendCommand(
      DeviceId(deviceId),
      "source.permissions",
      payload,
      25_000,
    );
    if (result.descriptorId !== input.descriptorId || result.sourceId !== input.sourceId)
      throw new BadGatewayError("Permission response does not match the requested source");
    if (result.scopeDigest !== expectedScopeDigest)
      throw new ServiceUnavailableError("Collection access is awaiting current source settings");
    return { ...result, deviceId };
  }
}
