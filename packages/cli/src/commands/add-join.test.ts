// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `omnesis sources add <type>` against an account the gateway already lists:
 * a join from the target device when the type admits it, a refusal that
 * names the host when it does not, and nothing when the device hosts it.
 * Only an account the gateway does not list goes through the add.
 */

import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parseSourceKey } from "@omnesis/core";
import type { SerializedDescriptor } from "../utils.js";
import type { JoinConfirmation } from "./add.js";
import type { UnionDescriptor } from "../device-picker.js";
import type { AdminDeviceEntry, AdminSourceEntry } from "./members.js";

const mocks = vi.hoisted(() => ({
  fetchDescriptors: vi.fn(),
  fetchSourcesSnapshot: vi.fn(),
  gatewayJson: vi.fn(),
  gatewayFetch: vi.fn(),
  pickDeviceForDescriptor: vi.fn(),
}));

vi.mock("../device-picker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../device-picker.js")>()),
  pickDeviceForDescriptor: mocks.pickDeviceForDescriptor,
}));

vi.mock("../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils.js")>()),
  fetchDescriptors: mocks.fetchDescriptors,
  fetchSourcesSnapshot: mocks.fetchSourcesSnapshot,
  gatewayJson: mocks.gatewayJson,
  gatewayFetch: mocks.gatewayFetch,
  withSpinner: (_label: string, operation: (spin: { message(value: string): void }) => unknown) =>
    operation({ message: () => undefined }),
}));

const devices: AdminDeviceEntry[] = [
  { id: "dev-laptop", name: "Maya-Laptop", kind: "collector", online: true },
  { id: "dev-mini", name: "Studio-Mini", kind: "collector", online: true },
];

const notesOnLaptop: AdminSourceEntry = {
  id: "notes-synth:local",
  type: "notes-synth",
  deviceId: "dev-laptop",
  enabled: true,
  members: ["dev-laptop"],
  multiDeviceMode: "replicated",
  leaseHolder: null,
  pushBased: false,
  joinCandidates: ["dev-mini"],
};

const mailOnLaptop: AdminSourceEntry = {
  ...notesOnLaptop,
  id: "mail-synth:maya@example.com",
  type: "mail-synth",
  multiDeviceMode: "exclusive",
  joinCandidates: [],
};

function descriptor(
  id: string,
  name: string,
  extra: Partial<SerializedDescriptor> = {},
): SerializedDescriptor {
  return {
    id,
    name,
    description: `${name} source`,
    provider: { id: "synth", name: "Synth" },
    authType: "local",
    unitName: "items",
    hasAuthFlow: false,
    hasDiscover: true,
    singleInstance: true,
    ...extra,
  } as unknown as SerializedDescriptor;
}

const notesDescriptor = descriptor("notes-synth", "Synthetic notes");
const mailDescriptor = descriptor("mail-synth", "Synthetic mail", { singleInstance: false });

function union(...descs: SerializedDescriptor[]): UnionDescriptor[] {
  return descs.map((d) => ({
    ...d,
    devices: [{ id: "dev-mini", name: "Studio-Mini" }],
  })) as unknown as UnionDescriptor[];
}

function fakePrompts(overrides: Record<string, unknown> = {}) {
  return {
    confirm: vi.fn().mockResolvedValue(true),
    multiselect: vi.fn(async ({ initialValues }: { initialValues: string[] }) => initialValues),
    select: vi.fn(),
    isCancel: () => false,
    cancel: () => undefined,
    intro: () => undefined,
    ...overrides,
  } as unknown as typeof import("@clack/prompts");
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function runAdd(
  descs: SerializedDescriptor[],
  sources: AdminSourceEntry[],
  sourceArg: string,
  prompts = fakePrompts(),
  joinConfirmation: JoinConfirmation = "ask",
  listedDevices: AdminDeviceEntry[] = devices,
  extraPositional?: string,
): Promise<void> {
  const { runMultiCollectorAddFlow } = await import("./add.js");
  await runMultiCollectorAddFlow(
    union(...descs),
    { sources, devices: listedDevices },
    sourceArg,
    extraPositional,
    {
      prompts,
      resolve,
      join,
      parseSourceKey,
      joinConfirmation,
    },
  );
}

describe("sources add against a configured account", () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      logged.push(String(line));
    });
    mocks.pickDeviceForDescriptor.mockResolvedValue({ id: "dev-mini", name: "Studio-Mini" });
    mocks.fetchDescriptors.mockImplementation(async () => ({
      deviceId: "dev-mini",
      collectorHostname: "studio.example",
      items: [notesDescriptor, mailDescriptor],
    }));
    mocks.fetchSourcesSnapshot.mockResolvedValue({ deviceId: "dev-mini", configured: {} });
    mocks.gatewayJson.mockImplementation(async (path: string) => {
      if (path === "/admin/sources/discover") return { accounts: ["local"] };
      if (path === "/admin/sources/add") return { sourceIds: ["notes-synth:local"] };
      throw new Error(`unexpected path ${path}`);
    });
    mocks.gatewayFetch.mockResolvedValue(
      jsonResponse(200, { source: notesOnLaptop, members: ["dev-laptop", "dev-mini"] }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mocks.gatewayFetch.mockReset();
    mocks.gatewayJson.mockReset();
  });

  test("a replicated source on another device is explained, confirmed and joined — never added", async () => {
    const prompts = fakePrompts();
    await runAdd([notesDescriptor], [notesOnLaptop], "notes-synth", prompts);

    const text = logged.join("\n");
    expect(text).toContain("notes-synth:local");
    expect(text).toContain("is configured on Maya-Laptop");
    expect(text).toContain("This device syncs its own copy alongside the others.");
    expect(prompts.confirm).toHaveBeenCalledWith({ message: "Join from this device?" });
    expect(mocks.gatewayFetch).toHaveBeenCalledWith("/admin/sources/notes-synth%3Alocal/members", {
      method: "POST",
      body: JSON.stringify({ deviceId: "dev-mini" }),
    });
    expect(text).toContain("Studio-Mini joined notes-synth:local");
    expect(text).toContain("(2 members)");
    expect(text).toContain("omnesis sources reauth notes-synth:local --device Studio-Mini");
    const addCall = mocks.gatewayJson.mock.calls.find(([path]) => path === "/admin/sources/add");
    expect(addCall).toBeUndefined();
  });

  test("an existing partitioned source joins with only its addressed member-local path", async () => {
    const localDescriptor = descriptor("notes-synth", "Synthetic notes", {
      params: [
        {
          name: "sessionsPath",
          label: "Sessions directory",
          type: "path",
          scope: "member",
        },
      ],
    });
    const partitioned = { ...notesOnLaptop, multiDeviceMode: "partitioned" as const };
    mocks.fetchDescriptors.mockResolvedValue({
      deviceId: "dev-mini",
      collectorHostname: "studio.example",
      items: [localDescriptor],
    });
    mocks.gatewayJson.mockImplementation(async (path: string) => {
      if (path === "/admin/sources/validate-param") return { valid: true };
      if (path === "/admin/sources/discover") return { accounts: ["local"] };
      throw new Error(`unexpected path ${path}`);
    });

    await runAdd(
      [localDescriptor],
      [partitioned],
      "notes-synth",
      fakePrompts(),
      "assume-yes",
      devices,
      "~/fictional-sessions",
    );

    expect(mocks.gatewayJson).toHaveBeenCalledWith("/admin/sources/validate-param", {
      method: "POST",
      body: JSON.stringify({
        deviceId: "dev-mini",
        descriptorId: "notes-synth",
        paramName: "sessionsPath",
        value: "~/fictional-sessions",
      }),
    });

    expect(mocks.gatewayFetch).toHaveBeenCalledWith("/admin/sources/notes-synth%3Alocal/members", {
      method: "POST",
      body: JSON.stringify({
        deviceId: "dev-mini",
        memberConfig: { params: { sessionsPath: "~/fictional-sessions" } },
      }),
    });
  });

  test("a member-local path rejected by the addressed collector never reaches the join", async () => {
    const localDescriptor = descriptor("notes-synth", "Synthetic notes", {
      params: [
        {
          name: "sessionsPath",
          label: "Sessions directory",
          type: "path",
          scope: "member",
        },
      ],
    });
    const partitioned = { ...notesOnLaptop, multiDeviceMode: "partitioned" as const };
    mocks.fetchDescriptors.mockResolvedValue({
      deviceId: "dev-mini",
      collectorHostname: "studio.example",
      items: [localDescriptor],
    });
    mocks.gatewayJson.mockImplementation(async (path: string) => {
      if (path === "/admin/sources/validate-param") {
        return { valid: false, error: "Directory does not exist" };
      }
      throw new Error(`unexpected path ${path}`);
    });

    await runAdd(
      [localDescriptor],
      [partitioned],
      "notes-synth",
      fakePrompts(),
      "assume-yes",
      devices,
      "~/missing-on-target",
    );

    expect(mocks.gatewayFetch).not.toHaveBeenCalled();
  });

  test("a stored exclusive source enables the descriptor's partitioned mode before joining", async () => {
    const localDescriptor = descriptor("notes-synth", "Synthetic notes", {
      multiDeviceMode: "partitioned",
    });
    mocks.fetchDescriptors.mockResolvedValue({
      deviceId: "dev-mini",
      collectorHostname: "studio.example",
      items: [localDescriptor],
    });
    mocks.gatewayFetch.mockImplementation(async (_path: string, init?: RequestInit) =>
      init?.method === "PATCH"
        ? jsonResponse(200, {
            source: { ...notesOnLaptop, multiDeviceMode: "partitioned" },
          })
        : jsonResponse(200, {
            source: { ...notesOnLaptop, multiDeviceMode: "partitioned" },
            members: ["dev-laptop", "dev-mini"],
          }),
    );

    await runAdd(
      [localDescriptor],
      [{ ...notesOnLaptop, multiDeviceMode: "exclusive", joinCandidates: [] }],
      "notes-synth",
      fakePrompts(),
      "assume-yes",
    );

    expect(mocks.gatewayFetch.mock.calls.map(([path, init]) => [path, init?.method])).toEqual([
      ["/admin/sources/notes-synth%3Alocal", "PATCH"],
      ["/admin/sources/notes-synth%3Alocal/members", "POST"],
    ]);
    expect(JSON.parse(String(mocks.gatewayFetch.mock.calls[0]?.[1]?.body))).toEqual({
      multiDeviceMode: "partitioned",
    });
  });

  test("adding an already joined member refuses a changed local path", async () => {
    const localDescriptor = descriptor("notes-synth", "Synthetic notes", {
      params: [
        {
          name: "sessionsPath",
          label: "Sessions directory",
          type: "path",
          scope: "member",
        },
      ],
    });
    const onBoth = {
      ...notesOnLaptop,
      multiDeviceMode: "partitioned" as const,
      members: ["dev-laptop", "dev-mini"],
      joinCandidates: [],
    };
    mocks.fetchDescriptors.mockResolvedValue({
      deviceId: "dev-mini",
      collectorHostname: "studio.example",
      items: [localDescriptor],
    });
    mocks.gatewayJson.mockImplementation(async (path: string) => {
      if (path === "/admin/sources/validate-param") return { valid: true };
      if (path === "/admin/sources/discover") return { accounts: ["local"] };
      throw new Error(`unexpected path ${path}`);
    });

    await expect(
      runAdd(
        [localDescriptor],
        [onBoth],
        "notes-synth",
        fakePrompts(),
        "assume-yes",
        devices,
        "/srv/fixture-host/reconfigured",
      ),
    ).rejects.toThrow("Change its member settings explicitly with PATCH");
    expect(mocks.gatewayFetch).not.toHaveBeenCalled();
  });

  test("a refused member edit does not write either configured account", async () => {
    const localDescriptor = descriptor("mail-synth", "Synthetic mail", {
      params: [
        {
          name: "sessionsPath",
          label: "Sessions directory",
          type: "path",
          scope: "member",
        },
      ],
    });
    const first = {
      ...mailOnLaptop,
      id: "mail-synth:first@example.com",
      multiDeviceMode: "partitioned" as const,
      members: ["dev-laptop", "dev-mini"],
    };
    const second = { ...first, id: "mail-synth:second@example.com" };
    mocks.fetchDescriptors.mockResolvedValue({
      deviceId: "dev-mini",
      collectorHostname: "studio.example",
      items: [localDescriptor],
    });
    mocks.gatewayJson.mockImplementation(async (path: string) => {
      if (path === "/admin/sources/validate-param") return { valid: true };
      if (path === "/admin/sources/discover") {
        return { accounts: ["first@example.com", "second@example.com"] };
      }
      throw new Error(`unexpected path ${path}`);
    });
    await expect(
      runAdd(
        [localDescriptor],
        [first, second],
        "mail-synth",
        fakePrompts(),
        "assume-yes",
        devices,
        "/srv/fixture-host/sessions",
      ),
    ).rejects.toThrow("Change its member settings explicitly with PATCH");

    expect(mocks.gatewayFetch).not.toHaveBeenCalled();
  });

  test("declining the question leaves the source alone; --yes answers it", async () => {
    const prompts = fakePrompts({ confirm: vi.fn().mockResolvedValue(false) });
    await runAdd([notesDescriptor], [notesOnLaptop], "notes-synth", prompts);
    expect(mocks.gatewayFetch).not.toHaveBeenCalled();
    expect(logged.join("\n")).toContain("Left as is.");

    await runAdd([notesDescriptor], [notesOnLaptop], "notes-synth", prompts, "assume-yes");
    expect(prompts.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.gatewayFetch).toHaveBeenCalledTimes(1);
  });

  test("no terminal and no --yes refuses the join instead of committing it unasked", async () => {
    // A provisioning script must not make this machine a member of a source
    // another one hosts without having said so.
    const prompts = fakePrompts();
    await expect(
      runAdd([notesDescriptor], [notesOnLaptop], "notes-synth", prompts, "no-terminal"),
    ).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining("Re-run with --yes to authorise the join."),
    });
    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(mocks.gatewayFetch).not.toHaveBeenCalled();
    expect(
      mocks.gatewayJson.mock.calls.find(([path]) => path === "/admin/sources/add"),
    ).toBeUndefined();
  });

  test("an exclusive source on another device is refused before any auth, naming the host and the move", async () => {
    mocks.gatewayJson.mockImplementation(async (path: string) => {
      if (path === "/admin/sources/discover") return { accounts: ["maya@example.com"] };
      throw new Error(`unexpected path ${path}`);
    });
    await expect(runAdd([mailDescriptor], [mailOnLaptop], "mail-synth")).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining("hosted by Maya-Laptop"),
    });
    await expect(runAdd([mailDescriptor], [mailOnLaptop], "mail-synth")).rejects.toMatchObject({
      message: expect.stringContaining(
        "omnesis sources move mail-synth:maya@example.com --device Studio-Mini",
      ),
    });
    expect(mocks.gatewayFetch).not.toHaveBeenCalled();
    const authCall = mocks.gatewayJson.mock.calls.find(([path]) => path === "/admin/auth-flows");
    expect(authCall).toBeUndefined();
  });

  test("a source this device already hosts is reported and left alone", async () => {
    const onMini = { ...notesOnLaptop, deviceId: "dev-mini", members: ["dev-mini"] };
    await runAdd([notesDescriptor], [onMini], "notes-synth");
    expect(logged.join("\n")).toContain("notes-synth:local is already configured on Studio-Mini");
    expect(mocks.gatewayFetch).not.toHaveBeenCalled();
    const addCall = mocks.gatewayJson.mock.calls.find(([path]) => path === "/admin/sources/add");
    expect(addCall).toBeUndefined();
  });

  test("a device the listing does not admit is refused with the candidates", async () => {
    await expect(
      runAdd([notesDescriptor], [{ ...notesOnLaptop, joinCandidates: [] }], "notes-synth"),
    ).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining("Studio-Mini cannot host notes-synth:local"),
    });
    expect(mocks.gatewayFetch).not.toHaveBeenCalled();
  });

  test("a paused source this device hosts names the command that starts it again", async () => {
    // The phone's opt-out pauses a source it alone hosts, so this is the
    // operator's own recovery path: adding it again changes nothing, and
    // saying only "already configured" leaves them with nowhere to go.
    const paused: AdminSourceEntry = {
      ...notesOnLaptop,
      deviceId: "dev-mini",
      members: ["dev-mini"],
      enabled: false,
    };
    await runAdd([notesDescriptor], [paused], "notes-synth");

    const text = logged.join("\n");
    expect(text).toContain(
      "notes-synth:local is already configured on Studio-Mini, but its sync is paused",
    );
    expect(text).toContain("omnesis sources resume notes-synth:local");
    expect(mocks.gatewayFetch).not.toHaveBeenCalled();
    expect(
      mocks.gatewayJson.mock.calls.find(([path]) => path === "/admin/sources/add"),
    ).toBeUndefined();
  });

  test("a paused exact account on another host is refused with resume guidance", async () => {
    mocks.gatewayJson.mockImplementation(async (path: string) => {
      if (path === "/admin/sources/discover") return { accounts: ["local"] };
      throw new Error(`unexpected path ${path}`);
    });
    await expect(
      runAdd([notesDescriptor], [{ ...notesOnLaptop, enabled: false }], "notes-synth"),
    ).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining("resume it before adding it to Studio-Mini"),
    });
    expect(mocks.gatewayFetch).not.toHaveBeenCalled();
  });

  test("a target device the listing does not carry is refused without inventing its kind", async () => {
    mocks.gatewayJson.mockImplementation(async (path: string) => {
      if (path === "/admin/sources/discover") return { accounts: ["maya@example.com"] };
      throw new Error(`unexpected path ${path}`);
    });
    let failure: Error | undefined;
    try {
      await runAdd([mailDescriptor], [mailOnLaptop], "mail-synth", fakePrompts(), "ask", [
        devices[0]!,
      ]);
    } catch (err) {
      failure = err as Error;
    }

    expect(failure?.message).toContain("hosted by Maya-Laptop");
    // dev-mini is not in the listing: nothing is known about what it is, so
    // neither the collector's move command nor a kind sentence is printed.
    expect(failure?.message).not.toContain("omnesis sources move");
    expect(failure?.message).not.toContain("device and cannot host it");
  });

  test("a gateway that will not list sources degrades the add rather than failing it", async () => {
    const { loadListingForAdd } = await import("./add.js");
    mocks.gatewayJson.mockRejectedValue(new Error("gateway unreachable"));
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: string) => {
      errors.push(String(line));
    });

    await expect(loadListingForAdd()).resolves.toEqual({ sources: [], devices: [] });
    const text = errors.join("\n");
    expect(text).toContain("gateway unreachable");
    expect(text).toContain("rather than a join");
  });

  test("a join, a refusal and a fresh account in one add: all three are carried out", async () => {
    // The refusal is the whole point: it used to end the add, so the join
    // that had already landed went unreported and the brand-new account was
    // never added at all.
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: string) => {
      errors.push(String(line));
    });
    const joinable: AdminSourceEntry = {
      ...notesOnLaptop,
      id: "mail-synth:maya@example.com",
      type: "mail-synth",
    };
    const locked: AdminSourceEntry = {
      ...mailOnLaptop,
      id: "mail-synth:jamie@example.com",
    };
    mocks.gatewayJson.mockImplementation(async (path: string) => {
      if (path === "/admin/sources/discover") {
        return { accounts: ["maya@example.com", "jamie@example.com", "david@example.com"] };
      }
      if (path === "/admin/sources/add") return { sourceIds: ["mail-synth:david@example.com"] };
      throw new Error(`unexpected path ${path}`);
    });
    mocks.gatewayFetch.mockResolvedValue(
      jsonResponse(200, { source: joinable, members: ["dev-laptop", "dev-mini"] }),
    );

    await runAdd([mailDescriptor], [joinable, locked], "mail-synth");

    // The joinable account was joined.
    expect(mocks.gatewayFetch).toHaveBeenCalledWith(
      "/admin/sources/mail-synth%3Amaya%40example.com/members",
      { method: "POST", body: JSON.stringify({ deviceId: "dev-mini" }) },
    );
    expect(logged.join("\n")).toContain("Studio-Mini joined mail-synth:maya@example.com");
    // The fresh account was added — the refusal no longer drops it.
    const addCall = mocks.gatewayJson.mock.calls.find(([path]) => path === "/admin/sources/add");
    expect(JSON.parse(String(addCall?.[1]?.body))).toMatchObject({
      accountIds: ["david@example.com"],
    });
    expect(logged.join("\n")).toContain("Synthetic mail added successfully!");
    // And the refusal is still stated, with the command that resolves it.
    const reported = errors.join("\n");
    expect(reported).toContain(
      "mail-synth:jamie@example.com is hosted by Maya-Laptop and its type allows one host at a time.",
    );
    expect(reported).toContain(
      "omnesis sources move mail-synth:jamie@example.com --device Studio-Mini",
    );
  });

  test("a new account of a type with accounts elsewhere is still added", async () => {
    mocks.gatewayJson.mockImplementation(async (path: string) => {
      if (path === "/admin/sources/discover") return { accounts: ["studio@example.com"] };
      if (path === "/admin/sources/add") return { sourceIds: ["mail-synth:studio@example.com"] };
      throw new Error(`unexpected path ${path}`);
    });
    await runAdd([mailDescriptor], [mailOnLaptop], "mail-synth");
    const addCall = mocks.gatewayJson.mock.calls.find(([path]) => path === "/admin/sources/add");
    expect(JSON.parse(String(addCall?.[1]?.body))).toMatchObject({
      deviceId: "dev-mini",
      descriptorId: "mail-synth",
      accountIds: ["studio@example.com"],
    });
    expect(mocks.gatewayFetch).not.toHaveBeenCalled();
  });
});
