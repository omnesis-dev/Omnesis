// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export interface SpinnerHandle {
  message(text: string): void;
}

/**
 * Run an async block with a clack timer spinner that paints to stderr.
 *
 * Failure semantics: callbacks must `throw` (preferably `new CliError(...)`
 * from `./errors.js`) and **never** call `process.exit` directly — exiting
 * inside the spinner skips its own `try/catch`, which leaves the terminal
 * with an inverted-color cursor stuck on the spinner glyph until the user
 * types `reset`. Throwing lets the catch arm here run `spin.error(...)`,
 * the runner above runs `process.exit(code)`, and terminal state stays sane.
 */
export async function withSpinner<T>(
  label: string,
  fn: (spin: SpinnerHandle) => Promise<T>,
  opts: { disabled?: boolean } = {},
): Promise<T> {
  if (opts.disabled || !process.stderr.isTTY) {
    return fn({ message: () => {} });
  }

  const prompts = await import("@clack/prompts");
  const spin = prompts.spinner({ indicator: "timer", output: process.stderr });

  let started = false;
  let currentLabel = label;
  const startTimer = setTimeout(() => {
    started = true;
    spin.start(currentLabel);
  }, 150);

  const handle: SpinnerHandle = {
    message(text) {
      currentLabel = text;
      if (started) spin.message(text);
    },
  };

  try {
    const result = await fn(handle);
    clearTimeout(startTimer);
    if (started) spin.stop(currentLabel);
    return result;
  } catch (err) {
    clearTimeout(startTimer);
    if (started) spin.error(currentLabel);
    throw err;
  }
}
