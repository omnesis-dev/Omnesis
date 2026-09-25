// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from "vitest";

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return {
    ...actual,
    gatewayJson: vi.fn(),
    gatewayFetch: vi.fn(),
    withSpinner: (_label: string, operation: () => unknown) => operation(),
  };
});

import { gatewayFetch, gatewayJson } from "../utils.js";
import {
  confirmMessage,
  notMemberRefusal,
  renderResync,
  resyncCommand,
  sharedCursorRefusal,
} from "./resync.js";
import type { AdminDeviceEntry, AdminSourceEntry } from "./members.js";

const devices: AdminDeviceEntry[] = [
  { id: "dev-laptop", name: "Maya-Laptop", kind: "collector", online: true },
  { id: "dev-mini", name: "Studio-Mini", kind: "collector", online: false },
  { id: "dev-phone", name: "Maya-Phone", kind: "ios", online: true },
];

const exclusiveSource: AdminSourceEntry = {
  id: "mail-synth:maya@example.com",
  type: "mail-synth",
  deviceId: "dev-laptop",
  enabled: true,
  members: ["dev-laptop"],
  multiDeviceMode: "exclusive",
  leaseHolder: null,
  pushBased: false,
};

const handoffSource: AdminSourceEntry = {
  ...exclusiveSource,
  id: "notes-synth:local",
  type: "notes-synth",
  members: ["dev-laptop", "dev-mini"],
  multiDeviceMode: "handoff",
  leaseHolder: "dev-laptop",
};

const partitionedSource: AdminSourceEntry = {
  ...exclusiveSource,
  id: "health-synth:me",
  type: "health-synth",
  deviceId: "dev-phone",
  members: ["dev-phone", "dev-laptop"],
  multiDeviceMode: "partitioned",
  pushBased: true,
};

const replicatedSource: AdminSourceEntry = {
  ...exclusiveSource,
  id: "tasks-synth:local",
  type: "tasks-synth",
  members: ["dev-laptop", "dev-mini"],
  multiDeviceMode: "replicated",
};

const allSources = [exclusiveSource, handoffSource, partitionedSource, replicatedSource];

function run(args: Record<string, unknown>): Promise<void> {
  return (resyncCommand as { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }).run({
    args,
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const deviceName = (id: string): string => devices.find((d) => d.id === id)?.name ?? id;

describe("confirmMessage", () => {
  test("a whole-source resync says every document goes", () => {
    expect(confirmMessage("mail-synth:maya@example.com")).toBe(
      "This will delete all data for mail-synth:maya@example.com and re-sync from scratch. Continue?",
    );
  });

  test("a partitioned member's resync says its stream goes and the others stay", () => {
    expect(confirmMessage("health-synth:me", { device: devices[2]!, mode: "partitioned" })).toBe(
      "This removes everything Maya-Phone contributed to health-synth:me and re-syncs it from that device; the other members' data stays. Continue?",
    );
  });

  test("a replicated member's resync says nothing is deleted", () => {
    expect(confirmMessage("tasks-synth:local", { device: devices[1]!, mode: "replicated" })).toBe(
      "This resets Studio-Mini's sync position for tasks-synth:local and re-syncs; nothing is deleted. Continue?",
    );
  });
});

describe("refusals", () => {
  test("sharedCursorRefusal names the mode and the way out", () => {
    const text = sharedCursorRefusal(handoffSource);
    expect(text).toContain("notes-synth:local syncs as handoff");
    expect(text).toContain("its members share one cursor");
    expect(text).toContain("Resync it without --device.");
  });

  test("notMemberRefusal names the members", () => {
    expect(notMemberRefusal(partitionedSource, devices[1]!, ["Maya-Phone", "Maya-Laptop"])).toBe(
      "Studio-Mini does not host health-synth:me — members: Maya-Phone, Maya-Laptop",
    );
  });
});

describe("renderResync", () => {
  test("a source-wide resync names every device it reached and says all data went", () => {
    const lines = renderResync(
      {
        ok: true,
        scope: "source",
        deviceIds: ["dev-laptop", "dev-mini"],
        restarting: [],
        skipped: [],
        disabled: [],
      },
      "notes-synth:local",
      deviceName,
    );
    expect(lines[0]).toContain("Resync sent to Maya-Laptop, Studio-Mini:");
    expect(lines[0]).toContain("notes-synth:local");
    expect(lines[1]).toContain("Every document of the source was deleted.");
  });

  test("no online member reads as queued", () => {
    const lines = renderResync(
      { ok: true, scope: "source", deviceIds: [], restarting: [], skipped: [], disabled: [] },
      "x",
      deviceName,
    );
    expect(lines[0]).toContain("Resync queued; no member is online:");
  });

  test("a stream resync says what the device contributed went and the rest stays", () => {
    const lines = renderResync(
      {
        ok: true,
        scope: "stream",
        deviceIds: ["dev-phone"],
        restarting: [],
        skipped: [],
        disabled: [],
      },
      "health-synth:me",
      deviceName,
      devices[2]!,
    );
    expect(lines[0]).toContain("Resync sent to Maya-Phone:");
    expect(lines[1]).toContain(
      "Maya-Phone contributed was removed; the other members' data stays.",
    );
  });

  test("a cursor resync says nothing was deleted; an offline device reads as queued", () => {
    const lines = renderResync(
      { ok: true, scope: "cursor", deviceIds: [], restarting: [], skipped: [], disabled: [] },
      "tasks-synth:local",
      deviceName,
      devices[1]!,
    );
    expect(lines[0]).toContain("Resync queued; Studio-Mini is offline:");
    expect(lines[1]).toContain("Studio-Mini's sync position was reset; nothing was deleted.");
  });
});

describe("sources resync", () => {
  let logged: string[];
  let errored: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    logged = [];
    errored = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      logged.push(line);
    });
    vi.spyOn(console, "error").mockImplementation((line: string) => {
      errored.push(line);
    });
    (gatewayJson as Mock).mockImplementation((path: string): Promise<unknown> => {
      if (path === "/admin/sources") return Promise.resolve({ items: allSources });
      if (path === "/admin/devices") return Promise.resolve({ items: devices });
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("POSTs an empty body to the source's resync route and prints where it went", async () => {
    (gatewayFetch as Mock).mockResolvedValue(
      jsonResponse(200, {
        ok: true,
        scope: "source",
        deviceIds: ["dev-laptop"],
        restarting: [],
        skipped: [],
        disabled: [],
      }),
    );
    await run({ _: [handoffSource.id], yes: true });
    expect(gatewayFetch).toHaveBeenCalledTimes(1);
    expect(gatewayFetch).toHaveBeenCalledWith("/admin/sources/notes-synth%3Alocal/resync", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(logged[0]).toContain("Resync sent to Maya-Laptop:");
    expect(logged[0]).toContain("notes-synth:local");
    expect(logged[1]).toContain("Every document of the source was deleted.");
  });

  test("a pattern resyncs every matching source, one request each", async () => {
    (gatewayFetch as Mock).mockImplementation(() =>
      Promise.resolve(
        jsonResponse(200, {
          ok: true,
          scope: "source",
          deviceIds: [],
          restarting: [],
          skipped: [],
          disabled: [],
        }),
      ),
    );
    await run({ _: ["notes-synth:", "tasks-synth:"], yes: true });
    expect(gatewayFetch).toHaveBeenCalledTimes(2);
    expect((gatewayFetch as Mock).mock.calls.map((call) => call[0])).toEqual([
      "/admin/sources/notes-synth%3Alocal/resync",
      "/admin/sources/tasks-synth%3Alocal/resync",
    ]);
    expect(logged.filter((l) => l.includes("Resync queued; no member is online:"))).toHaveLength(2);
  });

  test("--device sends the resolved device id and names the stream scope", async () => {
    (gatewayFetch as Mock).mockResolvedValue(
      jsonResponse(200, {
        ok: true,
        scope: "stream",
        deviceIds: ["dev-phone"],
        restarting: [],
        skipped: [],
        disabled: [],
      }),
    );
    await run({ _: [partitionedSource.id], device: "Maya-Phone", yes: true });
    expect(gatewayFetch).toHaveBeenCalledWith("/admin/sources/health-synth%3Ame/resync", {
      method: "POST",
      body: JSON.stringify({ deviceId: "dev-phone" }),
    });
    expect(logged[0]).toContain("Resync sent to Maya-Phone:");
    expect(logged[1]).toContain(
      "Maya-Phone contributed was removed; the other members' data stays.",
    );
  });

  test("--device on a replicated source names the cursor scope", async () => {
    (gatewayFetch as Mock).mockResolvedValue(
      jsonResponse(200, {
        ok: true,
        scope: "cursor",
        deviceIds: ["dev-mini"],
        restarting: [],
        skipped: [],
        disabled: [],
      }),
    );
    await run({ _: [replicatedSource.id], device: "dev-mini", yes: true });
    expect(gatewayFetch).toHaveBeenCalledWith("/admin/sources/tasks-synth%3Alocal/resync", {
      method: "POST",
      body: JSON.stringify({ deviceId: "dev-mini" }),
    });
    expect(logged[0]).toContain("Resync sent to Studio-Mini:");
    expect(logged[1]).toContain("Studio-Mini's sync position was reset; nothing was deleted.");
  });

  test("--json prints the route's response with the source id", async () => {
    (gatewayFetch as Mock).mockResolvedValue(
      jsonResponse(200, {
        ok: true,
        scope: "stream",
        deviceIds: ["dev-phone"],
        restarting: [],
        skipped: [],
        disabled: [],
      }),
    );
    await run({ _: [partitionedSource.id], device: "Maya-Phone", yes: true, json: true });
    expect(JSON.parse(logged[0]!)).toEqual({
      sourceId: "health-synth:me",
      ok: true,
      scope: "stream",
      deviceIds: ["dev-phone"],
      restarting: [],
      skipped: [],
      disabled: [],
    });
  });

  test("a non-interactive run without --yes is refused before any request", async () => {
    // Pinned rather than inherited from the runner, so the test cannot fall
    // through to the prompt and block when it is run from a terminal.
    const isTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    try {
      await expect(run({ _: [handoffSource.id] })).rejects.toMatchObject({
        exitCode: 2,
        message: expect.stringContaining("Re-run with --yes"),
      });
    } finally {
      if (isTTY) Object.defineProperty(process.stdout, "isTTY", isTTY);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
    expect(gatewayFetch).not.toHaveBeenCalled();
  });

  test("--device on a source whose members share one cursor is refused before any request", async () => {
    for (const source of [exclusiveSource, handoffSource]) {
      await expect(run({ _: [source.id], device: "Maya-Laptop", yes: true })).rejects.toMatchObject(
        {
          exitCode: 2,
          message: expect.stringContaining(
            `${source.id} syncs as ${source.multiDeviceMode}: its members share one cursor`,
          ),
        },
      );
    }
    // The mode is what rules the device out, so a device that is not even a
    // member gets the same answer.
    await expect(
      run({ _: [exclusiveSource.id], device: "Maya-Phone", yes: true }),
    ).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining("Resync it without --device."),
    });
    expect(gatewayFetch).not.toHaveBeenCalled();
  });

  test("--device that does not host the source is refused, naming the members", async () => {
    await expect(
      run({ _: [partitionedSource.id], device: "Studio-Mini", yes: true }),
    ).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining(
        "Studio-Mini does not host health-synth:me — members: Maya-Phone, Maya-Laptop",
      ),
    });
    expect(gatewayFetch).not.toHaveBeenCalled();
  });

  test("--device takes one source: a pattern matching several is refused", async () => {
    await expect(
      run({ _: ["notes-synth:", "tasks-synth:"], device: "Maya-Laptop", yes: true }),
    ).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining("--device resyncs one source at a time"),
    });
    expect(gatewayFetch).not.toHaveBeenCalled();
  });

  test("a missing, empty or unknown --device is a user error", async () => {
    await expect(run({ _: [partitionedSource.id], device: "", yes: true })).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining("--device cannot be empty"),
    });
    await expect(
      run({ _: [partitionedSource.id], device: "Nowhere-Box", yes: true }),
    ).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining("Maya-Laptop, Studio-Mini, Maya-Phone"),
    });
    expect(gatewayFetch).not.toHaveBeenCalled();
  });

  test("the gateway's per-device refusals are rendered with the same way out", async () => {
    // The listing says partitioned and lists the phone; the gateway disagrees.
    // Its sentence names the mode it sees, so that is the one printed — the
    // listing's mode is the stale one.
    (gatewayFetch as Mock).mockResolvedValueOnce(
      jsonResponse(400, {
        error: "health-synth:me is handoff: its members share one cursor",
        code: "RESYNC_NOT_PER_DEVICE",
      }),
    );
    await expect(
      run({ _: [partitionedSource.id], device: "Maya-Phone", yes: true }),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(errored[0]).toContain("health-synth:me is handoff: its members share one cursor");
    expect(errored[0]).not.toContain("syncs as partitioned");
    expect(errored[0]).toContain("Resync it without --device.");

    (gatewayFetch as Mock).mockResolvedValueOnce(
      jsonResponse(409, { error: "not a member", code: "DEVICE_NOT_MEMBER" }),
    );
    await expect(
      run({ _: [partitionedSource.id], device: "Maya-Phone", yes: true }),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(errored[1]).toContain(
      "Maya-Phone does not host health-synth:me — members: Maya-Phone, Maya-Laptop",
    );
  });

  test("any other gateway failure is surfaced with its message and the run exits non-zero", async () => {
    (gatewayFetch as Mock).mockImplementation(() =>
      Promise.resolve(jsonResponse(503, { error: "no collector channel", code: "NO_WS_SERVER" })),
    );
    await expect(run({ _: ["notes-synth:", "tasks-synth:"], yes: true })).rejects.toMatchObject({
      exitCode: 65,
      message: expect.stringContaining("2 of 2 sources did not resync"),
    });
    expect(errored[0]).toContain("Resync failed for notes-synth:local: no collector channel");
  });

  test("no matching source, and a usage error without a pattern", async () => {
    await expect(run({ _: ["nothing:"], yes: true })).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining("No sources match: nothing:"),
    });
    await expect(run({ _: [] })).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining("Usage: omnesis sources resync"),
    });
    expect(gatewayFetch).not.toHaveBeenCalled();
  });
});

describe("renderResync reads each member's answer", () => {
  test("a member that was already syncing is reported as skipped, not sent", () => {
    const lines = renderResync(
      {
        ok: true,
        scope: "source",
        deviceIds: [],
        restarting: [],
        skipped: ["dev-laptop"],
        disabled: [],
      },
      "notes-synth:local",
      deviceName,
    );
    expect(lines[0]).toContain("Resync skipped; Maya-Laptop was already syncing:");
    expect(lines[0]).not.toContain("Resync sent");
    expect(lines[1]).toContain("Every document of the source was deleted.");
  });

  test("a member restarting its sync in flight is reported as restarting", () => {
    const lines = renderResync(
      {
        ok: true,
        scope: "source",
        deviceIds: [],
        restarting: ["dev-laptop"],
        skipped: [],
        disabled: [],
      },
      "notes-synth:local",
      deviceName,
    );
    expect(lines[0]).toContain("Resync restarting the sync in flight on Maya-Laptop:");
  });

  test("a member on which the source is paused is reported as paused, and the resync as waiting on it", () => {
    const lines = renderResync(
      {
        ok: true,
        scope: "source",
        deviceIds: [],
        restarting: [],
        skipped: [],
        disabled: ["dev-mini"],
      },
      "notes-synth:local",
      deviceName,
    );
    expect(lines[0]).toContain(
      "Resync queued; the source is paused on Studio-Mini; it re-syncs when resumed:",
    );
    expect(lines[0]).not.toContain("already syncing");
    expect(lines[1]).toContain("Every document of the source was deleted.");

    // Beside a member that was already syncing, the head stays "skipped".
    const mixed = renderResync(
      {
        ok: true,
        scope: "source",
        deviceIds: [],
        restarting: [],
        skipped: ["dev-laptop"],
        disabled: ["dev-mini"],
      },
      "notes-synth:local",
      deviceName,
    );
    expect(mixed[0]).toContain(
      "Resync skipped; Maya-Laptop was already syncing; the source is paused on Studio-Mini; it re-syncs when resumed:",
    );
  });

  test("mixed answers name every member under its verdict", () => {
    const lines = renderResync(
      {
        ok: true,
        scope: "source",
        deviceIds: ["dev-laptop"],
        restarting: ["dev-mini"],
        skipped: ["dev-phone"],
        disabled: [],
      },
      "notes-synth:local",
      deviceName,
    );
    expect(lines[0]).toContain(
      "Resync sent to Maya-Laptop; restarting the sync in flight on Studio-Mini; Maya-Phone was already syncing:",
    );
  });
});
