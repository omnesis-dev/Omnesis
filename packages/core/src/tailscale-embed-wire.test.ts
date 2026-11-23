// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { tailscaleDeviceNaming } from "./tailscale-embed-wire.js";

describe("how the device's name on the tailnet relates to the chosen one", () => {
  test("the chosen name, carried as chosen", () => {
    expect(tailscaleDeviceNaming("omnesis", "omnesis", "omnesis")).toBe("chosen");
    expect(tailscaleDeviceNaming("omnesis", "omnesis")).toBe("chosen");
  });

  test("a number added because another device has the name", () => {
    expect(tailscaleDeviceNaming("omnesis", "omnesis-1", "omnesis")).toBe("taken");
    expect(tailscaleDeviceNaming("home-box", "home-box-12", "home-box")).toBe("taken");
  });

  test("any other name was given in the Tailscale admin console", () => {
    expect(tailscaleDeviceNaming("omnesis", "study-server", "omnesis")).toBe("renamed");
    expect(tailscaleDeviceNaming("omnesis", "omnesis-box", "omnesis")).toBe("renamed");
    expect(tailscaleDeviceNaming("omnesis", "omnesis-", "omnesis")).toBe("renamed");
  });

  test("a name Tailscale has not yet seen is pending, whatever the device carries now", () => {
    expect(tailscaleDeviceNaming("home-box", "omnesis", "omnesis")).toBe("pending");
    // The first step of asking again for a suffixed name passes through the name it carries.
    expect(tailscaleDeviceNaming("omnesis", "omnesis-1", "omnesis-1")).toBe("pending");
    expect(tailscaleDeviceNaming("omnesis", "omnesis", "Omnesis")).toBe("chosen");
  });
});
