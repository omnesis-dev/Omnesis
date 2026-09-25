// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { BadGatewayError, HttpError } from "../errors.js";
import type { DeviceRecord } from "@omnesis/types";
import type { WsResponsePayload } from "@omnesis/core";
import type { SourceRecord } from "../../data/repositories/SourceRepository.js";
import type { DeviceWsServer } from "../../ws.js";

interface JoinDescriptor {
  id: string;
  hasDiscover: boolean;
  params?: unknown[];
}

interface AvailabilityProofParam {
  name: string;
  required: boolean;
}

function availabilityProofParams(
  descriptor: JoinDescriptor,
  accountId: string,
): AvailabilityProofParam[] | null {
  if (!Array.isArray(descriptor.params)) return [];
  const params: AvailabilityProofParam[] = [];
  for (const candidate of descriptor.params) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const param = candidate as Record<string, unknown>;
    if (
      typeof param.name === "string" &&
      param.scope === "member" &&
      param.type === "path" &&
      param.provesLocalAvailabilityForAccount === accountId
    ) {
      if (param.required !== undefined && typeof param.required !== "boolean") return null;
      params.push({ name: param.name, required: param.required === true });
    }
  }
  return params;
}

/**
 * Prove that an online collector can discover the exact account of a source
 * before an operator adds it as a member. Source-type capabilities do not
 * carry account or host-local store availability.
 */
export async function assertSourceJoinDiscoverable(
  source: SourceRecord,
  device: DeviceRecord,
  ws: DeviceWsServer | undefined,
  memberConfig?: Record<string, unknown>,
): Promise<void> {
  if (!ws?.isConnected(device.id)) return;

  let descriptors: WsResponsePayload<"source.descriptors">;
  try {
    descriptors = await ws.sendCommand(device.id, "source.descriptors", {}, 5_000);
  } catch {
    throw new BadGatewayError(
      `Could not verify whether device "${device.name}" can join ${source.id}; retry when its collector is reachable`,
    );
  }

  const descriptor = descriptors.descriptors.find(
    (entry): entry is JoinDescriptor =>
      typeof entry === "object" &&
      entry !== null &&
      "id" in entry &&
      entry.id === source.type &&
      "hasDiscover" in entry &&
      typeof entry.hasDiscover === "boolean",
  );
  if (!descriptor) {
    throw new HttpError(
      409,
      "SOURCE_TYPE_NOT_AVAILABLE_ON_DEVICE",
      `Device "${device.name}" no longer offers source type "${source.type}"; refresh devices or update its collector`,
      { sourceType: source.type, deviceId: device.id },
    );
  }
  if (!descriptor.hasDiscover) return;

  const configuredParams = memberConfig?.params;
  const proofParams = availabilityProofParams(descriptor, String(source.accountId));
  if (
    configuredParams &&
    typeof configuredParams === "object" &&
    !Array.isArray(configuredParams) &&
    proofParams !== null &&
    proofParams.length > 0
  ) {
    let hasValidProof = false;
    let missingRequiredProof = false;
    for (const param of proofParams) {
      const value = (configuredParams as Record<string, unknown>)[param.name];
      if (value === undefined) {
        missingRequiredProof ||= param.required;
        continue;
      }
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new HttpError(
          409,
          "SOURCE_MEMBER_CONFIG_INVALID_ON_DEVICE",
          `The member-local configuration for ${source.type} is not valid on device "${device.name}"`,
          { sourceType: source.type, deviceId: device.id, paramName: param.name },
        );
      }
      let validation: WsResponsePayload<"source.validate-param">;
      try {
        validation = await ws.sendCommand(
          device.id,
          "source.validate-param",
          { descriptorId: source.type, paramName: param.name, value },
          10_000,
        );
      } catch {
        throw new BadGatewayError(
          `Could not validate member-local configuration for ${source.type} on device "${device.name}"; retry after checking that collector`,
        );
      }
      if (!validation.valid) {
        throw new HttpError(
          409,
          "SOURCE_MEMBER_CONFIG_INVALID_ON_DEVICE",
          validation.error ??
            `The member-local configuration for ${source.type} is not valid on device "${device.name}"`,
          { sourceType: source.type, deviceId: device.id, paramName: param.name },
        );
      }
      hasValidProof = true;
    }
    if (hasValidProof && !missingRequiredProof) return;
  }

  let accounts: string[];
  try {
    const result = await ws.sendCommand(
      device.id,
      "source.discover",
      { descriptorId: source.type },
      30_000,
    );
    accounts = result.accounts;
  } catch {
    throw new BadGatewayError(
      `Could not check the accounts available for ${source.type} on device "${device.name}"; retry after checking that collector`,
    );
  }
  if (accounts.includes(String(source.accountId))) return;

  throw new HttpError(
    409,
    "SOURCE_ACCOUNT_NOT_AVAILABLE_ON_DEVICE",
    `Device "${device.name}" does not have the account configured for ${source.id}; choose a device where that account is available`,
    { sourceType: source.type, deviceId: device.id },
  );
}
