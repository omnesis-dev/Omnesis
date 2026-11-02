// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { stripVTControlCharacters } from "node:util";
import { describe, expect, test } from "vitest";
import { EXIT_USER_ERROR, type SerializedDescriptor } from "../utils.js";
import {
  collectFlagValues,
  missingSettingsRefusal,
  parseConfigFlag,
  parseSetFlags,
  readSuppliedSettings,
  setFlagFor,
  setupKeys,
  sortSuppliedSettings,
} from "./add-settings.js";

/** A fictional local source with a path, a choice and an optional text setting. */
const notes = {
  id: "notes-synth",
  hasAuthFlow: false,
  params: [
    {
      name: "vaultPath",
      label: "Vault path",
      type: "path",
      required: true,
      scope: "member",
      placeholder: "/path/to/vault",
    },
    {
      name: "layout",
      label: "Layout",
      type: "select",
      options: [
        { value: "flat", label: "Flat" },
        { value: "nested", label: "Nested" },
      ],
    },
    {
      name: "tag",
      label: "Tag",
      type: "string",
      pattern: "^[a-z]+$",
      patternHint: "Lowercase letters only",
    },
  ],
} as unknown as SerializedDescriptor;

/** A fictional sign-in source whose credential is the account. */
const photos = {
  id: "photos-synth",
  hasAuthFlow: true,
  params: [],
  credentials: {
    fileKey: "photos-synth",
    required: true,
    publicClient: false,
    perAccount: true,
    fields: [
      { name: "base_url", label: "Server URL", pattern: "^https?://" },
      { name: "api_key", label: "API key", secret: true },
    ],
    wizard: { intro: "", why: "", estMinutes: 1, steps: [] },
  },
} as unknown as SerializedDescriptor;

const plain = (s: string) => stripVTControlCharacters(s);

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toMatchObject({ exitCode: EXIT_USER_ERROR });
    return plain((err as Error).message);
  }
  throw new Error("expected a refusal");
}

describe("reading the flags", () => {
  test("every --set is kept, in both spellings, though the parser keeps only the last", () => {
    const raw = ["notes-synth", "--set", "vaultPath=/notes", "--device", "studio", "--set=tag=x=y"];
    expect(collectFlagValues(raw, "set")).toEqual(["vaultPath=/notes", "tag=x=y"]);
    expect(parseSetFlags(collectFlagValues(raw, "set"))).toEqual({
      vaultPath: "/notes",
      tag: "x=y",
    });
  });

  test("a --set without a key, or one key with two values, is refused", () => {
    expect(refusal(() => parseSetFlags(["/notes"]))).toContain("--set takes key=value");
    expect(refusal(() => parseSetFlags(["=x"]))).toContain("--set takes key=value");
    expect(refusal(() => parseSetFlags(["tag=a", "tag=b"]))).toContain("given twice");
    expect(parseSetFlags(["tag=a", "tag=a"])).toEqual({ tag: "a" });
  });

  test("--config reads inline JSON, a file and standard input; --set wins over it", () => {
    const io = {
      readFile: (path: string) => {
        expect(path).toBe("/tmp/fictional/settings.json");
        return '{"api_key":"k-1","port":443,"verbose":true,"skip":null}';
      },
      readStdin: () => '{"vaultPath":"/from-stdin"}',
    };
    expect(parseConfigFlag('{"vaultPath":"/inline"}', io)).toEqual({ vaultPath: "/inline" });
    expect(parseConfigFlag("@/tmp/fictional/settings.json", io)).toEqual({
      api_key: "k-1",
      port: "443",
      verbose: "true",
    });
    expect(parseConfigFlag("-", io)).toEqual({ vaultPath: "/from-stdin" });
    expect(
      readSuppliedSettings(["--config", "-", "--set", "vaultPath=/over", "--set", "tag=x"], io),
    ).toEqual({ vaultPath: "/over", tag: "x" });
  });

  test("--config that is not a flat JSON object is refused, saying why", () => {
    const io = { readFile: () => "", readStdin: () => "" };
    expect(refusal(() => parseConfigFlag("{nope", io))).toContain("is not JSON");
    expect(refusal(() => parseConfigFlag("[1]", io))).toContain("must be a JSON object");
    expect(refusal(() => parseConfigFlag('{"exclude":["a"]}', io))).toContain(
      "must be text, not a list",
    );
    const unreadable = {
      readFile: () => {
        throw new Error("ENOENT");
      },
      readStdin: () => "",
    };
    const message = refusal(() => parseConfigFlag("@/nowhere.json", unreadable));
    expect(message).toContain("could not read /nowhere.json");
    expect(message).toContain("--config - < settings.json");
    expect(refusal(() => readSuppliedSettings(["--config", "{}", "--config", "{}"], io))).toContain(
      "more than once",
    );
  });
});

describe("checking what was supplied against the descriptor", () => {
  test("settings are sorted from credential fields, and each kind comes from the descriptor", () => {
    expect(setupKeys(notes).map((k) => [k.key, k.kind, k.required])).toEqual([
      ["vaultPath", "setting", true],
      ["layout", "setting", false],
      ["tag", "setting", false],
    ]);
    expect(setupKeys(photos).map((k) => [k.key, k.kind, k.secret])).toEqual([
      ["base_url", "account-credential", false],
      ["api_key", "account-credential", true],
    ]);
    expect(sortSuppliedSettings(notes, { vaultPath: "~/notes", layout: "flat", tag: "" })).toEqual({
      params: { vaultPath: "~/notes", layout: "flat", tag: "" },
      credentials: {},
    });
    expect(
      sortSuppliedSettings(photos, { base_url: " https://photos.example.com ", api_key: "k-1" }),
    ).toEqual({
      params: {},
      credentials: { base_url: "https://photos.example.com", api_key: "k-1" },
    });
  });

  test("an unknown key is refused with the keys the source takes and where to read them", () => {
    const message = refusal(() => sortSuppliedSettings(notes, { vault: "/notes" }));
    expect(message).toContain('notes-synth has no setting named "vault"');
    expect(message).toContain("It takes: vaultPath, layout, tag.");
    expect(message).toContain("omnesis sources describe notes-synth");
  });

  test("a choice outside the options, or a value the pattern refuses, never reaches the collector", () => {
    expect(refusal(() => sortSuppliedSettings(notes, { layout: "tree" }))).toContain(
      "layout must be one of: flat, nested",
    );
    expect(refusal(() => sortSuppliedSettings(notes, { tag: "Mixed" }))).toContain(
      "Lowercase letters only",
    );
  });

  test("an incomplete or malformed credential is refused by the spec's own check", () => {
    expect(
      refusal(() => sortSuppliedSettings(photos, { base_url: "https://x.example" })),
    ).toContain("API key (api_key) is required");
    expect(
      refusal(() => sortSuppliedSettings(photos, { base_url: "ftp://x.example", api_key: "k" })),
    ).toContain("Server URL has invalid format");
  });

  test("credential fields are not keys of a source whose add does not sign in", () => {
    const noSignIn = { ...photos, hasAuthFlow: false } as SerializedDescriptor;
    expect(setupKeys(noSignIn)).toEqual([]);
    expect(refusal(() => sortSuppliedSettings(noSignIn, { api_key: "k" }))).toContain(
      'has no setting named "api_key"',
    );
  });
});

describe("the refusal for what nobody can be asked", () => {
  test("names each missing key with the flag that supplies it", () => {
    const keys = setupKeys(notes);
    expect(setFlagFor(keys[0]!)).toBe("--set vaultPath=/path/to/vault");
    expect(setFlagFor(keys[1]!)).toBe("--set layout=flat");
    const message = plain(missingSettingsRefusal("notes-synth", [keys[0]!]));
    expect(message).toContain("notes-synth needs a value that this run has no terminal to ask for");
    expect(message).toContain("--set vaultPath=/path/to/vault");
    expect(message).toContain("omnesis sources describe notes-synth");
    expect(message).not.toContain("--config @file");
  });

  test("a missing secret is pointed at --config, which keeps it off the command line", () => {
    const message = plain(missingSettingsRefusal("photos-synth", setupKeys(photos)));
    expect(message).toContain("--set base_url=");
    expect(message).toContain("--set api_key=");
    expect(message).toContain("--config @file");
  });
});
