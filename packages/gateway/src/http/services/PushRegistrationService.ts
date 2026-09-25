// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { assertNever } from "@omnesis/core";
import { buildPushPlan } from "../../push/select-transport.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import type { PushPlan, PushPlanRequest, PushRegistration } from "@omnesis/core/push";
import type { DeviceId, DeviceRecord } from "@omnesis/types";
import type { DeviceService } from "./DeviceService.js";
import type { OmnesisConfig } from "@omnesis/config";
import type { WriteGate } from "../../write-gate.js";

export interface PushRegistrationServiceDeps {
  devices: DeviceService;
  writeGate: Pick<
    WriteGate,
    | "setDeviceApnsToken"
    | "setDeviceFcmToken"
    | "setDeviceRelayPushConsent"
    | "withdrawDeviceRelayPushConsent"
    | "setDeviceRelayPushRegistration"
  >;
  getConfig?: () => OmnesisConfig;
  getRelaySettings(): { url: string; enabled?: boolean; visible?: boolean };
  getFcmProjectId(): Promise<string | undefined>;
  onDeviceChanged(): void;
  now?: () => number;
}

/** Owns push-plan selection and validated per-device registration writes. */
export class PushRegistrationService {
  private readonly now: () => number;

  constructor(private readonly deps: PushRegistrationServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  plan(deviceId: DeviceId, request: PushPlanRequest): PushPlan {
    return this.planForDevice(this.requireDevice(deviceId), request);
  }

  /** Compute from one caller-owned snapshot, without re-reading live device state. */
  planForDevice(device: DeviceRecord, request: PushPlanRequest): PushPlan {
    this.validatePlatform(device, request);
    this.validateDeclaredIdentity(device, request, false);
    const config = this.deps.getConfig?.();
    const relay = this.deps.getRelaySettings();
    const plan = buildPushPlan(request, {
      apnsBundleId: config?.gateway?.apns?.bundleId,
      fcmAppId: config?.gateway?.fcm?.appId,
      relayUrl: relay.url,
      relayConsentAppId: device.relayConsent?.appId,
    });
    if (plan.transport === "relay") this.validateDeclaredIdentity(device, request, true);
    return plan;
  }

  async grantRelayConsent(deviceId: DeviceId, request: PushPlanRequest): Promise<void> {
    const device = this.requireDevice(deviceId);
    this.validatePlatform(device, request);
    const withoutConsent = buildPushPlan(request, {
      apnsBundleId: this.deps.getConfig?.().gateway?.apns?.bundleId,
      fcmAppId: this.deps.getConfig?.().gateway?.fcm?.appId,
      relayUrl: this.deps.getRelaySettings().url,
    });
    if (
      withoutConsent.transport !== "unavailable" ||
      withoutConsent.reasonCode !== "relay-disabled"
    ) {
      throw new BadRequestError(...this.consentRefusal(withoutConsent, request));
    }
    // The conflict decision lives in the write transaction, never on the
    // reader-side snapshot above: a hello landing in between must not flip an
    // adoption into a cross-app grant. A missing declaration predates the
    // capability and is adopted there; only a genuine conflict is refused.
    const outcome = await this.deps.writeGate.setDeviceRelayPushConsent(deviceId, {
      appId: request.appId,
      grantedAt: this.now(),
    });
    if (outcome === "identity-mismatch") {
      throw new BadRequestError("push app identity does not match the paired device", {
        reason: "identity-mismatch",
      });
    }
    if (outcome === "device-not-found") throw new NotFoundError("active phone not found");
    this.deps.onDeviceChanged();
  }

  /**
   * One refusal, one cause: the legacy single message conflated a published
   * app under direct cover with an unpublished app identity, each needing a
   * different operator action. The `reason` rides the error envelope's detail
   * so phones can tell "re-pair" from "operator config" without parsing
   * prose. The final arm is defensive for future plan variants — today's
   * probe plan cannot produce it. Statuses are unchanged, so older phones
   * behave exactly as before.
   */
  private consentRefusal(
    withoutConsent: PushPlan,
    request: PushPlanRequest,
  ): [message: string, detail: { reason: string }] {
    if (withoutConsent.transport === "direct-apns" || withoutConsent.transport === "direct-fcm") {
      return [
        `direct push already covers ${request.appId}; relay consent is not needed`,
        { reason: "direct-coverage" },
      ];
    }
    if (
      withoutConsent.transport === "unavailable" &&
      withoutConsent.reasonCode === "no-direct-credential"
    ) {
      return [
        `no push credential covers ${request.appId}; relay consent is only available for a published app without direct coverage`,
        { reason: "unpublished-app" },
      ];
    }
    return [
      "relay consent is only available for a published app without direct coverage",
      { reason: "consent-unavailable" },
    ];
  }

  async withdrawRelayConsent(deviceId: DeviceId): Promise<void> {
    this.requireDevice(deviceId);
    const written = await this.deps.writeGate.withdrawDeviceRelayPushConsent(deviceId);
    if (!written) throw new NotFoundError("device not found");
    this.deps.onDeviceChanged();
  }

  async register(deviceId: DeviceId, registration: PushRegistration): Promise<void> {
    const device = this.requireDevice(deviceId);
    switch (registration.transport) {
      case "direct-apns": {
        if (device.kind !== "ios") throw new BadRequestError("direct APNs is iOS-only");
        this.validateDeclaredIdentity(
          device,
          { platform: "ios", appId: registration.bundleId },
          false,
        );
        const covered = this.deps.getConfig?.().gateway?.apns?.bundleId;
        if (registration.bundleId !== covered) {
          throw new BadRequestError("configured APNs credential does not cover this bundle id");
        }
        await this.deps.writeGate.setDeviceApnsToken(deviceId, {
          deviceToken: registration.deviceToken,
          environment: registration.environment,
          bundleId: registration.bundleId,
          updatedAt: this.now(),
        });
        break;
      }
      case "direct-fcm": {
        if (device.kind !== "android") throw new BadRequestError("direct FCM is Android-only");
        const coveredAppId = this.deps.getConfig?.().gateway?.fcm?.appId;
        if (coveredAppId) {
          this.validateDeclaredIdentity(
            device,
            { platform: "android", appId: coveredAppId },
            false,
          );
        }
        const covered = await this.deps.getFcmProjectId();
        if (registration.projectId !== covered) {
          throw new BadRequestError("configured FCM credential does not cover this project id");
        }
        await this.deps.writeGate.setDeviceFcmToken(deviceId, {
          registrationToken: registration.registrationToken,
          updatedAt: this.now(),
        });
        break;
      }
      case "relay": {
        const relay = this.deps.getRelaySettings();
        if (registration.relayUrl !== relay.url) {
          throw new BadRequestError("relay registration does not match the configured endpoint");
        }
        const platform = device.kind === "ios" || device.kind === "android" ? device.kind : null;
        if (!platform) throw new BadRequestError("relay push is phone-only");
        const appId = device.capabilities.pushAppId;
        if (!appId || device.relayConsent?.appId !== appId) {
          throw new BadRequestError("relay push is not authorized for this device");
        }
        const request = { platform, appId } as PushPlanRequest;
        const plan = this.planForDevice(device, request);
        if (plan.transport !== "relay" || plan.relayUrl !== registration.relayUrl) {
          throw new BadRequestError("relay push is not authorized for this device");
        }
        const written = await this.deps.writeGate.setDeviceRelayPushRegistration(deviceId, {
          relayUrl: registration.relayUrl,
          credential: registration.credential,
          appId,
        });
        if (!written) {
          throw new BadRequestError("relay consent was withdrawn before registration completed");
        }
        break;
      }
      default:
        assertNever(registration);
    }
    this.deps.onDeviceChanged();
  }

  private requireDevice(id: DeviceId) {
    const device = this.deps.devices.getById(id);
    if (!device) throw new NotFoundError("device not found");
    return device;
  }

  private validatePlatform(device: DeviceRecord, request: PushPlanRequest): void {
    if (device.kind !== request.platform) {
      throw new BadRequestError(`device kind '${device.kind}' does not match ${request.platform}`);
    }
  }

  private validateDeclaredIdentity(
    device: DeviceRecord,
    request: PushPlanRequest,
    required: boolean,
  ): void {
    const declared = device.capabilities.pushAppId;
    if (
      (required && declared === undefined) ||
      (declared !== undefined && declared !== request.appId)
    ) {
      throw new BadRequestError("push app identity does not match the paired device", {
        reason: declared === undefined ? "identity-missing" : "identity-mismatch",
      });
    }
  }
}
