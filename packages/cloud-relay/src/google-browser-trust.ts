// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { googleBrowserConfigSchema, type GoogleBrowserConfig } from "./google-browser-contract.js";

export interface GoogleBrowserTrust {
  readonly ownerLinkClientId?: string;
  readonly deviceEnrollmentClientId?: string;
  readonly deviceClientIds: readonly string[];
  readonly deviceAuthorizedParties: readonly string[];
}

/** Public deployment IDs belong in the installation, independently of the relay's discovery response. */
export const DEFAULT_GOOGLE_BROWSER_TRUST: GoogleBrowserTrust = Object.freeze({
  deviceClientIds: Object.freeze([] as string[]),
  deviceAuthorizedParties: Object.freeze([] as string[]),
});
const clientId = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9._-]+$/);
const clients = z.array(clientId).max(16);

function list(value: string | undefined, fallback: readonly string[]): string[] {
  return value === undefined
    ? [...fallback]
    : clients.parse(z.string().max(8192).parse(value).split(","));
}

/** Operator overrides contain only public IDs. Missing deployment IDs leave managed OAuth disabled. */
export function googleBrowserTrust(env: NodeJS.ProcessEnv): GoogleBrowserTrust {
  try {
    const defaults = DEFAULT_GOOGLE_BROWSER_TRUST;
    const ownerLinkClientId =
      env.OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_OWNER_CLIENT_ID ?? defaults.ownerLinkClientId;
    const deviceEnrollmentClientId =
      env.OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_DEVICE_CLIENT_ID ?? defaults.deviceEnrollmentClientId;
    const deviceClientIds = clients.parse([
      ...new Set([
        ...list(
          env.OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_DEVICE_NATIVE_CLIENT_IDS,
          defaults.deviceClientIds,
        ),
        ...(deviceEnrollmentClientId === undefined ? [] : [deviceEnrollmentClientId]),
      ]),
    ]);
    const deviceAuthorizedParties = clients.parse([
      ...new Set([
        ...deviceClientIds,
        ...list(
          env.OMNESIS_CLOUD_RELAY_GOOGLE_BROWSER_DEVICE_AUTHORIZED_PARTIES,
          defaults.deviceAuthorizedParties,
        ),
      ]),
    ]);
    const owner = ownerLinkClientId === undefined ? undefined : clientId.parse(ownerLinkClientId);
    const device =
      deviceEnrollmentClientId === undefined ? undefined : clientId.parse(deviceEnrollmentClientId);
    if (
      owner !== undefined &&
      (deviceClientIds.includes(owner) || deviceAuthorizedParties.includes(owner))
    )
      throw new Error();
    return Object.freeze({
      ...(owner === undefined ? {} : { ownerLinkClientId: owner }),
      ...(device === undefined ? {} : { deviceEnrollmentClientId: device }),
      deviceClientIds: Object.freeze(deviceClientIds),
      deviceAuthorizedParties: Object.freeze(deviceAuthorizedParties),
    });
  } catch {
    // Do not reflect malformed operator configuration or discovery contents into gateway logs.

    throw new Error("Managed Google audience trust configuration is invalid");
  }
}

/** Discovery may reduce availability; it cannot add a Google audience or authorized presenter. */
export function trustedGoogleBrowserConfiguration(
  input: unknown,
  trust: GoogleBrowserTrust,
): GoogleBrowserConfig {
  try {
    const config = googleBrowserConfigSchema.parse(input);
    if (
      (config.ownerLinkClientId !== undefined &&
        config.ownerLinkClientId !== trust.ownerLinkClientId) ||
      (config.deviceEnrollmentClientId !== undefined &&
        config.deviceEnrollmentClientId !== trust.deviceEnrollmentClientId) ||
      config.deviceClientIds.some((id) => !trust.deviceClientIds.includes(id)) ||
      config.deviceAuthorizedParties.some((id) => !trust.deviceAuthorizedParties.includes(id)) ||
      (config.deviceEnrollmentClientId !== undefined &&
        (!config.deviceClientIds.includes(config.deviceEnrollmentClientId) ||
          !config.deviceAuthorizedParties.includes(config.deviceEnrollmentClientId)))
    )
      throw new Error();
    return config;
  } catch {
    throw new Error("Managed Google discovery does not match trusted deployment audiences");
  }
}
