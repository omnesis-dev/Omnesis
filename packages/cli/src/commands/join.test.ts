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
import { exclusiveRefusal, joinSourceCommand, notCandidateRefusal, renderJoined } from "./join.js";
import type { AdminDeviceEntry, AdminSourceEntry } from "./members.js";

const devices: AdminDeviceEntry[] = [
  { id: "dev-laptop", name: "Maya-Laptop", kind: "collector", online: true },
  { id: "dev-mini", name: "Studio-Mini", kind: "collector", online: false },
  { id: "dev-phone", name: "Maya-Phone", kind: "ios", online: true },
];

const handoffSource: AdminSourceEntry = {
  id: "notes-synth:local",
  type: "notes-synth",
  deviceId: "dev-laptop",
  enabled: true,
  members: ["dev-laptop"],
  multiDeviceMode: "handoff",
  leaseHolder: null,
  pushBased: false,
};

const exclusiveSource: AdminSourceEntry = {
  ...handoffSource,
  id: "mail-synth:maya@example.com",
  type: "mail-synth",
  multiDeviceMode: "exclusive",
};

function run(args: Record<string, unknown>): Promise<void> {
  return (
    joinSourceCommand as { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }
  ).run({ args });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("renderJoined", () => {
  test("names the device and the count, then the offline and sign-in hints", () => {
    const lines = renderJoined(handoffSource, devices[1]!, 2);
    expect(lines[0]).toContain("Studio-Mini joined notes-synth:local");
    expect(lines[0]).toContain("(2 members)");
    expect(lines[1]).toContain("Studio-Mini is offline");
    expect(lines[2]).toContain(
      "If notes-synth needs a sign-in, run: omnesis sources reauth notes-synth:local --device Studio-Mini",
    );
  });

  test("a push-based source carries no sign-in hint; an online device no offline note", () => {
    const lines = renderJoined({ ...handoffSource, pushBased: true }, devices[0]!, 2);
    expect(lines).toHaveLength(1);
  });

  test("a device whose presence the listing did not carry is not announced as offline", () => {
    const lines = renderJoined({ ...handoffSource, pushBased: true }, { name: "dev-unlisted" }, 2);
    expect(lines).toHaveLength(1);
  });
});

describe("exclusiveRefusal", () => {
  test("names the host and spells out the move for a collector", () => {
    const text = exclusiveRefusal("mail-synth:maya@example.com", "Maya-Laptop", devices[1]!);
    expect(text).toContain("hosted by Maya-Laptop");
    expect(text).toContain("omnesis sources move mail-synth:maya@example.com --device Studio-Mini");
  });

  test("a device that is not a collector cannot be moved to, and is told so", () => {
    const text = exclusiveRefusal("mail-synth:maya@example.com", "Maya-Laptop", devices[2]!);
    expect(text).toContain("hosted by Maya-Laptop");
    expect(text).toContain("Maya-Phone is a ios device and cannot host it");
    expect(text).not.toContain("omnesis sources move");
  });

  test("a device the listing did not describe gets the refusal alone, not a guess", () => {
    const text = exclusiveRefusal("mail-synth:maya@example.com", "Maya-Laptop", {
      name: "dev-unlisted",
    });
    expect(text).toBe(
      "mail-synth:maya@example.com is hosted by Maya-Laptop and its type allows one host at a time.",
    );
  });
});

describe("notCandidateRefusal", () => {
  test("says why the device cannot host the type and who could join instead", () => {
    const collector = notCandidateRefusal(handoffSource, devices[1]!, ["Maya-Laptop"]);
    expect(collector).toContain("Studio-Mini cannot host notes-synth:local");
    expect(collector).toContain("its collector does not offer notes-synth sources");
    expect(collector).toContain("Devices that can join: Maya-Laptop");

    const phone = notCandidateRefusal(handoffSource, devices[2]!, []);
    expect(phone).toContain("a ios device does not host notes-synth sources");
    expect(phone).toContain("No other device can join it.");
  });

  test("a device of unknown kind is not called a collector, nor a device of some kind", () => {
    const text = notCandidateRefusal(handoffSource, { name: "dev-unlisted" }, ["Maya-Laptop"]);
    expect(text).toContain("dev-unlisted cannot host notes-synth:local");
    expect(text).toContain("it does not host notes-synth sources");
    expect(text).not.toContain("collector");
    expect(text).not.toContain("undefined");
  });
});

describe("sources join", () => {
  let logged: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    logged = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      logged.push(line);
    });
    (gatewayJson as Mock).mockImplementation((path: string): Promise<unknown> => {
      if (path === "/admin/sources")
        return Promise.resolve({ items: [handoffSource, exclusiveSource] });
      if (path === "/admin/devices") return Promise.resolve({ items: devices });
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("POSTs the resolved device id to the source's members and prints the join", async () => {
    (gatewayFetch as Mock).mockResolvedValue(
      jsonResponse(200, { source: handoffSource, members: ["dev-laptop", "dev-mini"] }),
    );
    await run({ id: handoffSource.id, device: "Studio-Mini" });
    expect(gatewayFetch).toHaveBeenCalledWith("/admin/sources/notes-synth%3Alocal/members", {
      method: "POST",
      body: JSON.stringify({ deviceId: "dev-mini" }),
    });
    expect(logged[0]).toContain("Studio-Mini joined notes-synth:local");
    expect(logged[0]).toContain("(2 members)");
    expect(logged.at(-1)).toContain(
      "omnesis sources reauth notes-synth:local --device Studio-Mini",
    );
  });

  test("--json reports the new membership", async () => {
    (gatewayFetch as Mock).mockResolvedValue(
      jsonResponse(200, { source: handoffSource, members: ["dev-laptop", "dev-mini"] }),
    );
    await run({ id: handoffSource.id, device: "dev-mini", json: true });
    expect(JSON.parse(logged[0]!)).toEqual({
      sourceId: "notes-synth:local",
      deviceId: "dev-mini",
      joined: true,
      members: ["dev-laptop", "dev-mini"],
    });
  });

  test("a device that is already a member is reported, without a request", async () => {
    await run({ id: handoffSource.id, device: "Maya-Laptop" });
    expect(gatewayFetch).not.toHaveBeenCalled();
    expect(logged[0]).toContain("Maya-Laptop is already a member of notes-synth:local");
  });

  test("a phone-pushed source is managed on the originating device", async () => {
    const pushed = { ...handoffSource, id: "mobile-observations:local", pushBased: true };
    (gatewayJson as Mock).mockImplementation((path: string): Promise<unknown> => {
      if (path === "/admin/sources") return Promise.resolve({ items: [pushed] });
      if (path === "/admin/devices") return Promise.resolve({ items: devices });
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    await expect(run({ id: pushed.id, device: "Studio-Mini" })).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining("managed by the phone or browser that contributes it"),
    });
    expect(gatewayFetch).not.toHaveBeenCalled();
  });

  test("an exclusive source is refused before any request, naming the host", async () => {
    await expect(run({ id: exclusiveSource.id, device: "Studio-Mini" })).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining(
        "omnesis sources move mail-synth:maya@example.com --device Studio-Mini",
      ),
    });
    await expect(run({ id: exclusiveSource.id, device: "Studio-Mini" })).rejects.toMatchObject({
      message: expect.stringContaining("hosted by Maya-Laptop"),
    });
    // A phone is never a move target, so the refusal offers no move.
    await expect(run({ id: exclusiveSource.id, device: "Maya-Phone" })).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining("Maya-Phone is a ios device and cannot host it"),
    });
    await expect(run({ id: exclusiveSource.id, device: "Maya-Phone" })).rejects.not.toMatchObject({
      message: expect.stringContaining("omnesis sources move"),
    });
    expect(gatewayFetch).not.toHaveBeenCalled();
  });

  test("a device the listing does not count as a candidate is refused before any request", async () => {
    (gatewayJson as Mock).mockImplementation((path: string): Promise<unknown> => {
      if (path === "/admin/sources")
        return Promise.resolve({ items: [{ ...handoffSource, joinCandidates: ["dev-mini"] }] });
      if (path === "/admin/devices") return Promise.resolve({ items: devices });
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    await expect(run({ id: handoffSource.id, device: "Maya-Phone" })).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining("a ios device does not host notes-synth sources"),
    });
    await expect(run({ id: handoffSource.id, device: "Maya-Phone" })).rejects.toMatchObject({
      message: expect.stringContaining("Devices that can join: Studio-Mini"),
    });
    expect(gatewayFetch).not.toHaveBeenCalled();
  });

  test("a candidate device joins; a listing without candidates defers to the gateway", async () => {
    (gatewayFetch as Mock).mockImplementation(() =>
      Promise.resolve(
        jsonResponse(200, { source: handoffSource, members: ["dev-laptop", "dev-mini"] }),
      ),
    );
    (gatewayJson as Mock).mockImplementation((path: string): Promise<unknown> => {
      if (path === "/admin/sources")
        return Promise.resolve({ items: [{ ...handoffSource, joinCandidates: ["dev-mini"] }] });
      if (path === "/admin/devices") return Promise.resolve({ items: devices });
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    await run({ id: handoffSource.id, device: "Studio-Mini" });
    expect(gatewayFetch).toHaveBeenCalledTimes(1);

    // The default listing carries no joinCandidates: the phone's join is sent.
    (gatewayJson as Mock).mockImplementation((path: string): Promise<unknown> => {
      if (path === "/admin/sources") return Promise.resolve({ items: [handoffSource] });
      if (path === "/admin/devices") return Promise.resolve({ items: devices });
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    await run({ id: handoffSource.id, device: "Maya-Phone" });
    expect(gatewayFetch).toHaveBeenCalledTimes(2);
  });

  test("the gateway's SOURCE_ALREADY_HOSTED is rendered the same way", async () => {
    (gatewayJson as Mock).mockImplementation((path: string): Promise<unknown> => {
      // The listing says handoff, the gateway disagrees: its refusal wins.
      if (path === "/admin/sources") return Promise.resolve({ items: [handoffSource] });
      if (path === "/admin/devices") return Promise.resolve({ items: devices });
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    (gatewayFetch as Mock).mockResolvedValue(
      jsonResponse(409, {
        error: "already hosted",
        code: "SOURCE_ALREADY_HOSTED",
        detail: { currentDeviceName: "Maya-Laptop" },
      }),
    );
    await expect(run({ id: handoffSource.id, device: "Studio-Mini" })).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining(
        "omnesis sources move notes-synth:local --device Studio-Mini",
      ),
    });
  });

  test("any other gateway refusal is surfaced with its message", async () => {
    (gatewayFetch as Mock).mockResolvedValue(
      jsonResponse(400, {
        error: 'device "Studio-Mini" cannot host source type "notes-synth"',
        code: "DEVICE_CANNOT_HOST_TYPE",
      }),
    );
    await expect(run({ id: handoffSource.id, device: "Studio-Mini" })).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('cannot host source type "notes-synth"'),
    });
  });

  test("a missing or unknown --device is a user error", async () => {
    await expect(run({ id: handoffSource.id })).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining("Usage: omnesis sources join"),
    });
    await expect(run({ id: handoffSource.id, device: "Nowhere-Box" })).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining("Maya-Laptop, Studio-Mini, Maya-Phone"),
    });
  });
});
