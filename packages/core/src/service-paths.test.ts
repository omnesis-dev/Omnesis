// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  launchdLabel,
  launchdLabelInstance,
  systemdUnitInstance,
  systemdUnitName,
} from "./service-paths.js";

describe("launchdLabelInstance", () => {
  test("reads the default and a named instance back from the labels launchdLabel writes", () => {
    expect(launchdLabelInstance("collector", launchdLabel("collector"))).toEqual({});
    expect(launchdLabelInstance("collector", launchdLabel("collector", "staging-2"))).toEqual({
      instance: "staging-2",
    });
  });

  test("refuses another component's label, a foreign label and an invalid instance", () => {
    expect(launchdLabelInstance("collector", launchdLabel("gateway"))).toBeNull();
    expect(launchdLabelInstance("collector", "com.example.agent")).toBeNull();
    expect(launchdLabelInstance("collector", "dev.omnesis.collector.")).toBeNull();
    expect(launchdLabelInstance("collector", "dev.omnesis.collector.a.b")).toBeNull();
    expect(launchdLabelInstance("collector", "dev.omnesis.collectorx")).toBeNull();
    expect(launchdLabelInstance("collector", "0")).toBeNull();
  });
});

describe("systemdUnitInstance", () => {
  test("reads the default and a named instance back from the names systemdUnitName writes", () => {
    expect(systemdUnitInstance("collector", systemdUnitName("collector"))).toEqual({});
    expect(systemdUnitInstance("collector", systemdUnitName("collector", "staging-2"))).toEqual({
      instance: "staging-2",
    });
  });

  test("refuses another component's unit, a foreign unit and an invalid instance", () => {
    expect(systemdUnitInstance("collector", systemdUnitName("gateway"))).toBeNull();
    expect(systemdUnitInstance("collector", "gnome-terminal-server.service")).toBeNull();
    expect(systemdUnitInstance("collector", "omnesis-collector-.service")).toBeNull();
    expect(systemdUnitInstance("collector", "omnesis-collector-a.b.service")).toBeNull();
    expect(systemdUnitInstance("collector", "omnesis-update-lock1.service")).toBeNull();
    expect(systemdUnitInstance("collector", "omnesis-collector.scope")).toBeNull();
  });
});
