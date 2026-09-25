// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Settings → OMNESIS.md. The behaviour worth pinning is what the page does
 * around the file rather than the editor itself: it must not create the file
 * by being opened, it must refuse a save the gateway would refuse, and when
 * someone edits the file in a terminal while this tab is open it must keep the
 * operator's unsaved words rather than silently choosing a winner.
 */

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({
  getOperatorInstructions: vi.fn(),
  saveOperatorInstructions: vi.fn(),
  deleteOperatorInstructions: vi.fn(),
}));

vi.mock("../api.js", () => api);
vi.mock("../components/copy-button.js", async () => {
  const { h: create } = await import("preact");
  return { CopyIconButton: () => create("button", { class: "stub-copy" }, "copy") };
});
vi.mock("../lib/json-editor.js", async () => {
  const { h: create } = await import("preact");
  return {
    TextEditor: ({ value, onChange, ariaLabel }: any) =>
      create("textarea", {
        value,
        "aria-label": ariaLabel,
        onInput: (event: Event) => onChange((event.target as HTMLTextAreaElement).value),
      }),
  };
});

// @ts-expect-error — portal modules are intentionally plain JavaScript.
import { OmnesisMdView } from "./omnesis-md.js";

const PATH = "/home/example/.config/omnesis/OMNESIS.md";
const MAX = 16_384;

function absent() {
  return {
    path: PATH,
    exists: false,
    content: "",
    bytes: 0,
    updatedAt: null,
    truncated: false,
    problem: null,
    maxBytes: MAX,
  };
}

/** The error shape `api.js` actually throws, so mocks match production. */
function apiError(status: number, serverMessage: string) {
  return Object.assign(new Error(`GET /admin/instructions → ${status}`), {
    status,
    serverMessage,
  });
}

function present(content: string, updatedAt = 1000.5) {
  return {
    path: PATH,
    exists: true,
    content,
    bytes: new TextEncoder().encode(content).length,
    updatedAt,
    truncated: false,
    problem: null,
    maxBytes: MAX,
  };
}

let host: HTMLElement;
let originalDocument: typeof globalThis.document | undefined;
let originalWindow: typeof globalThis.window | undefined;

function editor(): HTMLTextAreaElement | null {
  return host.querySelector("textarea");
}

/**
 * Buttons are addressed by their visible label, but scoped to the page or the
 * modal: "Delete file" is both the toolbar's trigger and the modal's confirm,
 * so an unscoped lookup would keep re-clicking the trigger and never confirm.
 */
function buttonLabelled(text: string, within: "page" | "modal" = "page") {
  const root =
    within === "modal" ? host.querySelector(".confirm-modal") : host;
  const scope = within === "page" ? ".confirm-modal" : null;
  return [...(root?.querySelectorAll("button") ?? [])].find(
    (b) =>
      (b.textContent ?? "").includes(text) && (!scope || !b.closest(scope)),
  ) as HTMLButtonElement | undefined;
}

/** Let a handler's own awaited work (a re-read after a save) settle. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount() {
  await act(async () => {
    render(h(OmnesisMdView, {}), host);
  });
}

async function type(value: string) {
  const area = editor()!;
  area.value = value;
  await act(async () => {
    area.dispatchEvent(new (globalThis.window as any).Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  originalDocument = globalThis.document;
  originalWindow = globalThis.window;
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  Object.assign(globalThis, { document: parsed.document, window: parsed.window });
  host = parsed.document.querySelector("#root") as unknown as HTMLElement;
  api.getOperatorInstructions.mockResolvedValue(absent());
});

afterEach(() => {
  render(null, host);
  if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
  else globalThis.document = originalDocument;
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else globalThis.window = originalWindow;
});

describe("when there is no OMNESIS.md", () => {
  test("invites one without writing anything", async () => {
    await mount();
    expect(host.textContent).toContain("no OMNESIS.md yet");
    expect(editor()).toBeNull();
    // Opening the tab must never scaffold the file — an operator who has not
    // opted in should still have no file after looking at this page.
    expect(api.saveOperatorInstructions).not.toHaveBeenCalled();
  });

  test("seeds a starter into the editor, still without saving", async () => {
    await mount();
    await act(async () => buttonLabelled("Write OMNESIS.md")!.click());
    expect(editor()?.value).toContain("# OMNESIS.md");
    expect(api.saveOperatorInstructions).not.toHaveBeenCalled();
  });

  test("shows the path so it can be opened in a terminal instead", async () => {
    await mount();
    expect(host.textContent).toContain(PATH);
  });
});

describe("editing an existing file", () => {
  beforeEach(() => {
    api.getOperatorInstructions.mockResolvedValue(present("Be terse."));
  });

  test("opens on the file's contents with Save inert until something changes", async () => {
    await mount();
    expect(editor()?.value).toBe("Be terse.");
    expect(buttonLabelled("Save")?.disabled).toBe(true);
    await type("Be terse. Answer in metric units.");
    expect(buttonLabelled("Save")?.disabled).toBe(false);
  });

  test("saves against the version it loaded", async () => {
    api.saveOperatorInstructions.mockResolvedValue(present("Be terse. And kind.", 2000.5));
    await mount();
    await type("Be terse. And kind.");
    await act(async () => buttonLabelled("Save")!.click());
    await settle();
    expect(api.saveOperatorInstructions).toHaveBeenCalledWith("Be terse. And kind.", 1000.5);
    expect(host.textContent).toContain("The next agent run reads it");
  });

  test("refuses to send a draft past the byte cap", async () => {
    await mount();
    await type("x".repeat(MAX + 1));
    expect(buttonLabelled("Save")?.disabled).toBe(true);
    expect(host.querySelector(".omnesis-md-bytes.over")).not.toBeNull();
  });

  test("counts bytes, not characters, against the cap", async () => {
    await mount();
    // A third of the cap in three-byte characters is exactly at it; the same
    // count of ASCII would be nowhere near, so a character count would pass
    // this draft through to a gateway that rejects it.
    await type("あ".repeat(Math.floor(MAX / 3) + 1));
    expect(buttonLabelled("Save")?.disabled).toBe(true);
  });

  test("declining a new file returns to the empty state", async () => {
    api.getOperatorInstructions.mockResolvedValue(absent());
    await mount();
    await act(async () => buttonLabelled("Write OMNESIS.md")!.click());
    await act(async () => buttonLabelled("Discard changes")!.click());
    expect(editor()).toBeNull();
    expect(host.textContent).toContain("no OMNESIS.md yet");
  });

  test("will not create an empty file and call it instructions", async () => {
    api.getOperatorInstructions.mockResolvedValue(absent());
    await mount();
    await act(async () => buttonLabelled("Write OMNESIS.md")!.click());
    await type("   \n  ");
    expect(buttonLabelled("Save")?.disabled).toBe(true);
  });

  test("claims there was no file when creating one", async () => {
    // `null` is the claim "I expect no file" — without it this tab silently
    // overwrites whatever a terminal editor wrote while it sat open.
    api.getOperatorInstructions.mockResolvedValue(absent());
    api.saveOperatorInstructions.mockResolvedValue(present("hello"));
    await mount();
    await act(async () => buttonLabelled("Write OMNESIS.md")!.click());
    await type("hello");
    await act(async () => buttonLabelled("Save")!.click());
    await settle();
    expect(api.saveOperatorInstructions).toHaveBeenCalledWith("hello", null);
  });

  test("discards back to what is on disk", async () => {
    await mount();
    await type("something else");
    await act(async () => buttonLabelled("Discard changes")!.click());
    expect(editor()?.value).toBe("Be terse.");
  });
});

describe("when the file changed underneath the tab", () => {
  test("keeps the operator's unsaved text and explains the collision", async () => {
    api.getOperatorInstructions.mockResolvedValueOnce(present("original"));
    api.saveOperatorInstructions.mockRejectedValue({ status: 409 });
    api.getOperatorInstructions.mockResolvedValueOnce(present("written in a terminal", 3000.5));

    await mount();
    await type("my unsaved draft");
    await act(async () => buttonLabelled("Save")!.click());
    await settle();

    expect(host.textContent).toContain("changed on disk");
    // The draft is the one thing that exists nowhere else, so it survives.
    expect(editor()?.value).toBe("my unsaved draft");
  });
});

describe("a file past the limits", () => {
  test("says how much of an over-cap file the agent actually reads", async () => {
    api.getOperatorInstructions.mockResolvedValue({
      ...present("y".repeat(50)),
      bytes: MAX + 500,
      truncated: true,
    });
    await mount();
    expect(host.textContent).toContain("Only the first");
    expect(editor()).not.toBeNull();
  });

  test("will not open an editor over a file it could not load", async () => {
    // The gateway returns no content for a file far past the cap. Editing here
    // would replace the operator's real file with an empty document.
    api.getOperatorInstructions.mockResolvedValue({
      ...absent(),
      exists: true,
      bytes: MAX * 20,
      truncated: true,
      problem: "too-large",
    });
    await mount();
    expect(host.textContent).toContain("far past");
    expect(editor()).toBeNull();
  });

  test("offers to delete the file it will not open", async () => {
    // The state where removing it is most likely what the operator wants.
    api.getOperatorInstructions.mockResolvedValue({
      ...absent(),
      exists: true,
      bytes: MAX * 20,
      truncated: true,
      problem: "too-large",
    });
    await mount();
    expect(buttonLabelled("Delete file")).toBeDefined();
  });

  test("says a file is unreadable rather than describing it as too big", async () => {
    api.getOperatorInstructions.mockResolvedValue({
      ...absent(),
      exists: true,
      bytes: 40,
      problem: "unreadable",
    });
    await mount();
    expect(host.textContent).toContain("cannot be read");
    expect(editor()).toBeNull();
  });
});

describe("when the gateway refuses", () => {
  test("shows the gateway's own sentence, not the request line", async () => {
    // `api.js` puts the envelope's message on `serverMessage`; reading any
    // other field leaves the operator staring at `PUT /admin/instructions → 400`.
    api.getOperatorInstructions.mockResolvedValue(present("Be terse."));
    api.saveOperatorInstructions.mockRejectedValue(
      apiError(400, "OMNESIS.md may be at most 16384 bytes; this is 20000."),
    );
    await mount();
    await type("Be terse. And kind.");
    await act(async () => buttonLabelled("Save")!.click());
    await settle();
    expect(host.textContent).toContain("may be at most 16384 bytes");
    expect(host.textContent).not.toContain("PUT /admin/instructions");
  });

  test("a failed first read still offers a way forward", async () => {
    api.getOperatorInstructions.mockRejectedValue(apiError(503, "The gateway has no config dir."));
    await mount();
    expect(host.textContent).toContain("no config dir");
    const retry = buttonLabelled("Try again");
    expect(retry).toBeDefined();

    api.getOperatorInstructions.mockResolvedValue(present("recovered"));
    await act(async () => retry!.click());
    await settle();
    expect(editor()?.value).toBe("recovered");
  });

  test("a delete whose reload fails still reports the delete and stays usable", async () => {
    // The delete succeeded; only the re-read did not. Reporting nothing and
    // leaving an editor over a file that is gone would strand the operator.
    api.getOperatorInstructions.mockResolvedValue(present("Be terse."));
    api.deleteOperatorInstructions.mockResolvedValue({ ...absent(), removed: true });

    await mount();
    // Only the re-read after the delete fails.
    api.getOperatorInstructions.mockRejectedValue(apiError(500, "Could not re-read the file."));
    await act(async () => buttonLabelled("Delete file")!.click());
    await act(async () => buttonLabelled("Delete file", "modal")!.click());
    await settle();

    expect(host.textContent).toContain("Could not re-read");
    expect(buttonLabelled("Try again")).toBeDefined();
    // No editor left open over a file that no longer exists.
    expect(editor()).toBeNull();
  });
});

describe("deleting the file", () => {
  test("confirms first, then deletes against the loaded version", async () => {
    api.getOperatorInstructions.mockResolvedValue(present("Be terse."));
    api.deleteOperatorInstructions.mockResolvedValue({ ...absent(), removed: true });
    await mount();

    await act(async () => buttonLabelled("Delete file")!.click());
    expect(host.textContent).toContain("Delete OMNESIS.md?");
    expect(api.deleteOperatorInstructions).not.toHaveBeenCalled();

    api.getOperatorInstructions.mockResolvedValue(absent());
    await act(async () => buttonLabelled("Delete file", "modal")!.click());
    await settle();
    expect(api.deleteOperatorInstructions).toHaveBeenCalledWith(1000.5);
    expect(host.textContent).toContain("runs on its defaults again");
  });
});
