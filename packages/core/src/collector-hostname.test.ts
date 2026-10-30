// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { collectorHostname } from "./collector-hostname.js";

describe("collectorHostname", () => {
  const system = () => "gateway";

  test("is the system hostname by default", () => {
    expect(collectorHostname({}, system)).toBe("gateway");
  });

  // In a combined docker container the system hostname is `gateway`; the installer tells
  // its collector the host's name.
  test("is the override when one is set", () => {
    expect(collectorHostname({ OMNESIS_COLLECTOR_HOSTNAME: " studio-northstar " }, system)).toBe(
      "studio-northstar",
    );
  });

  test("ignores a blank override", () => {
    expect(collectorHostname({ OMNESIS_COLLECTOR_HOSTNAME: "  " }, system)).toBe("gateway");
  });
});
