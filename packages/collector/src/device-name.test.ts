// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { hostname as osHostname } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { collectorDeviceName } from "./device-name.js";

describe("collectorDeviceName", () => {
  const original = process.env.OMNESIS_COLLECTOR_HOSTNAME;

  afterEach(() => {
    if (original === undefined) delete process.env.OMNESIS_COLLECTOR_HOSTNAME;
    else process.env.OMNESIS_COLLECTOR_HOSTNAME = original;
  });

  it("defaults to the machine hostname with a -collector suffix", () => {
    delete process.env.OMNESIS_COLLECTOR_HOSTNAME;
    expect(collectorDeviceName()).toBe(`${osHostname()}-collector`);
  });

  it("honours the OMNESIS_COLLECTOR_HOSTNAME override", () => {
    process.env.OMNESIS_COLLECTOR_HOSTNAME = "Johns-MacBook-Pro";
    expect(collectorDeviceName()).toBe("Johns-MacBook-Pro-collector");
  });

  it("falls back to the hostname when the override is blank", () => {
    process.env.OMNESIS_COLLECTOR_HOSTNAME = "   ";
    expect(collectorDeviceName()).toBe(`${osHostname()}-collector`);
  });
});
