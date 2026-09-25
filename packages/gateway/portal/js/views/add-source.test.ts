// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The add picker's view of a descriptor against what the gateway already
 * lists: which tiles are adds, which are joins, which are moves, and which
 * are done — and the words each state is given.
 */

import { describe, expect, test, vi } from "vitest";
import {
  accountRefusal,
  describeAccountChoice,
  describeTileState,
  deviceName,
  devicesForAddState,
  joinModeSentence,
  localAccountId,
  moveSentence,
  moveTargets,
  memberConfigForDescriptor,
  memberUpdateOutcome,
  splitConfiguredAccounts,
  shouldValidateParam,
  tileStateLabel,
  paramHint,
  // @ts-expect-error — sibling .js modules, no .d.ts in the portal tree.
} from "./add-source.js";

describe("parameter validation routing", () => {
  test("a source may validate an optional blank value when it auto-detects a local default", () => {
    expect(shouldValidateParam({ required: false, validateWhenEmpty: true }, "")).toBe(true);
    expect(shouldValidateParam({ required: false }, "")).toBe(false);
    expect(shouldValidateParam({ required: false }, "/srv/example/main.sqlite")).toBe(true);
  });
});

describe("local account identity", () => {
  test("resolves a path-based account on the selected collector", async () => {
    const resolve = vi.fn(async () => ({ accountId: "vault-identity" }));
    await expect(
      localAccountId(
        { id: "vault-synth", hasResolveAccountId: true },
        "dev-laptop",
        { vaultPath: "/srv/example/vault" },
        resolve,
      ),
    ).resolves.toBe("vault-identity");
    expect(resolve).toHaveBeenCalledWith({
      deviceId: "dev-laptop",
      descriptorId: "vault-synth",
      params: { vaultPath: "/srv/example/vault" },
    });
  });

  test("other local sources keep their fixed account ID", async () => {
    const resolve = vi.fn();
    await expect(localAccountId({ id: "files-synth" }, "dev-laptop", {}, resolve)).resolves.toBe(
      "local",
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  test("an empty collector response cannot fall back to an unrelated account", async () => {
    await expect(
      localAccountId(
        { id: "vault-synth", hasResolveAccountId: true },
        "dev-laptop",
        { vaultPath: "/srv/example/vault" },
        async () => ({}),
      ),
    ).rejects.toThrow("did not resolve an account ID");
  });
});

const devices = [
  { id: "dev-laptop", name: "Maya-Laptop", kind: "collector", online: true, revokedAt: null },
  { id: "dev-mini", name: "Studio-Mini", kind: "collector", online: false, revokedAt: null },
  { id: "dev-phone", name: "Maya-Phone", kind: "ios", online: true, revokedAt: null },
  { id: "dev-old", name: "Old-Box", kind: "collector", online: false, revokedAt: 1_700_000_000 },
];

const notesDescriptor = {
  id: "notes-synth",
  name: "Synthetic notes",
  singleInstance: true,
  devices: [{ id: "dev-laptop", name: "Maya-Laptop" }],
};

const mailDescriptor = { ...notesDescriptor, id: "mail-synth", name: "Synthetic mail", singleInstance: false };

const notesOnLaptop = {
  id: "notes-synth:local",
  type: "notes-synth",
  deviceId: "dev-laptop",
  enabled: true,
  members: ["dev-laptop"],
  multiDeviceMode: "replicated",
  joinCandidates: ["dev-mini"],
  pushBased: false,
};

const mailOnLaptop = {
  ...notesOnLaptop,
  id: "mail-synth:maya@example.com",
  type: "mail-synth",
  multiDeviceMode: "exclusive",
  joinCandidates: [],
};

describe("describeTileState", () => {
  test("nothing listed is an add; a type with accounts counts them", () => {
    expect(describeTileState(notesDescriptor, [], devices)).toEqual({ kind: "add" });
    expect(describeTileState(mailDescriptor, [mailOnLaptop], devices)).toEqual({
      kind: "accounts",
      count: 1,
      paused: 0,
    });
  });

  test("a single-instance source is discovered on a free advertising device before add or join", () => {
    const onlineDevices = devices.map((device) =>
      device.id === "dev-mini" ? { ...device, online: true } : device,
    );
    const advertised = {
      ...notesDescriptor,
      devices: [
        { id: "dev-laptop", name: "Maya-Laptop" },
        { id: "dev-mini", name: "Studio-Mini" },
      ],
    };
    const state = describeTileState(advertised, [notesOnLaptop], onlineDevices);
    expect(state).toEqual({
      kind: "accounts",
      count: 1,
      paused: 0,
      singleInstance: true,
      devices: [{ id: "dev-mini", name: "Studio-Mini" }],
    });
    expect(devicesForAddState(advertised, state)).toEqual([
      { id: "dev-mini", name: "Studio-Mini" },
    ]);
    expect(
      splitConfiguredAccounts("notes-synth", ["studio"], [notesOnLaptop]),
    ).toEqual({ fresh: ["studio"], configured: [] });
    expect(
      splitConfiguredAccounts("notes-synth", ["local"], [notesOnLaptop]),
    ).toEqual({ fresh: [], configured: [notesOnLaptop] });
  });

  test("a single-instance setup excludes every device already hosting that source type", () => {
    const notesOnMini = {
      ...notesOnLaptop,
      id: "notes-synth:studio",
      deviceId: "dev-mini",
      members: ["dev-mini"],
    };
    const advertised = {
      ...notesDescriptor,
      devices: [
        { id: "dev-laptop", name: "Maya-Laptop" },
        { id: "dev-mini", name: "Studio-Mini" },
      ],
    };

    expect(describeTileState(advertised, [notesOnLaptop, notesOnMini], devices)).toEqual({
      kind: "configured",
      hostName: "Maya-Laptop",
    });
  });

  test("an offline join destination leaves a configured source inert", () => {
    expect(describeTileState(notesDescriptor, [notesOnLaptop], devices)).toEqual({
      kind: "configured",
      hostName: "Maya-Laptop",
    });
  });

  test("an existing member with a host-local param can reopen configuration", () => {
    const descriptor = {
      ...notesDescriptor,
      params: [{ name: "sessionsPath", scope: "member" }],
    };
    const configured = {
      ...notesOnLaptop,
      members: ["dev-laptop", "dev-mini"],
      joinCandidates: [],
    };

    expect(describeTileState(descriptor, [configured], devices)).toEqual({
      kind: "configure",
      source: configured,
      hostName: "Maya-Laptop",
      members: [devices[0]],
      memberCount: 2,
    });
  });

  test("an offline member does not block setup on a different advertising host", () => {
    const descriptor = {
      ...notesDescriptor,
      params: [{ name: "sessionsPath", scope: "member" }],
    };
    const offlineOnly = {
      ...notesOnLaptop,
      deviceId: "dev-mini",
      members: ["dev-mini"],
      joinCandidates: [],
    };

    expect(describeTileState(descriptor, [offlineOnly], devices)).toEqual({
      kind: "accounts",
      count: 1,
      paused: 0,
      singleInstance: true,
      devices: [{ id: "dev-laptop", name: "Maya-Laptop" }],
    });
  });

  test("join remains available while exposing existing member settings", () => {
    const descriptor = {
      ...notesDescriptor,
      params: [{ name: "sessionsPath", scope: "member" }],
    };
    const onlineDevices = devices.map((device) =>
      device.id === "dev-mini" ? { ...device, online: true } : device,
    );

    expect(describeTileState(descriptor, [notesOnLaptop], onlineDevices)).toEqual({
      kind: "join",
      source: notesOnLaptop,
      hostName: "Maya-Laptop",
      candidates: [{ id: "dev-mini", name: "Studio-Mini", kind: "collector", online: true }],
      members: [onlineDevices[0]],
    });
  });

  test("a single-instance source nobody could join or take over is configured, inert", () => {
    const nobody = { ...notesOnLaptop, joinCandidates: [] };
    expect(describeTileState(notesDescriptor, [nobody], devices)).toEqual({
      kind: "configured",
      hostName: "Maya-Laptop",
    });
    const oneCollector = devices.filter((d) => d.id !== "dev-mini");
    const exclusive = { ...notesOnLaptop, multiDeviceMode: "exclusive", joinCandidates: [] };
    expect(describeTileState(notesDescriptor, [exclusive], oneCollector)).toEqual({
      kind: "configured",
      hostName: "Maya-Laptop",
    });
    // A source a phone pushes stays with the phone: no move, however many collectors.
    const pushed = { ...exclusive, pushBased: true };
    expect(describeTileState(notesDescriptor, [pushed], devices)).toEqual({
      kind: "configured",
      hostName: "Maya-Laptop",
    });
  });

  test("an exclusive single-instance source is a move when another online collector could take it", () => {
    const exclusive = { ...notesOnLaptop, multiDeviceMode: "exclusive", joinCandidates: [] };
    const onlineDevices = devices.map((device) =>
      device.id === "dev-mini" ? { ...device, online: true } : device,
    );
    expect(describeTileState(notesDescriptor, [exclusive], onlineDevices)).toEqual({
      kind: "exclusive",
      source: exclusive,
      hostName: "Maya-Laptop",
    });
    // An advertising collector that does not host the type is a setup target:
    // discovery decides whether its one local instance is this account or a
    // separate one. A device that is not online stays unavailable.
    const twoAdvertisers = {
      ...notesDescriptor,
      devices: [
        { id: "dev-laptop", name: "Maya-Laptop" },
        { id: "dev-mini", name: "Studio-Mini" },
      ],
    };
    const onlyHost = devices.filter((d) => d.kind !== "collector" || d.id === "dev-laptop");
    expect(describeTileState(twoAdvertisers, [exclusive], onlyHost)).toEqual({
      kind: "configured",
      hostName: "Maya-Laptop",
    });
  });

  test("a descriptor can explicitly enable its desired multi-device mode on stored exclusive data", () => {
    const descriptor = { ...notesDescriptor, multiDeviceMode: "partitioned" };
    const stored = { ...notesOnLaptop, multiDeviceMode: "exclusive", joinCandidates: [] };

    expect(describeTileState(descriptor, [stored], devices)).toEqual({
      kind: "enable",
      source: stored,
      hostName: "Maya-Laptop",
      desiredMode: "partitioned",
    });
    expect(tileStateLabel({ kind: "enable", desiredMode: "partitioned" })).toBe(
      "enable partitioned mode",
    );
  });

  test("a paused single-instance source is a resume, not an add", () => {
    // The row exists, so an add would collide with it. The picker offers the
    // one thing that gets the operator what they came for.
    const paused = { ...notesOnLaptop, enabled: false };
    expect(describeTileState(notesDescriptor, [paused], devices)).toEqual({
      kind: "paused",
      source: paused,
      hostName: "Maya-Laptop",
    });
    // A type that takes several accounts stays addable, and says how many of
    // the rows it counts are paused.
    expect(
      describeTileState(mailDescriptor, [{ ...mailOnLaptop, enabled: false }], devices),
    ).toEqual({ kind: "accounts", count: 1, paused: 1 });
  });

  test("rows are matched by type, the key the gateway stamps them with", () => {
    // An id that merely starts with the descriptor id belongs to another type.
    const otherType = { ...notesOnLaptop, id: "notes-synth-archive:local", type: "notes-synth-archive" };
    expect(describeTileState(notesDescriptor, [otherType], devices)).toEqual({ kind: "add" });
  });

  test("a host the device list no longer pairs is named as such, never as an ordinary one", () => {
    const forgotten = { ...notesOnLaptop, deviceId: "dev-gone-forever", members: ["dev-gone-forever"], joinCandidates: [] };
    expect(describeTileState({ ...notesDescriptor, devices: [] }, [forgotten], devices)).toMatchObject({
      hostName: "dev-gone (forgotten)",
    });
    expect(deviceName(devices, "dev-old")).toBe("Old-Box (revoked)");
    expect(deviceName(devices, "dev-laptop")).toBe("Maya-Laptop");
  });
});

describe("tileStateLabel", () => {
  test("one line per state, in the picker's vocabulary", () => {
    expect(tileStateLabel({ kind: "add" })).toBe("add");
    expect(tileStateLabel({ kind: "accounts", count: 2, paused: 0 })).toBe("2 configured");
    expect(tileStateLabel({ kind: "accounts", count: 2, paused: 1 })).toBe(
      "2 configured · 1 paused",
    );
    expect(tileStateLabel({ kind: "accounts", count: 1, paused: 0, singleInstance: true })).toBe(
      "1 configured · set up on another device",
    );
    expect(tileStateLabel({ kind: "paused", hostName: "Maya-Laptop" })).toBe(
      "resume · paused on Maya-Laptop",
    );
    expect(tileStateLabel({ kind: "join", hostName: "Maya-Laptop" })).toBe(
      "join · configured on Maya-Laptop",
    );
    expect(tileStateLabel({ kind: "exclusive", hostName: "Maya-Laptop" })).toBe(
      "move… · exclusive, lives on Maya-Laptop",
    );
    expect(tileStateLabel({ kind: "configure", memberCount: 1 })).toBe(
      "configured on 1 device",
    );
    expect(tileStateLabel({ kind: "configure", memberCount: 3 })).toBe(
      "configured on 3 devices",
    );
    expect(tileStateLabel({ kind: "configured", hostName: "Maya-Laptop" })).toBe(
      "configured on Maya-Laptop",
    );
  });
});

describe("the sentences", () => {
  test("each mode says what a join makes of the named device", () => {
    expect(joinModeSentence("handoff", "Studio-Mini")).toBe(
      "Sync hands off to whichever machine is awake; Studio-Mini needs its own sign-in.",
    );
    expect(joinModeSentence("replicated", "Studio-Mini")).toBe(
      "Studio-Mini syncs its own copy alongside the others.",
    );
    expect(joinModeSentence("partitioned", "Studio-Mini")).toBe(
      "Studio-Mini contributes its own stream.",
    );
  });

  test("a move names both hosts, and says once what happens to credentials", () => {
    const text = moveSentence(mailOnLaptop, "Maya-Laptop", "Studio-Mini");
    expect(text).toContain("Studio-Mini takes over mail-synth:maya@example.com");
    expect(text).toContain("Maya-Laptop stops syncing it");
    // One truth about credentials: they do not travel, so the new host signs
    // in for itself. The sentence must not also claim they stay available.
    expect(text).toContain("credentials do not travel");
    expect(text).toContain("sign in on Studio-Mini");
    expect(text).not.toContain("credentials stay");
  });
});

describe("splitConfiguredAccounts and moveTargets", () => {
  test("a discovered existing-member edit is tracked as an update, never a join", () => {
    expect(memberUpdateOutcome(notesOnLaptop, devices[0])).toEqual({
      kind: "updated",
      source: notesOnLaptop,
      device: devices[0],
    });
  });

  test("an advanced host-local setting still reaches member config", () => {
    // The form's parameter list omits advanced settings, so it cannot be the
    // key: a value for one would otherwise land in the shared config, which
    // the gateway then refuses to store.
    expect(
      memberConfigForDescriptor(
        { params: [{ name: "sharedLabel", scope: "source" }], memberScopedParamNames: ["overrideDir"] },
        { sharedLabel: "fictional-team", overrideDir: "/srv/fixture-host/override" },
      ),
    ).toEqual({ params: { overrideDir: "/srv/fixture-host/override" } });
  });

  test("a descriptor from an older gateway falls back to what its form declares", () => {
    expect(
      memberConfigForDescriptor(
        { params: [{ name: "sessionsPath", scope: "member" }] },
        { sessionsPath: "/srv/fixture-host/sessions" },
      ),
    ).toEqual({ params: { sessionsPath: "/srv/fixture-host/sessions" } });
  });

  test("member config contains only descriptor-declared member params", () => {
    expect(
      memberConfigForDescriptor(
        {
          params: [
            { name: "sharedLabel", scope: "source" },
            { name: "sessionsPath", scope: "member" },
          ],
        },
        {
          sharedLabel: "fictional-team",
          sessionsPath: "/srv/fixture-host/sessions",
        },
      ),
    ).toEqual({ params: { sessionsPath: "/srv/fixture-host/sessions" } });
  });

  test("accounts the gateway lists come back as rows; the rest are fresh", () => {
    expect(
      splitConfiguredAccounts("mail-synth", ["maya@example.com", "studio@example.com"], [
        mailOnLaptop,
      ]),
    ).toEqual({ fresh: ["studio@example.com"], configured: [mailOnLaptop] });
  });

  test("a move goes to an available paired collector other than the host — never an offline box, phone, or revoked box", () => {
    expect(moveTargets(mailOnLaptop, devices)).toEqual([]);
    const available = devices.map((d) =>
      d.id === "dev-mini" ? { ...d, online: true } : d,
    );
    expect(moveTargets(mailOnLaptop, available).map((d: { id: string }) => d.id)).toEqual([
      "dev-mini",
    ]);
    const picky = available.map((d) =>
      d.id === "dev-mini" ? { ...d, capabilities: { hostableSourceTypes: ["notes-synth"] } } : d,
    );
    expect(moveTargets(mailOnLaptop, picky)).toEqual([]);
  });

  test("a collector from an older gateway with no online field remains a move target", () => {
    const legacyDevices = devices.map(({ online: _online, ...device }) => device);
    expect(moveTargets(mailOnLaptop, legacyDevices).map((d: { id: string }) => d.id)).toEqual([
      "dev-mini",
    ]);
  });
});

describe("describeAccountChoice and its refusals", () => {
  test("an account the device already hosts is a member, paused or not", () => {
    expect(describeAccountChoice(notesOnLaptop, "dev-laptop", devices)).toEqual({
      kind: "member",
      paused: false,
    });
    expect(describeAccountChoice({ ...notesOnLaptop, enabled: false }, "dev-laptop", devices)).toEqual(
      { kind: "member", paused: true },
    );
  });

  test("an account another device hosts is a join, or a refusal when the type allows one host", () => {
    expect(describeAccountChoice(notesOnLaptop, "dev-mini", devices)).toEqual({
      kind: "join",
      hostName: "Maya-Laptop",
      mode: "replicated",
    });
    expect(describeAccountChoice(mailOnLaptop, "dev-mini", devices)).toEqual({
      kind: "exclusive",
      hostName: "Maya-Laptop",
    });
    // A row that states no mode is read as exclusive, the same way the join
    // candidates are: the client never assumes a second host is admitted.
    const { multiDeviceMode: _mode, ...unstated } = notesOnLaptop;
    expect(describeAccountChoice(unstated, "dev-mini", devices)).toMatchObject({
      kind: "exclusive",
    });
  });

  test("a paused account on another host must be resumed before it can be joined", () => {
    const choice = describeAccountChoice(
      { ...notesOnLaptop, enabled: false },
      "dev-mini",
      devices,
    );
    expect(choice).toEqual({ kind: "paused", hostName: "Maya-Laptop" });
    expect(accountRefusal(choice, "Studio-Mini")).toContain(
      "resume it from the Sources page before adding it to Studio-Mini",
    );
  });

  test("each refusal names the way out rather than just saying no", () => {
    expect(accountRefusal({ kind: "member", paused: false }, "Studio-Mini")).toBe(
      "Already configured on Studio-Mini. Change its device settings through an explicit update.",
    );
    expect(accountRefusal({ kind: "member", paused: true }, "Studio-Mini")).toContain(
      "paused — resume it from the Sources page",
    );
    const exclusive = accountRefusal({ kind: "exclusive", hostName: "Maya-Laptop" }, "Studio-Mini");
    expect(exclusive).toContain("Hosted by Maya-Laptop");
    expect(exclusive).toContain("Move it from the Sources page to put it on Studio-Mini");
  });
});

describe("the line under a settings input", () => {
  test("a source's own explanation wins", () => {
    // Only the source can say what its setting means, or what happens if the
    // operator leaves it alone. A shared form that guessed would be guessing
    // per source, which is how source-specific copy ends up in shared UI.
    expect(paramHint({ type: "path", help: "Leave blank to use this machine's own." })).toBe(
      "Leave blank to use this machine's own.",
    );
  });

  test("a path with nothing declared still says what shapes are accepted", () => {
    // The form is the only place an operator learns that a home-relative path
    // is allowed at all.
    expect(paramHint({ type: "path" })).toMatch(/~/);
  });

  test("an ordinary field gets no line, rather than an empty one", () => {
    expect(paramHint({ type: "string" })).toBeNull();
  });
});
