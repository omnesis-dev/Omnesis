// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from "vitest";

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return {
    ...actual,
    gatewayJson: vi.fn(),
    gatewayFetch: vi.fn(),
    buildCliFx: () => Promise.resolve({}),
    iconFor: () => "",
    withSpinner: (_label: string, operation: () => unknown) => operation(),
  };
});

import { gatewayFetch, gatewayJson } from "../utils.js";
import { renderSyncDispatch, syncCommand } from "./sync.js";

const names: Record<string, string> = {
  "dev-laptop": "Maya-Laptop",
  "dev-mini": "Studio-Mini",
  "dev-phone": "Maya-Phone",
};
const deviceName = (id: string): string => names[id] ?? id;

const source = {
  id: "notes-synth:local",
  type: "notes-synth",
  accountId: "local",
  deviceId: "dev-laptop",
  enabled: true,
  members: ["dev-laptop", "dev-mini", "dev-phone"],
  leaseHolder: null as string | null,
};

describe("renderSyncDispatch", () => {
  test("a single target is named on the line", () => {
    expect(
      renderSyncDispatch({ ok: true, deviceId: "dev-mini" }, source, deviceName, "ID"),
    ).toEqual(["Sync sent to Studio-Mini: ID"]);
  });

  test("without a deviceId the lease holder, then the owner, stands in", () => {
    expect(
      renderSyncDispatch({ ok: true }, { ...source, leaseHolder: "dev-mini" }, deviceName, "ID"),
    ).toEqual(["Sync sent to Studio-Mini: ID"]);
    expect(renderSyncDispatch({ ok: true }, source, deviceName, "ID")).toEqual([
      "Sync sent to Maya-Laptop: ID",
    ]);
  });

  test("a fan-out lists every member: reached, failed, skipped, offline", () => {
    const lines = renderSyncDispatch(
      {
        ok: true,
        results: [
          { deviceId: "dev-laptop", ok: true, triggered: 1, skipped: 0, disabled: 0 },
          { deviceId: "dev-mini", ok: false, error: "engine busy" },
          { deviceId: "dev-phone", ok: true, triggered: 0, skipped: 1, disabled: 0 },
        ],
      },
      { ...source, members: [...source.members, "dev-away"] },
      deviceName,
      "ID",
    );
    expect(lines).toEqual([
      "Sync sent: ID",
      "  ✓ Maya-Laptop",
      "  ✗ Studio-Mini: engine busy",
      "  – Maya-Phone skipped",
      "  – dev-away offline",
    ]);
  });
});

describe("sources sync", () => {
  let logged: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    logged = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      logged.push(line);
    });
    (gatewayJson as Mock).mockImplementation((path: string): Promise<unknown> => {
      if (path === "/admin/sources") return Promise.resolve({ items: [source] });
      if (path === "/admin/devices") {
        return Promise.resolve({
          items: Object.entries(names).map(([id, name]) => ({ id, name })),
        });
      }
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("POSTs the sync and names the device the gateway sent it to", async () => {
    (gatewayFetch as Mock).mockResolvedValue(
      new Response(JSON.stringify({ ok: true, deviceId: "dev-mini", result: { ok: true } }), {
        status: 200,
      }),
    );
    await (syncCommand as { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }).run({
      args: { _: ["notes-synth:"], wait: false, timeout: "300" },
    });
    expect((gatewayJson as Mock).mock.calls.map(([p]) => p)).toEqual([
      "/admin/sources",
      "/admin/devices",
    ]);
    expect(gatewayFetch).toHaveBeenCalledWith("/admin/sources/notes-synth%3Alocal/sync", {
      method: "POST",
    });
    expect(logged).toEqual(["Sync sent to Studio-Mini: notes-synth:local"]);
  });
});

describe("renderSyncDispatch reads a single target's answer", () => {
  test("a target that answered without starting is reported as skipped, not sent", () => {
    expect(
      renderSyncDispatch(
        { ok: true, deviceId: "dev-mini", result: { ok: true, triggered: 0, skipped: 1 } },
        source,
        deviceName,
        "ID",
      ),
    ).toEqual(["Sync skipped; Studio-Mini was already syncing: ID"]);
  });

  test("a target where the source is paused says so", () => {
    expect(
      renderSyncDispatch(
        { ok: true, deviceId: "dev-mini", result: { ok: true, triggered: 0, disabled: 1 } },
        source,
        deviceName,
        "ID",
      ),
    ).toEqual(["Sync skipped; the source is paused on Studio-Mini: ID"]);
  });

  test("an answer that started the sync, or carries no counts, is sent", () => {
    expect(
      renderSyncDispatch(
        { ok: true, deviceId: "dev-mini", result: { ok: true, triggered: 1, skipped: 0 } },
        source,
        deviceName,
        "ID",
      ),
    ).toEqual(["Sync sent to Studio-Mini: ID"]);
    expect(
      renderSyncDispatch(
        { ok: true, deviceId: "dev-mini", result: { ok: true } },
        source,
        deviceName,
        "ID",
      ),
    ).toEqual(["Sync sent to Studio-Mini: ID"]);
  });
});
