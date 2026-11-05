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
import { renderSyncDispatch, syncCommand, type SyncDispatchBody } from "./sync.js";

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
    vi.spyOn(console, "log").mockImplementation((line: string = "") => {
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
    vi.useRealTimers();
  });

  test.each([
    { state: "synced", succeeds: true },
    { state: "error", succeeds: false },
    { state: "needs-auth", succeeds: false },
  ])(
    "an acknowledged running sync ends as $state before the first poll",
    async ({ state, succeeds }) => {
      vi.useFakeTimers();
      (gatewayFetch as Mock).mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            deviceId: "dev-mini",
            result: { ok: true, triggered: 0, skipped: 1, alreadySyncing: 1 },
          }),
        ),
      );
      (gatewayJson as Mock)
        .mockResolvedValueOnce({ items: [source] })
        .mockResolvedValueOnce({ items: [] })
        .mockResolvedValueOnce({ stats: { [source.id]: { documentCount: 3 } } })
        .mockResolvedValueOnce({
          items: [{ sourceId: source.id, state, errorMessage: "sync failed" }],
        })
        .mockResolvedValueOnce({ stats: { [source.id]: { documentCount: 3 } } });
      const run = syncCommand.run!({ args: { _: [source.id], wait: true, timeout: "5" } } as never);
      if (succeeds) await expect(run).resolves.toBeUndefined();
      else await expect(run).rejects.toThrow("did not sync successfully");
      expect(logged.some((line) => line.includes("Timed out"))).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  test.each<{ label: string; body: SyncDispatchBody }>([
    { label: "a newly triggered sync", body: { ok: true, result: { ok: true, triggered: 1 } } },
    {
      label: "a legacy skipped reply",
      body: { ok: true, result: { ok: true, triggered: 0, skipped: 1 } },
    },
    {
      label: "a push-only source",
      body: { ok: true, result: { ok: true, triggered: 0, skipped: 1, alreadySyncing: 0 } },
    },
    {
      label: "a paused source",
      body: { ok: true, result: { ok: true, triggered: 0, disabled: 1, alreadySyncing: 0 } },
    },
    {
      label: "a mixed fan-out",
      body: {
        ok: true,
        results: [
          { deviceId: "dev-mini", ok: true, triggered: 0, alreadySyncing: 1 },
          { deviceId: "dev-laptop", ok: true, triggered: 1 },
        ],
      },
    },
  ])("$label cannot accept a stale terminal result", async ({ body }) => {
    vi.useFakeTimers();
    (gatewayFetch as Mock).mockResolvedValue(new Response(JSON.stringify(body)));
    (gatewayJson as Mock).mockImplementation((path: string) => {
      if (path === "/admin/sources") return Promise.resolve({ items: [source] });
      if (path === "/admin/devices") return Promise.resolve({ items: [] });
      if (path === "/documents/stats") return Promise.resolve({ stats: {} });
      if (path === "/admin/sync/status")
        return Promise.resolve({ items: [{ sourceId: source.id, state: "synced" }] });
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    const run = syncCommand.run!({ args: { _: [source.id], wait: true, timeout: "3" } } as never);
    const assertion = expect(run).rejects.toThrow("did not sync successfully");
    await vi.runAllTimersAsync();
    await assertion;
    expect(logged.some((line) => line.includes("Timed out"))).toBe(true);
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
