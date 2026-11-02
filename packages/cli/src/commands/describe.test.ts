// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { stripVTControlCharacters } from "node:util";
import { describe, expect, test } from "vitest";
import { describeSource, renderDescription } from "./describe.js";

const vault = {
  id: "vault-synth",
  name: "Synthetic vault",
  description: "Notes from a fictional vault",
  provider: { id: "vault" },
  authType: "local" as const,
  experimental: false,
  hasAuthFlow: false,
  hasDiscover: false,
  params: [
    {
      name: "vaultPath",
      label: "Vault path",
      type: "path" as const,
      required: true,
      scope: "member" as const,
      placeholder: "/path/to/vault",
      help: "The folder the notes app opened",
    },
  ],
};

const mail = {
  id: "mail-synth",
  name: "Synthetic mail",
  description: "Fictional mail",
  provider: { id: "mailco" },
  authType: "oauth" as const,
  experimental: false,
  hasAuthFlow: true,
  hasDiscover: true,
  params: [],
  credentials: {
    fileKey: "mailco",
    required: true,
    publicClient: false,
    perAccount: false,
    fields: [
      { name: "client_id", label: "Client ID" },
      { name: "client_secret", label: "Client secret", secret: true },
    ],
    wizard: { intro: "", why: "", estMinutes: 1, steps: [] },
  },
};

describe("sources describe", () => {
  test("lists every key with what the descriptor says of it, and an add to copy", () => {
    const d = describeSource(vault, [{ id: "dev-1", name: "Studio-Mini" }]);
    expect(d.keys).toEqual([
      expect.objectContaining({
        key: "vaultPath",
        kind: "setting",
        required: true,
        scope: "member",
      }),
    ]);
    expect(d.example).toBe(
      "omnesis sources add vault-synth --device Studio-Mini --set vaultPath=/path/to/vault",
    );
    const text = stripVTControlCharacters(renderDescription(d).join("\n"));
    expect(text).toContain("vaultPath  Vault path (path, required, this machine's own)");
    expect(text).toContain("The folder the notes app opened");
    expect(text).toContain(d.example);
  });

  test("application credentials are listed, but left out of the example add", () => {
    const d = describeSource(mail, [
      { id: "dev-1", name: "Studio-Mini" },
      { id: "dev-2", name: "maya-laptop" },
    ]);
    expect(d.keys.map((k) => [k.key, k.kind])).toEqual([
      ["client_id", "provider-credential"],
      ["client_secret", "provider-credential"],
    ]);
    expect(d.example).toBe("omnesis sources add mail-synth --device <name>");
    const text = stripVTControlCharacters(renderDescription(d).join("\n"));
    expect(text).toContain("Application credentials (asked only while the collector has none");
    expect(text).toContain("choose with --account <id>");
    expect(text).toContain("Adding it signs in");
  });
});
