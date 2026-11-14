// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  RESYNC_FROM_SCRATCH,
  RESYNC_IN_PLACE,
  defaultResyncMode,
  resyncOptions,
  // @ts-expect-error — sibling .js module, no .d.ts in the portal tree.
} from "./resync-options.js";

interface Mode {
  id: string;
  title: string;
  body: string;
  note: string | null;
}
interface Options {
  modes: Mode[];
  footnote: string | null;
}

const source = {
  id: "mail-synth:maya@example.com",
  multiDeviceMode: "exclusive",
  resyncModes: [RESYNC_IN_PLACE, RESYNC_FROM_SCRATCH],
};
const label = "mail-synth";
const phone = { id: "dev-phone", name: "Maya-Phone" };

describe("resyncOptions for the whole source", () => {
  test("offers both modes, in place first, in plain words that name the source", () => {
    const { modes, footnote } = resyncOptions({ source, label }) as Options;
    expect(modes.map((m) => [m.id, m.title])).toEqual([
      [RESYNC_IN_PLACE, "In place"],
      [RESYNC_FROM_SCRATCH, "From scratch"],
    ]);
    expect(modes[0]!.body).toBe(
      "Reads mail-synth again and updates what is already here. Your records keep their place, anything you deleted stays deleted, and search keeps working meanwhile.",
    );
    expect(modes[1]!.body).toBe(
      "Deletes everything indexed from mail-synth, then imports it again. Search for this source is empty until it finishes, and items you had deleted one by one come back.",
    );
    expect(footnote).toBe(
      "In place never deletes, so it does not clear duplicate or stray records. From scratch is the tool for that.",
    );
  });

  test("mentions the Brain only when told the gateway runs it, and only under from scratch", () => {
    const quiet = resyncOptions({ source, label }) as Options;
    expect(quiet.modes.every((m) => m.note === null)).toBe(true);
    expect(JSON.stringify(quiet)).not.toContain("Brain");

    const noted = resyncOptions({ source, label, brainNote: true }) as Options;
    expect(noted.modes[0]!.note).toBeNull();
    expect(noted.modes[1]!.note).toBe(
      "What the Brain built from mail-synth will point at records that no longer exist.",
    );
  });

  test("offers only what the gateway says the source offers", () => {
    expect(
      (resyncOptions({ source: { ...source, resyncModes: [] }, label }) as Options).modes,
    ).toEqual([]);
    const one = resyncOptions({
      source: { ...source, resyncModes: [RESYNC_FROM_SCRATCH] },
      label,
    }) as Options;
    expect(one.modes.map((m) => m.id)).toEqual([RESYNC_FROM_SCRATCH]);
    // No choice, so nothing to compare the one mode against.
    expect(one.footnote).toBeNull();
    // A row the gateway named no modes for is offered both.
    const { resyncModes: _resyncModes, ...unlisted } = source;
    expect((resyncOptions({ source: unlisted, label }) as Options).modes).toHaveLength(2);
  });
});

describe("resyncOptions for one device", () => {
  test("a partitioned device: both modes, worded for what that device sent", () => {
    const { modes, footnote } = resyncOptions({
      source: { ...source, multiDeviceMode: "partitioned" },
      label,
      device: phone,
      brainNote: true,
    }) as Options;
    expect(modes.map((m) => m.id)).toEqual([RESYNC_IN_PLACE, RESYNC_FROM_SCRATCH]);
    expect(modes[0]!.body).toContain("Maya-Phone reads mail-synth again and updates what it already sent");
    expect(modes[1]!.body).toContain("Deletes everything Maya-Phone sent for mail-synth");
    expect(modes[1]!.body).toContain("what other devices sent stays");
    expect(modes[1]!.note).toContain("the Brain");
    expect(footnote).toContain("In place never deletes");
  });

  test("a replicated device: in place only, with the way to delete named", () => {
    const { modes, footnote } = resyncOptions({
      source: { ...source, multiDeviceMode: "replicated" },
      label,
      device: phone,
      brainNote: true,
    }) as Options;
    expect(modes.map((m) => m.id)).toEqual([RESYNC_IN_PLACE]);
    expect(footnote).toBe(
      "Nothing is deleted. To clear duplicate or stray records, resync the whole source from scratch.",
    );
    expect(JSON.stringify({ modes, footnote })).not.toContain("Brain");
  });

  test("a device's modes follow the source's mode, not the whole source's list", () => {
    const { modes } = resyncOptions({
      source: { ...source, multiDeviceMode: "partitioned", resyncModes: [] },
      label,
      device: phone,
    }) as Options;
    expect(modes).toHaveLength(2);
  });
});

describe("defaultResyncMode", () => {
  test("in place when offered, else the only mode, else none", () => {
    const { modes } = resyncOptions({ source, label }) as Options;
    expect(defaultResyncMode(modes)).toBe(RESYNC_IN_PLACE);
    expect(defaultResyncMode(modes.slice(1))).toBe(RESYNC_FROM_SCRATCH);
    expect(defaultResyncMode([])).toBeNull();
  });
});
