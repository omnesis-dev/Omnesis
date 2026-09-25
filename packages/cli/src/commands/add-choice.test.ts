// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  describeAccountChoice,
  describeAddChoice,
  joinModeSentence,
  renderAddChoice,
} from "./add-choice.js";
import type { AdminDeviceEntry, AdminSourceEntry } from "./members.js";

const devices: AdminDeviceEntry[] = [
  { id: "dev-laptop", name: "Maya-Laptop", kind: "collector", online: true },
  { id: "dev-mini", name: "Studio-Mini", kind: "collector", online: false },
  { id: "dev-phone", name: "Maya-Phone", kind: "ios", online: true },
];

const notes: AdminSourceEntry = {
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

const mail: AdminSourceEntry = {
  ...notes,
  id: "mail-synth:maya@example.com",
  type: "mail-synth",
  multiDeviceMode: "exclusive",
  joinCandidates: [],
};

const mailOnMini: AdminSourceEntry = {
  ...mail,
  id: "mail-synth:studio@example.com",
  deviceId: "dev-mini",
  members: ["dev-mini"],
  multiDeviceMode: "handoff",
  joinCandidates: ["dev-laptop"],
};

const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

describe("describeAccountChoice", () => {
  test("the owner and every member are members; the rest read the host and the mode", () => {
    expect(describeAccountChoice(notes, "dev-laptop", devices)).toEqual({ kind: "member" });
    expect(
      describeAccountChoice({ ...notes, members: ["dev-laptop", "dev-mini"] }, "dev-mini", devices),
    ).toEqual({ kind: "member" });
    expect(describeAccountChoice(notes, "dev-mini", devices)).toEqual({
      kind: "join",
      hostName: "Maya-Laptop",
      mode: "replicated",
      candidate: true,
    });
    expect(describeAccountChoice(mail, "dev-mini", devices)).toEqual({
      kind: "exclusive",
      hostName: "Maya-Laptop",
    });
  });

  test("a device outside the gateway's candidates is not one; a listing without candidates defers", () => {
    expect(describeAccountChoice(notes, "dev-phone", devices)).toMatchObject({
      kind: "join",
      candidate: false,
    });
    expect(
      describeAccountChoice({ ...notes, joinCandidates: undefined }, "dev-phone", devices),
    ).toMatchObject({ kind: "join", candidate: true });
  });

  test("a listing that does not name a mode is read as the mode that admits no second host", () => {
    // The field is absent from a gateway whose listing predates it. Reading
    // that as a join would offer one the gateway then refuses; exclusive is
    // the only assumption that cannot mislead.
    const modeless: AdminSourceEntry = { ...notes, multiDeviceMode: undefined };
    expect(describeAccountChoice(modeless, "dev-mini", devices)).toEqual({
      kind: "exclusive",
      hostName: "Maya-Laptop",
    });
    expect(
      describeAddChoice(
        { id: "notes-synth", singleInstance: true },
        [modeless],
        "dev-mini",
        devices,
      ),
    ).toEqual({
      kind: "accounts",
      here: 0,
      elsewhere: 1,
      hostNames: ["Maya-Laptop"],
      singleInstance: true,
    });
  });

  test("no device chosen yet: never a member, always a candidate, host still named", () => {
    expect(describeAccountChoice(notes, null, devices)).toEqual({
      kind: "join",
      hostName: "Maya-Laptop",
      mode: "replicated",
      candidate: true,
    });
  });
});

describe("describeAddChoice", () => {
  test("nothing of the type is an add", () => {
    expect(
      describeAddChoice({ id: "notes-synth", singleInstance: true }, [mail], "dev-mini", devices),
    ).toEqual({ kind: "add" });
  });

  test("a single-instance type is complete here or unresolved until this host discovers its account", () => {
    const desc = { id: "notes-synth", singleInstance: true };
    expect(describeAddChoice(desc, [notes], "dev-laptop", devices)).toEqual({
      kind: "member",
      source: notes,
    });
    expect(describeAddChoice(desc, [notes], "dev-mini", devices)).toEqual({
      kind: "accounts",
      here: 0,
      elsewhere: 1,
      hostNames: ["Maya-Laptop"],
      singleInstance: true,
    });
    expect(
      describeAddChoice({ id: "mail-synth", singleInstance: true }, [mail], "dev-mini", devices),
    ).toEqual({
      kind: "accounts",
      here: 0,
      elsewhere: 1,
      hostNames: ["Maya-Laptop"],
      singleInstance: true,
    });
  });

  test("a type that takes several accounts counts them here and elsewhere, never blocking an add", () => {
    const desc = { id: "mail-synth", singleInstance: false };
    expect(describeAddChoice(desc, [mail, mailOnMini], "dev-laptop", devices)).toEqual({
      kind: "accounts",
      here: 1,
      elsewhere: 1,
      hostNames: ["Studio-Mini"],
      singleInstance: false,
    });
    expect(describeAddChoice(desc, [mail, mailOnMini], null, devices)).toEqual({
      kind: "accounts",
      here: 0,
      elsewhere: 2,
      hostNames: ["Maya-Laptop", "Studio-Mini"],
      singleInstance: false,
    });
  });
});

describe("joinModeSentence", () => {
  test("says what each mode makes of a second member, for the CLI's device or a named one", () => {
    expect(joinModeSentence("handoff")).toBe(
      "Sync hands off to whichever machine is awake; this device needs its own sign-in.",
    );
    expect(joinModeSentence("replicated")).toBe(
      "This device syncs its own copy alongside the others.",
    );
    expect(joinModeSentence("partitioned", "Studio-Mini")).toBe(
      "Studio-Mini contributes its own stream.",
    );
    expect(joinModeSentence("exclusive")).toBe(
      "This device would become a second host, which the type does not allow.",
    );
  });
});

describe("renderAddChoice", () => {
  const opts = { description: "Synthetic notes", another: "add another account" };

  test("each state has its picker words", () => {
    expect(renderAddChoice({ kind: "add" }, opts)).toEqual({ suffix: "", hint: "Synthetic notes" });
    expect(plain(renderAddChoice({ kind: "member", source: notes }, opts).suffix)).toBe(
      " · already a member",
    );
  });

  test("accounts read as a count here, and as where the others are", () => {
    expect(
      renderAddChoice(
        { kind: "accounts", here: 2, elsewhere: 0, hostNames: [], singleInstance: false },
        opts,
      ),
    ).toEqual({ suffix: " (2 configured)", hint: "add another account" });
    expect(
      renderAddChoice(
        {
          kind: "accounts",
          here: 1,
          elsewhere: 1,
          hostNames: ["Studio-Mini"],
          singleInstance: false,
        },
        opts,
      ),
    ).toEqual({
      suffix: " (1 configured, 1 on Studio-Mini)",
      hint: "add another account, or join one",
    });
    expect(
      renderAddChoice(
        {
          kind: "accounts",
          here: 0,
          elsewhere: 2,
          hostNames: ["Maya-Laptop", "Studio-Mini"],
          singleInstance: false,
        },
        { ...opts, another: "add another" },
      ),
    ).toEqual({ suffix: " (2 on Maya-Laptop, Studio-Mini)", hint: "add another, or join one" });
    expect(
      renderAddChoice(
        {
          kind: "accounts",
          here: 0,
          elsewhere: 1,
          hostNames: ["Maya-Laptop"],
          singleInstance: true,
        },
        opts,
      ),
    ).toEqual({
      suffix: " (1 on Maya-Laptop)",
      hint: "set up this device's account, or join an existing one",
    });
  });
});
