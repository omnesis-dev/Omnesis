// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";
import { sourceReauthFinalizeBody } from "./admin.js";

describe("reauth finalize schema", () => {
  test("preserves sourceType for member-aware dispatch", () => {
    expect(
      sourceReauthFinalizeBody.parse({
        deviceId: "device-beta",
        providerType: "mail-provider",
        accountId: "maya@example.org",
        sourceType: "mail-synth",
      }),
    ).toEqual({
      deviceId: "device-beta",
      providerType: "mail-provider",
      accountId: "maya@example.org",
      sourceType: "mail-synth",
    });
  });

  test("continues accepting older clients that omit sourceType", () => {
    expect(
      sourceReauthFinalizeBody.parse({
        providerType: "mail-provider",
        accountId: "maya@example.org",
      }),
    ).toEqual({
      providerType: "mail-provider",
      accountId: "maya@example.org",
    });
  });
});
