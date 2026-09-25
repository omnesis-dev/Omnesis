// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { assertNever } from "@omnesis/core";
import { PUBLISHED_PUSH_APP_IDS, type PushPlan, type PushPlanRequest } from "@omnesis/core/push";
import type { DeviceRecord } from "@omnesis/types";

export type SelectedPushTransport =
  | { transport: "socket" }
  | { transport: "direct-apns"; registration: NonNullable<DeviceRecord["apnsRegistration"]> }
  | { transport: "direct-fcm"; registration: NonNullable<DeviceRecord["fcmRegistration"]> }
  | { transport: "relay"; relayUrl: string; credential: string }
  | { transport: "unavailable"; reason: string };

export function selectPushTransport(
  device: DeviceRecord,
  options: { socketConnected: boolean; relayUrl?: string },
): SelectedPushTransport {
  if (options.socketConnected) return { transport: "socket" };

  switch (device.pushTransport) {
    case "direct-apns":
      return device.apnsRegistration
        ? { transport: "direct-apns", registration: device.apnsRegistration }
        : { transport: "unavailable", reason: "APNs registration is missing" };
    case "direct-fcm":
      return device.fcmRegistration
        ? { transport: "direct-fcm", registration: device.fcmRegistration }
        : { transport: "unavailable", reason: "FCM registration is missing" };
    case "relay":
      if (!device.relayConsent) {
        return { transport: "unavailable", reason: "relay consent is missing" };
      }
      if (
        device.capabilities.pushAppId !== undefined &&
        device.capabilities.pushAppId !== device.relayConsent.appId
      ) {
        return { transport: "unavailable", reason: "relay consent covers a different app" };
      }
      if (options.relayUrl !== undefined && device.relayUrl !== options.relayUrl) {
        return {
          transport: "unavailable",
          reason: "relay registration does not match the configured endpoint",
        };
      }
      return device.relayUrl && device.relayCredential
        ? {
            transport: "relay",
            relayUrl: device.relayUrl,
            credential: device.relayCredential,
          }
        : { transport: "unavailable", reason: "relay registration is incomplete" };
    case "socket":
      return { transport: "unavailable", reason: "device socket is offline" };
    case null:
      return { transport: "unavailable", reason: "push is not registered" };
    default:
      return assertNever(device.pushTransport);
  }
}

export function buildPushPlan(
  request: PushPlanRequest,
  options: {
    apnsBundleId?: string;
    fcmAppId?: string;
    relayUrl?: string;
    relayConsentAppId?: string;
  },
): PushPlan {
  if (request.platform === "ios" && request.appId === options.apnsBundleId) {
    return { transport: "direct-apns" };
  }
  if (request.platform === "android" && request.appId === options.fcmAppId) {
    return { transport: "direct-fcm" };
  }

  const published = (PUBLISHED_PUSH_APP_IDS[request.platform] as readonly string[]).includes(
    request.appId,
  );
  if (published && options.relayConsentAppId === request.appId && options.relayUrl) {
    return { transport: "relay", relayUrl: options.relayUrl };
  }
  if (published && options.relayConsentAppId !== request.appId) {
    return {
      transport: "unavailable",
      reasonCode: "relay-disabled",
      reason: "relay notifications are not authorized for this device",
    };
  }
  if (published) {
    return {
      transport: "unavailable",
      reasonCode: "relay-url-unavailable",
      reason: "relay URL is unavailable",
    };
  }
  return {
    transport: "unavailable",
    reasonCode: "no-direct-credential",
    reason: `no push credential covers ${request.appId}`,
  };
}
