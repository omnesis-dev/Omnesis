// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { resolveRelaySettings } from "./relay-settings.js";

describe("resolveRelaySettings", () => {
  test("preserves an explicit legacy setting alongside the configured origin", () => {
    expect(
      resolveRelaySettings({
        gateway: { pushRelay: { enabled: true, url: "https://relay.example.com" } },
      }),
    ).toEqual({ enabled: true, url: "https://relay.example.com", visible: true });
  });

  test("defaults the legacy setting to false while keeping the origin discoverable", () => {
    expect(resolveRelaySettings({})).toEqual({
      enabled: false,
      url: "https://push.omnesis.app",
      visible: true,
    });
  });
});
