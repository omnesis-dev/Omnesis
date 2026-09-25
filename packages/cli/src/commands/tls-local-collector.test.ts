// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";

import { reconnectLocalCollector, type LocalCollectorDeps } from "./tls-local-collector.js";
import type { ServiceDefinitionOutcome } from "../update/service-definitions.js";

function deps(outcome: ServiceDefinitionOutcome | Error, installed = true) {
  const updater = {
    refresh: vi.fn(() =>
      outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome),
    ),
    loadDefinition: vi.fn(() => Promise.resolve(true)),
    reload: vi.fn(() => Promise.resolve()),
  };
  const value: LocalCollectorDeps = { installed: () => installed, updater };
  return { value, updater };
}

describe("reconnectLocalCollector", () => {
  it("rewrites a unit that dials a name the new certificate does not cover, then restarts it", async () => {
    const { value, updater } = deps({ kind: "replaced" });
    const lines = await reconnectLocalCollector(true, value);
    expect(updater.refresh).toHaveBeenCalledWith("collector");
    expect(updater.loadDefinition).toHaveBeenCalledWith("collector");
    expect(updater.reload).toHaveBeenCalledWith("collector");
    expect(lines.join("\n")).toMatch(/Restarted the collector on this machine/);
  });

  it("restarts an unchanged unit when the address it reads from .env changed", async () => {
    const { value, updater } = deps({ kind: "unchanged" });
    await reconnectLocalCollector(true, value);
    expect(updater.loadDefinition).not.toHaveBeenCalled();
    expect(updater.reload).toHaveBeenCalledWith("collector");
  });

  it("leaves a collector alone when neither its unit nor its address changed", async () => {
    const { value, updater } = deps({ kind: "unchanged" });
    expect(await reconnectLocalCollector(false, value)).toEqual([]);
    expect(updater.reload).not.toHaveBeenCalled();
  });

  it("does nothing on a machine with no collector service", async () => {
    const { value, updater } = deps({ kind: "replaced" }, false);
    expect(await reconnectLocalCollector(true, value)).toEqual([]);
    expect(updater.refresh).not.toHaveBeenCalled();
  });

  it("says what to do, without restarting, when the unit cannot be regenerated", async () => {
    const { value, updater } = deps({ kind: "refused", reason: "drop-ins change it (x.conf)" });
    const lines = await reconnectLocalCollector(true, value);
    expect(updater.reload).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("drop-ins change it");
    expect(lines.join("\n")).toContain("omnesis service install collector");
  });

  it("reports a failed restart instead of failing the provisioning", async () => {
    const { value } = deps(new Error("systemctl exited 1"));
    const lines = await reconnectLocalCollector(true, value);
    expect(lines.join("\n")).toContain("systemctl exited 1");
    expect(lines.join("\n")).toContain("omnesis service restart collector");
  });
});
