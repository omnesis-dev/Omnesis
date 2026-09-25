// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { imagesSupported, hyperlinksSupported } from "./capability.js";

const TTY = true;
const PIPE = false;

function env(values: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

describe("imagesSupported", () => {
  test("iTerm2 via TERM_PROGRAM", () => {
    expect(imagesSupported(env({ TERM_PROGRAM: "iTerm.app" }), TTY)).toBe(true);
  });

  test("iTerm2 over SSH via LC_TERMINAL", () => {
    expect(imagesSupported(env({ LC_TERMINAL: "iTerm2" }), TTY)).toBe(true);
  });

  test("non-iTerm2 returns false (Apple Terminal, unknown, etc.)", () => {
    expect(imagesSupported(env({ TERM_PROGRAM: "Apple_Terminal" }), TTY)).toBe(false);
    expect(imagesSupported(env({ TERM_PROGRAM: "WezTerm" }), TTY)).toBe(false);
    expect(imagesSupported(env({ KITTY_WINDOW_ID: "1" }), TTY)).toBe(false);
    expect(imagesSupported(env({}), TTY)).toBe(false);
  });

  test("pipe safety: non-TTY always returns false", () => {
    expect(imagesSupported(env({ TERM_PROGRAM: "iTerm.app" }), PIPE)).toBe(false);
  });

  test("inside tmux returns false", () => {
    expect(imagesSupported(env({ TERM_PROGRAM: "iTerm.app", TMUX: "/tmp/x" }), TTY)).toBe(false);
  });
});

describe("hyperlinksSupported", () => {
  test("iTerm2 yes", () => {
    expect(hyperlinksSupported(env({ TERM_PROGRAM: "iTerm.app" }), TTY)).toBe(true);
  });

  test("non-iTerm2 no (conservative)", () => {
    expect(hyperlinksSupported(env({ TERM_PROGRAM: "Apple_Terminal" }), TTY)).toBe(false);
    expect(hyperlinksSupported(env({}), TTY)).toBe(false);
  });

  test("pipe safety", () => {
    expect(hyperlinksSupported(env({ TERM_PROGRAM: "iTerm.app" }), PIPE)).toBe(false);
  });

  test("inside tmux returns false", () => {
    expect(hyperlinksSupported(env({ TERM_PROGRAM: "iTerm.app", TMUX: "/tmp/x" }), TTY)).toBe(
      false,
    );
  });
});
