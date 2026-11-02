// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { collectorHostname, deviceNameHost, hostNameStem } from "./collector-hostname.js";

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

describe("hostNameStem", () => {
  test.each([
    ["Maya-MacBook-Air.local", "maya-macbook-air"],
    ["field-station", "field-station"],
    ["Studio_Northstar.example.com", "studio-northstar"],
    ["--edge--", "edge"],
    ["Jamie's Mac", "jamie-s-mac"],
    ["", ""],
    [".local", ""],
  ])("%s reads %s, the Docker installer's rule", (raw, stem) => {
    expect(hostNameStem(raw)).toBe(stem);
  });

  test("keeps at most 63 characters, without a trailing hyphen", () => {
    expect(hostNameStem(`${"a".repeat(62)}-b`)).toBe("a".repeat(62));
  });
});

describe("deviceNameHost", () => {
  test("is the stem of the system hostname: no mDNS suffix, no capitals", () => {
    expect(deviceNameHost({}, () => "Maya-MacBook-Air.local")).toBe("maya-macbook-air");
  });

  test("is the override as given", () => {
    expect(
      deviceNameHost({ OMNESIS_COLLECTOR_HOSTNAME: "Studio-Northstar" }, () => "gateway"),
    ).toBe("Studio-Northstar");
  });

  test("falls back to the raw hostname when nothing of it survives", () => {
    expect(deviceNameHost({}, () => "...")).toBe("...");
  });
});
