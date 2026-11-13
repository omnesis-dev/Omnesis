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

const DEVICE_ENROLLMENT_WEB_CLIENT_ID =
  "69746762909-e65hukbm0nqrntk71qc0prslr9eg6gik.apps.googleusercontent.com";
const ANDROID_RELEASE_CLIENT_ID =
  "69746762909-3lnneuvft93ud5ssdppe19tc7fol4aku.apps.googleusercontent.com";
/**
 * Android OAuth client bound to the operator's debug signing certificate (Android test build).
 * Google only issues tokens presented by this client to apps signed with that certificate.
 */
const ANDROID_TEST_BUILD_CLIENT_ID =
  "69746762909-sb5de515284geor9ui6vg7hsl4qsrg53.apps.googleusercontent.com";

/**
 * The Google OAuth apps whose tokens a gateway accepts for managed sign-in. These are public
 * identifiers compiled into the gateway, never configuration and never taken from the relay.
 * They only name which Google apps may present a token: the gateway still verifies Google's
 * signature, issuer, audience, presenter and nonce itself.
 */
export const OFFICIAL_GOOGLE_BROWSER_TRUST: GoogleBrowserTrust = Object.freeze({
  ownerLinkClientId: "69746762909-7vc7i6efbbig530e20gtaa83076q02l2.apps.googleusercontent.com",
  deviceEnrollmentClientId: DEVICE_ENROLLMENT_WEB_CLIENT_ID,
  deviceClientIds: Object.freeze([
    DEVICE_ENROLLMENT_WEB_CLIENT_ID,
    "69746762909-luas0k1rpi7nvn2ee0bogfu2vfha34si.apps.googleusercontent.com",
    "69746762909-071jh21ngi85ne01k4oe5krfng2frmhr.apps.googleusercontent.com",
    "69746762909-qc4prr14sagtienhn36lhmp7rthno16a.apps.googleusercontent.com",
    ANDROID_RELEASE_CLIENT_ID,
  ]),
  deviceAuthorizedParties: Object.freeze([ANDROID_RELEASE_CLIENT_ID, ANDROID_TEST_BUILD_CLIENT_ID]),
});
const clientId = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9._-]+$/);
const clients = z.array(clientId).max(16);

/**
 * Normalizes a trust registry: the enrollment client is a device audience, every audience may
 * present its own token, and the owner-link client never doubles as a device audience or presenter.
 * Tests pass synthetic registries; production uses the compiled-in official one.
 */
export function googleBrowserTrust(
  configured: GoogleBrowserTrust = OFFICIAL_GOOGLE_BROWSER_TRUST,
): GoogleBrowserTrust {
  try {
    const owner =
      configured.ownerLinkClientId === undefined
        ? undefined
        : clientId.parse(configured.ownerLinkClientId);
    const device =
      configured.deviceEnrollmentClientId === undefined
        ? undefined
        : clientId.parse(configured.deviceEnrollmentClientId);
    const deviceClientIds = clients.parse([
      ...new Set([...configured.deviceClientIds, ...(device === undefined ? [] : [device])]),
    ]);
    const deviceAuthorizedParties = clients.parse([
      ...new Set([...deviceClientIds, ...configured.deviceAuthorizedParties]),
    ]);
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
    // Do not reflect malformed registry or discovery contents into gateway logs.
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
