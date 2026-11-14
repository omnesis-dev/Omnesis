// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectWindowsPrivatePathSync } from "@omnesis/core";
import { canDenyFixtureReads, setFixtureMode } from "@omnesis/source-sdk/testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  MAX_OPERATOR_INSTRUCTIONS_BYTES,
  OPERATOR_INSTRUCTIONS_FILENAME,
  OperatorInstructionsConflictError,
  OperatorInstructionsNotAFileError,
  OperatorInstructionsStore,
  OperatorInstructionsTooLargeError,
  TRUNCATION_MARKER,
  truncateToBytes,
} from "./store.js";

const writing = vi.hoisted(() => ({ beforeWrite: undefined as (() => Promise<void>) | undefined }));
vi.mock("@omnesis/core", async (original) => {
  const core = await original<typeof import("@omnesis/core")>();
  return {
    ...core,
    atomicWriteFile: async (...args: Parameters<typeof core.atomicWriteFile>) => {
      await writing.beforeWrite?.();
      await core.atomicWriteFile(...args);
    },
  };
});

function holdNextWrite() {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  writing.beforeWrite = async () => {
    writing.beforeWrite = undefined;
    entered();
    await held;
  };
  return { started, release };
}

describe("OperatorInstructionsStore", () => {
  let dir: string;
  let file: string;
  let store: OperatorInstructionsStore;

  beforeEach(() => {
    writing.beforeWrite = undefined;
    dir = mkdtempSync(join(tmpdir(), "omnesis-instructions-"));
    file = join(dir, OPERATOR_INSTRUCTIONS_FILENAME);
    store = new OperatorInstructionsStore(dir);
  });

  afterEach(() => {
    writing.beforeWrite = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  test("a missing file is the normal state, not an error", () => {
    expect(store.read()).toEqual({
      exists: false,
      content: "",
      bytes: 0,
      updatedAt: null,
      truncated: false,
      problem: null,
    });
    expect(store.promptText()).toBe("");
    expect(store.path).toBe(file);
  });

  test("writes atomically, privately, and reads back what was written", async () => {
    const written = await store.write("# House rules\n\nAlways answer in metric units.\n");
    expect(written.exists).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("metric units");
    if (process.platform === "win32")
      expect(inspectWindowsPrivatePathSync(file, "file").private).toBe(true);
    else expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(store.promptText()).toBe("# House rules\n\nAlways answer in metric units.");
  });

  test("a file of only whitespace injects nothing", async () => {
    await store.write("   \n\n\t\n");
    expect(store.read().exists).toBe(true);
    expect(store.promptText()).toBe("");
  });

  test("picks up an edit made outside the store", async () => {
    await store.write("first");
    expect(store.promptText()).toBe("first");

    // A hand edit: same store instance, new bytes on disk. The mtime cache has
    // to notice, or an operator's vim edit would never reach the agent.
    writeFileSync(file, "second edit, quite a bit longer than the first", "utf8");
    expect(store.promptText()).toBe("second edit, quite a bit longer than the first");
  });

  test("notices an edit that keeps the byte count but changes the mtime", async () => {
    await store.write("aaaa");
    expect(store.promptText()).toBe("aaaa");
    writeFileSync(file, "bbbb", "utf8");
    const later = new Date(Date.now() + 5_000);
    utimesSync(file, later, later);
    expect(store.promptText()).toBe("bbbb");
  });

  test("refuses a write past the byte cap", async () => {
    const tooBig = "x".repeat(MAX_OPERATOR_INSTRUCTIONS_BYTES + 1);
    await expect(store.write(tooBig)).rejects.toThrow(OperatorInstructionsTooLargeError);
    expect(store.read().exists).toBe(false);
  });

  test("counts UTF-8 bytes, not string length, against the cap", async () => {
    // Each of these is three bytes, so a string of a third the cap's length in
    // characters is exactly at the cap — one more character is over it.
    const chars = Math.floor(MAX_OPERATOR_INSTRUCTIONS_BYTES / 3);
    await expect(store.write("あ".repeat(chars))).resolves.toMatchObject({ bytes: chars * 3 });
    await expect(store.write("あ".repeat(chars + 1))).rejects.toThrow(
      OperatorInstructionsTooLargeError,
    );
  });

  test("truncates an oversize file written outside the portal, and says so", () => {
    // The portal can refuse an oversize save; a terminal editor cannot be
    // refused, so the file is cut with a marker rather than dropped whole.
    writeFileSync(file, "y".repeat(MAX_OPERATOR_INSTRUCTIONS_BYTES + 500), "utf8");
    const current = store.read();
    expect(current.truncated).toBe(true);
    expect(current.problem).toBeNull();
    expect(current.bytes).toBe(MAX_OPERATOR_INSTRUCTIONS_BYTES + 500);
    expect(current.content).toHaveLength(MAX_OPERATOR_INSTRUCTIONS_BYTES + 500);

    const prompt = store.promptText();
    expect(prompt.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(
      Buffer.byteLength(prompt.slice(0, -TRUNCATION_MARKER.length), "utf8"),
    ).toBeLessThanOrEqual(MAX_OPERATOR_INSTRUCTIONS_BYTES);
  });

  test("ignores a file far past the cap rather than loading it", () => {
    writeFileSync(file, "z".repeat(MAX_OPERATOR_INSTRUCTIONS_BYTES * 16 + 1), "utf8");
    const current = store.read();
    expect(current.exists).toBe(true);
    expect(current.problem).toBe("too-large");
    expect(current.content).toBe("");
    expect(store.promptText()).toBe("");
  });

  test.skipIf(!canDenyFixtureReads)(
    "reports an unreadable file as a problem, not as absent",
    () => {
      // Reporting "no file" for a file that plainly exists would leave the
      // operator with nothing to act on but a log line — and would let the
      // portal offer to create the file that is already there.
      writeFileSync(file, "secret instructions", { encoding: "utf8", mode: 0o600 });
      setFixtureMode(file, 0o000);
      try {
        const current = store.read();
        expect(current.exists).toBe(true);
        expect(current.problem).toBe("unreadable");
        expect(current.content).toBe("");
        expect(store.promptText()).toBe("");
      } finally {
        setFixtureMode(file, 0o600);
      }
    },
  );

  test("refuses to write over something that is not a regular file", async () => {
    rmSync(file, { force: true });
    mkdirSync(file);
    await expect(store.write("hello")).rejects.toThrow(OperatorInstructionsNotAFileError);
    await expect(store.remove()).rejects.toThrow(OperatorInstructionsNotAFileError);
    rmSync(file, { recursive: true, force: true });
  });

  test("a create claiming there was no file loses to a file written meanwhile", async () => {
    // The race the page's own invitation makes likely: the tab opens with no
    // file, the operator writes one in their editor, then saves from the tab.
    expect(store.read().exists).toBe(false);
    writeFileSync(file, "written in a terminal editor", "utf8");
    await expect(store.write("from the empty tab", { expectedUpdatedAt: null })).rejects.toThrow(
      OperatorInstructionsConflictError,
    );
    expect(readFileSync(file, "utf8")).toBe("written in a terminal editor");
  });

  test("a create claiming there was no file goes through when there was none", async () => {
    expect((await store.write("first draft", { expectedUpdatedAt: null })).content).toBe(
      "first draft",
    );
  });

  test("a write naming a stale updatedAt is refused instead of clobbering", async () => {
    const first = await store.write("original");
    const staleToken = first.updatedAt!;

    const later = new Date(Date.now() + 5_000);
    writeFileSync(file, "written in a terminal editor", "utf8");
    utimesSync(file, later, later);

    await expect(
      store.write("from a portal tab", { expectedUpdatedAt: staleToken }),
    ).rejects.toThrow(OperatorInstructionsConflictError);
    expect(readFileSync(file, "utf8")).toBe("written in a terminal editor");
  });

  test("a write naming the current updatedAt goes through", async () => {
    const first = await store.write("original");
    const next = await store.write("replacement", { expectedUpdatedAt: first.updatedAt! });
    expect(next.content).toBe("replacement");
  });

  test("delete removes the file and reports whether there was one", async () => {
    expect(await store.remove()).toBe(false);
    await store.write("something");
    expect(await store.remove()).toBe(true);
    expect(store.read().exists).toBe(false);
    expect(store.promptText()).toBe("");
  });

  test("a delete naming a stale updatedAt is refused", async () => {
    const first = await store.write("original");
    const later = new Date(Date.now() + 5_000);
    writeFileSync(file, "edited elsewhere", "utf8");
    utimesSync(file, later, later);
    await expect(store.remove({ expectedUpdatedAt: first.updatedAt! })).rejects.toThrow(
      OperatorInstructionsConflictError,
    );
    expect(store.read().exists).toBe(true);
  });

  test("a deferred private writer leaves the event loop and synchronous prompt reads available", async () => {
    await store.write("before publication");
    const held = holdNextWrite();
    let settled = false;
    const pending = store.write("after publication");
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await Promise.race([
        held.started,
        pending.then(() => {
          throw new Error("Missing writer rendezvous");
        }),
      ]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(store.promptText()).toBe("before publication");
      held.release();
      expect((await pending).content).toBe("after publication");
    } finally {
      held.release();
      await Promise.allSettled([pending]);
    }
  });

  test("parallel saves check their shared version claim inside the mutation queue", async () => {
    await store.write("original");
    const older = new Date(Date.now() - 5000);
    utimesSync(file, older, older);
    const expectedUpdatedAt = store.read().updatedAt;
    const held = holdNextWrite();
    const first = store.write("first saved tab", { expectedUpdatedAt });
    const second = store.write("stale second tab", { expectedUpdatedAt });
    const refused = expect(second).rejects.toBeInstanceOf(OperatorInstructionsConflictError);
    try {
      await Promise.race([
        held.started,
        first.then(() => {
          throw new Error("Missing writer rendezvous");
        }),
      ]);
      held.release();
      expect((await first).content).toBe("first saved tab");
      await refused;
      expect(store.read().content).toBe("first saved tab");
    } finally {
      held.release();
      await Promise.allSettled([first, second, refused]);
    }
  });

  test("a delete joins the pending write before removing its newly published file", async () => {
    await store.write("original");
    const held = holdNextWrite();
    const pending = store.write("queued replacement");
    const removal = store.remove();
    try {
      await Promise.race([
        held.started,
        pending.then(() => {
          throw new Error("Missing writer rendezvous");
        }),
      ]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(store.read().content).toBe("original");
      held.release();
      expect((await pending).content).toBe("queued replacement");
      expect(await removal).toBe(true);
      expect(store.read().exists).toBe(false);
    } finally {
      held.release();
      await Promise.allSettled([pending, removal]);
    }
  });

  test("a queued delete checks its version after the pending write commits", async () => {
    await store.write("original");
    const older = new Date(Date.now() - 5000);
    utimesSync(file, older, older);
    const expectedUpdatedAt = store.read().updatedAt;
    const held = holdNextWrite();
    const pending = store.write("replacement");
    const removal = store.remove({ expectedUpdatedAt });
    const refused = expect(removal).rejects.toBeInstanceOf(OperatorInstructionsConflictError);
    try {
      await Promise.race([
        held.started,
        pending.then(() => {
          throw new Error("Missing writer rendezvous");
        }),
      ]);
      held.release();
      await pending;
      await refused;
      expect(store.read().content).toBe("replacement");
    } finally {
      held.release();
      await Promise.allSettled([pending, removal, refused]);
    }
  });

  test("a rejected private write preserves the file and does not poison queued mutations", async () => {
    await store.write("previous complete instructions");
    writing.beforeWrite = () => {
      writing.beforeWrite = undefined;
      expect(readFileSync(file, "utf8")).toBe("previous complete instructions");
      return Promise.reject(new Error("Invented private writer failure"));
    };
    const failed = store.write("failed replacement");
    const recovered = store.write("recovered replacement");
    const joined = Promise.allSettled([failed, recovered]);
    try {
      await expect(failed).rejects.toThrow("Invented private writer failure");
      expect((await recovered).content).toBe("recovered replacement");
      expect(store.promptText()).toBe("recovered replacement");
    } finally {
      await joined;
    }
  });

  test("creates the config directory on first write", async () => {
    const fresh = new OperatorInstructionsStore(join(dir, "nested", "deeper"));
    await fresh.write("hello");
    expect(fresh.read().content).toBe("hello");
  });
});

describe("truncateToBytes", () => {
  test("returns the input untouched when it already fits", () => {
    expect(truncateToBytes("short", 100)).toBe("short");
  });

  test("never splits a multi-byte character", () => {
    // "あ" is three bytes, so every cap from 3 to 5 must yield exactly one
    // character — a naive byte slice would leave a half sequence at 4 and 5.
    for (const cap of [3, 4, 5]) {
      const cut = truncateToBytes("ああ", cap);
      expect(cut).toBe("あ");
      expect(Buffer.byteLength(cut, "utf8")).toBeLessThanOrEqual(cap);
    }
  });

  test("cuts to nothing rather than to a partial character", () => {
    expect(truncateToBytes("あ", 2)).toBe("");
  });

  test("keeps an existing replacement character in the kept prefix", () => {
    // A file may legitimately contain U+FFFD; truncation must not treat it as
    // evidence that it split something.
    expect(truncateToBytes("�ab", 3)).toBe("�");
  });
});
