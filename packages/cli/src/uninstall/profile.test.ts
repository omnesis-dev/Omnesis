// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { PROFILE_MARKER, profileCandidates, removeInstallerPathLines } from "./profile.js";

const BIN = "/home/maya/.local/bin";
const BLOCK = `\n${PROFILE_MARKER}\nexport PATH="${BIN}:$PATH"\n`;

describe("removeInstallerPathLines", () => {
  test("a profile that gained the installer's block reads as it did before", () => {
    const before = 'alias ll="ls -l"\nexport EDITOR=vim\n';
    const { text, removed } = removeInstallerPathLines(before + BLOCK, BIN);
    expect(removed).toBe(1);
    expect(text).toBe(before);
  });

  test("a block in the middle keeps everything around it", () => {
    const profile = `export EDITOR=vim\n${BLOCK}\nsource ~/.aliases\n`;
    expect(removeInstallerPathLines(profile, BIN).text).toBe(
      "export EDITOR=vim\n\nsource ~/.aliases\n",
    );
  });

  test("the fish form is removed from a fish config", () => {
    const fish = `set -gx EDITOR vim\n\n${PROFILE_MARKER}\nfish_add_path ${BIN}\n`;
    expect(removeInstallerPathLines(fish, BIN)).toEqual({
      text: "set -gx EDITOR vim\n",
      removed: 1,
    });
  });

  test("a profile that is only the block becomes empty", () => {
    expect(removeInstallerPathLines(BLOCK, BIN)).toEqual({ text: "", removed: 1 });
  });

  test("repeated blocks are all removed", () => {
    const profile = `export A=1\n${BLOCK}${BLOCK}`;
    const { text, removed } = removeInstallerPathLines(profile, BIN);
    expect(removed).toBe(2);
    expect(text).toBe("export A=1\n");
  });

  test("the operator's own PATH line, with no marker, stays", () => {
    const profile = `export PATH="${BIN}:$PATH"\n`;
    expect(removeInstallerPathLines(profile, BIN)).toEqual({ text: profile, removed: 0 });
  });

  test("a marker over a line the installer did not write stays, line and all", () => {
    const edited = `${PROFILE_MARKER}\nexport PATH="/opt/tools/bin:$PATH"\n`;
    expect(removeInstallerPathLines(edited, BIN).removed).toBe(0);
    const otherHome = `${PROFILE_MARKER}\nexport PATH="/home/sarah/.local/bin:$PATH"\n`;
    expect(removeInstallerPathLines(otherHome, BIN).removed).toBe(0);
  });

  test("a marker on the last line, with nothing after it, stays", () => {
    const profile = `export A=1\n${PROFILE_MARKER}`;
    expect(removeInstallerPathLines(profile, BIN)).toEqual({ text: profile, removed: 0 });
  });

  test("CRLF line endings still match", () => {
    const profile = `export A=1\r\n\r\n${PROFILE_MARKER}\r\nexport PATH="${BIN}:$PATH"\r\n`;
    const { removed } = removeInstallerPathLines(profile, BIN);
    expect(removed).toBe(1);
  });
});

test("every profile the installer may have picked is a candidate, whatever SHELL is now", () => {
  expect(profileCandidates("/home/maya")).toEqual([
    "/home/maya/.zshrc",
    "/home/maya/.bashrc",
    "/home/maya/.bash_profile",
    "/home/maya/.profile",
    "/home/maya/.config/fish/config.fish",
  ]);
});
