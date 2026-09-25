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

vi.mock("@clack/prompts", () => ({ confirm: vi.fn(), isCancel: () => false, cancel: vi.fn() }));
import { confirm } from "@clack/prompts";

import { gatewayFetch, gatewayJson } from "../utils.js";
import { detachSourceCommand, renderDetached } from "./detach.js";
import type { AdminDeviceEntry, AdminSourceEntry } from "./members.js";

const devices: AdminDeviceEntry[] = [
  { id: "dev-laptop", name: "Maya-Laptop", kind: "collector", online: true },
  { id: "dev-mini", name: "Studio-Mini", kind: "collector", online: true },
  { id: "dev-phone", name: "Maya-Phone", kind: "ios", online: true },
];

const source: AdminSourceEntry = {
  id: "notes-synth:local",
  type: "notes-synth",
  deviceId: "dev-laptop",
  enabled: true,
  members: ["dev-laptop", "dev-mini"],
  multiDeviceMode: "replicated",
  leaseHolder: null,
  pushBased: false,
};

const LAST_MEMBER_MESSAGE =
  "device dev-laptop is the last host of notes-synth:local — to stop syncing it, remove the source: omnesis sources remove notes-synth:local";

function run(args: Record<string, unknown>): Promise<void> {
  return (
    detachSourceCommand as { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }
  ).run({ args });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("renderDetached", () => {
  test("names the device, the remaining count, and that the data stays", () => {
    const lines = renderDetached(source, devices[1]!, 1);
    expect(lines[0]).toContain("Studio-Mini detached from notes-synth:local");
    expect(lines[0]).toContain("(1 member remains)");
    expect(lines[1]).toContain("retains shared indexed data");
    expect(renderDetached(source, devices[1]!, 2)[0]).toContain("(2 members remain)");
  });

  test("a partitioned source's detached device takes its contribution with it", () => {
    const lines = renderDetached({ ...source, multiDeviceMode: "partitioned" }, devices[1]!, 1);
    expect(lines[1]).toContain("departing device's partitioned contribution");
    expect(lines[1]).toContain("Other members' data stays");
  });
});

describe("sources detach", () => {
  let logged: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    (confirm as Mock).mockResolvedValue(true);
    logged = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      logged.push(line);
    });
    (gatewayJson as Mock).mockImplementation((path: string): Promise<unknown> => {
      if (path === "/admin/sources") return Promise.resolve({ items: [source] });
      if (path === "/admin/devices") return Promise.resolve({ items: devices });
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("DELETEs the member and prints the detach", async () => {
    (gatewayFetch as Mock).mockResolvedValue(
      jsonResponse(200, { source, members: ["dev-laptop"] }),
    );
    await run({ id: source.id, device: "Studio-Mini" });
    expect(gatewayFetch).toHaveBeenCalledWith(
      "/admin/sources/notes-synth%3Alocal/members/dev-mini",
      { method: "DELETE" },
    );
    expect(logged[0]).toContain("Studio-Mini detached from notes-synth:local");
    expect(logged[0]).toContain("(1 member remains)");
    expect(logged[1]).toContain("retains shared indexed data");
  });

  test("--json reports the remaining membership", async () => {
    (gatewayFetch as Mock).mockResolvedValue(
      jsonResponse(200, { source, members: ["dev-laptop"] }),
    );
    await run({ id: source.id, device: "dev-mini", json: true, yes: true });
    expect(JSON.parse(logged[0]!)).toEqual({
      sourceId: "notes-synth:local",
      deviceId: "dev-mini",
      members: ["dev-laptop"],
    });
  });

  test("cancelling partition deletion sends no detach request", async () => {
    (gatewayJson as Mock).mockImplementation((path: string) =>
      Promise.resolve(
        path === "/admin/sources"
          ? { items: [{ ...source, multiDeviceMode: "partitioned" }] }
          : { items: devices },
      ),
    );
    (confirm as Mock).mockResolvedValue(false);
    await expect(run({ id: source.id, device: "Studio-Mini" })).rejects.toMatchObject({
      exitCode: 130,
    });
    expect(gatewayFetch).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledWith({
      message: expect.stringContaining("delete its managed gateway contribution"),
    });
  });

  test("detach in JSON mode requires explicit consent", async () => {
    (gatewayJson as Mock).mockImplementation((path: string) =>
      Promise.resolve(
        path === "/admin/sources"
          ? { items: [{ ...source, multiDeviceMode: "partitioned" }] }
          : { items: devices },
      ),
    );
    await expect(run({ id: source.id, device: "Studio-Mini", json: true })).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining("--yes"),
    });
    expect(gatewayFetch).not.toHaveBeenCalled();
    (gatewayFetch as Mock).mockResolvedValue(
      jsonResponse(200, { source, members: ["dev-laptop"] }),
    );
    await run({ id: source.id, device: "Studio-Mini", json: true, yes: true });
    expect(gatewayFetch).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  });

  test("shared detach warns about a server-time partition change before mutation", async () => {
    (confirm as Mock).mockResolvedValue(false);
    await expect(run({ id: source.id, device: "Studio-Mini" })).rejects.toMatchObject({
      exitCode: 130,
    });
    expect(confirm).toHaveBeenCalledWith({
      message: expect.stringContaining("if partitioned when the gateway handles the request"),
    });
    expect(gatewayFetch).not.toHaveBeenCalled();
  });

  test("a phone-pushed source cannot be detached from the CLI", async () => {
    const pushed = { ...source, id: "mobile-observations:local", pushBased: true };
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

  test("LAST_MEMBER is the gateway's message, as a user error", async () => {
    (gatewayFetch as Mock).mockResolvedValue(
      jsonResponse(409, { error: LAST_MEMBER_MESSAGE, code: "LAST_MEMBER" }),
    );
    await expect(run({ id: source.id, device: "Maya-Laptop" })).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining(LAST_MEMBER_MESSAGE),
    });
  });

  test("a device that does not host the source is refused before any request", async () => {
    await expect(run({ id: source.id, device: "Maya-Phone" })).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining(
        "Maya-Phone does not host notes-synth:local — members: Maya-Laptop, Studio-Mini",
      ),
    });
    expect(gatewayFetch).not.toHaveBeenCalled();
  });

  test("the gateway's DEVICE_NOT_MEMBER is surfaced verbatim", async () => {
    // The listing was stale: the device left between the read and the delete.
    (gatewayFetch as Mock).mockResolvedValue(
      jsonResponse(409, {
        error: "device dev-mini does not host notes-synth:local",
        code: "DEVICE_NOT_MEMBER",
      }),
    );
    await expect(run({ id: source.id, device: "Studio-Mini" })).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining("device dev-mini does not host notes-synth:local"),
    });
  });

  test("a missing --device is a user error", async () => {
    await expect(run({ id: source.id })).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining("Usage: omnesis sources detach"),
    });
  });
});
