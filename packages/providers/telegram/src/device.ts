// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { release, type } from "node:os";
import { readPackageVersion } from "@omnesis/core";
import type { DeviceInfo } from "./client/types.js";

/**
 * What this host tells Telegram about itself, which the operator sees in
 * Settings → Devices. Honest and minimal: the product, the OS, the version. No
 * hostname, and never the word "Telegram" in the device or app name, which the
 * API terms reserve.
 */
export function telegramDeviceInfo(): DeviceInfo {
  return {
    deviceModel: "Omnesis",
    systemVersion: `${type()} ${release()}`,
    appVersion: readPackageVersion(import.meta.url),
    langCode: "en",
  };
}
