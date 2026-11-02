// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { PassThrough, Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import * as clack from "@clack/prompts";
import { describe, expect, test, vi } from "vitest";
import { EXIT_CANCELLED } from "../utils.js";
import { pickMany } from "./add.js";

/**
 * The real prompt on in-memory streams: what it drew, and what it resolved
 * with after `keys` were typed.
 */
async function drive(
  opts: Parameters<typeof pickMany>[1],
  keys: string[],
): Promise<{ screen: string; value: string[] }> {
  const input = new PassThrough();
  let drawn = "";
  const output = new Writable({
    write(chunk, _encoding, done) {
      drawn += String(chunk);
      done();
    },
  });
  Object.assign(output, { columns: 120, rows: 40 });
  const prompts: Parameters<typeof pickMany>[0] = {
    isCancel: clack.isCancel,
    cancel: clack.cancel,
    autocompleteMultiselect: (options) =>
      clack.autocompleteMultiselect({ ...options, input, output }),
  };
  const picked = pickMany(prompts, opts);
  for (const key of keys) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    input.write(key);
  }
  const value = await picked;
  return { screen: stripVTControlCharacters(drawn), value };
}

/** The hint line a prompt draws under its options. */
const hint = (screen: string): string =>
  screen
    .split("\n")
    .filter((line) => line.includes("Enter: confirm"))
    .at(-1)!
    .replace(/^[│└\s]+/u, "")
    .trim();

describe("the pickers of one add flow", () => {
  const sources = [
    { value: "notes-synth", label: "Synthetic notes" },
    { value: "mail-synth", label: "Synthetic mail" },
  ];
  const accounts = [
    { value: "maya@example.com", label: "maya@example.com" },
    { value: "jamie@example.com", label: "jamie@example.com" },
  ];

  test("hint the same keys, and the key the hint names selects in each", async () => {
    const sourcePick = await drive({ message: "Which sources?", options: sources }, ["\t", "\r"]);
    const accountPick = await drive(
      { message: "Found 2 accounts. Which would you like to add?", options: accounts },
      ["\t", "\r"],
    );
    expect(hint(sourcePick.screen)).toBe(hint(accountPick.screen));
    expect(hint(accountPick.screen)).toContain("Tab: select");
    expect(sourcePick.value).toEqual(["notes-synth"]);
    expect(accountPick.value).toEqual(["maya@example.com"]);
  });

  test("once the arrows move the cursor, the hint adds Space, and Space selects", async () => {
    const pick = await drive({ message: "Found 2 accounts.", options: accounts }, [
      "\u001b[B",
      " ",
      "\r",
    ]);
    expect(pick.screen).toContain("Space/Tab: select");
    expect(pick.value).toEqual(["jamie@example.com"]);
  });

  test("an account picker keeps the accounts it starts with selected", async () => {
    const pick = await drive(
      {
        message: "Found 2 accounts.",
        options: accounts,
        initialValues: accounts.map((account) => account.value),
      },
      ["\r"],
    );
    expect(pick.value).toEqual(["maya@example.com", "jamie@example.com"]);
  });

  test("a cancelled pick ends the flow as cancelled", async () => {
    const cancel = vi.fn();
    await expect(
      pickMany(
        {
          autocompleteMultiselect: vi.fn(() => Promise.resolve(Symbol("cancel"))),
          isCancel: (value: unknown): value is symbol => typeof value === "symbol",
          cancel,
        } as unknown as Parameters<typeof pickMany>[0],
        { message: "Which sources?", options: sources },
      ),
    ).rejects.toMatchObject({ exitCode: EXIT_CANCELLED });
    expect(cancel).toHaveBeenCalledWith("Cancelled.");
  });
});
