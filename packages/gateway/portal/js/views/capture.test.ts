// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { createNote, deleteNoteEntry, getNotesHistory, patchNoteEntry } = vi.hoisted(() => ({
  createNote: vi.fn(),
  deleteNoteEntry: vi.fn(),
  getNotesHistory: vi.fn(),
  patchNoteEntry: vi.fn(),
}));
vi.mock("../api.js", () => ({
  createNote,
  deleteNoteEntry,
  getNotesHistory,
  patchNoteEntry,
}));

// @ts-expect-error — portal is plain JS without sibling declarations.
import * as captureModule from "./capture.js";

const { CONFIRMATION_MS, CaptureView, MAX_NOTE_LENGTH, captureErrorMessage, captureRequest } =
  captureModule;

type Parsed = ReturnType<typeof parseHTML>;

let parsed: Parsed;
let host: HTMLElement;
let originalDocument: typeof globalThis.document | undefined;
let originalWindow: typeof globalThis.window | undefined;

function textarea(): HTMLTextAreaElement {
  return host.querySelector("textarea.capture-input") as HTMLTextAreaElement;
}

function submitButton(): HTMLButtonElement {
  return host.querySelector("button[type=submit]") as HTMLButtonElement;
}

async function type(value: string) {
  await act(async () => {
    textarea().value = value;
    textarea().dispatchEvent(new parsed.window.Event("input", { bubbles: true }));
  });
}

async function submit() {
  const form = host.querySelector("form");
  expect(form).not.toBeNull();
  await act(async () => {
    form!.dispatchEvent(new parsed.window.Event("submit", { bubbles: true }));
  });
}

async function keydown(init: { key: string; ctrlKey?: boolean; metaKey?: boolean }) {
  await act(async () => {
    // linkedom has no KeyboardEvent; a plain event carrying the key fields is
    // what the handler reads.
    const event = new parsed.window.Event("keydown", { bubbles: true });
    Object.assign(event, init);
    textarea().dispatchEvent(event);
  });
}

beforeEach(async () => {
  originalDocument = globalThis.document;
  originalWindow = globalThis.window;
  parsed = parseHTML("<html><body><div id='host'></div></body></html>");
  Object.assign(globalThis, { document: parsed.document, window: parsed.window });
  host = parsed.document.querySelector("#host") as unknown as HTMLElement;
  createNote.mockReset();
  deleteNoteEntry.mockReset();
  patchNoteEntry.mockReset();
  getNotesHistory.mockReset();
  getNotesHistory.mockResolvedValue({ entries: [], pageInfo: { hasMore: false } });
  await act(async () => {
    render(h(CaptureView, {}), host);
  });
  await act(async () => {});
});

afterEach(() => {
  render(null, host);
  if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
  else globalThis.document = originalDocument;
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else globalThis.window = originalWindow;
  vi.useRealTimers();
});

describe("capture page", () => {
  test("titles the page like the mobile screens and starts with the button off", () => {
    expect(host.querySelector("h1")?.textContent).toMatch(/^tell omnesis$/i);
    expect(textarea().getAttribute("placeholder")).toBe("What should Omnesis remember?");
    expect(submitButton().textContent?.trim()).toMatch(/^tell omnesis$/i);
    expect(submitButton().hasAttribute("disabled")).toBe(true);
  });

  test("a blank note never leaves the browser", async () => {
    await type("   \n ");
    expect(submitButton().hasAttribute("disabled")).toBe(true);
    await submit();
    expect(createNote).not.toHaveBeenCalled();
  });

  test("tells the gateway the trimmed note as a portal capture and confirms", async () => {
    vi.useFakeTimers();
    createNote.mockResolvedValueOnce({ id: "stored", day: "2026-09-11", text: "Renew the domain before the end of the month", capturedAt: "2026-09-11T10:00:00.000Z", updatedAt: "2026-09-11T10:00:00.000Z" });
    await type("  Renew the domain before the end of the month  ");
    expect(submitButton().hasAttribute("disabled")).toBe(false);
    await submit();

    expect(createNote).toHaveBeenCalledOnce();
    const body = createNote.mock.calls[0][0];
    expect(body.text).toBe("Renew the domain before the end of the month");
    expect(body.surface).toBe("portal");
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(body.capturedAt)).not.toBeNaN();
    expect(typeof body.capturedTimeZoneId).toBe("string");
    expect(typeof body.capturedUtcOffsetSeconds).toBe("number");

    expect(textarea().value).toBe("");
    expect(host.querySelector(".capture-told")?.textContent).toMatch(/told omnesis/i);
    expect(host.querySelector('[role="alert"]')).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(CONFIRMATION_MS - 1);
    });
    expect(host.querySelector(".capture-told")).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(host.querySelector(".capture-told")).toBeNull();
    expect(host.querySelector(".capture-hint")?.textContent).toContain("Enter");
  });

  test("while saving, the field is read-only and a second submit is ignored", async () => {
    let settle: (value: unknown) => void = () => {};
    createNote.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)));
    await type("Water the plants");
    await submit();

    expect(submitButton().textContent?.trim()).toMatch(/saving/i);
    expect(submitButton().hasAttribute("disabled")).toBe(true);
    expect(textarea().hasAttribute("readonly")).toBe(true);
    await submit();
    await keydown({ key: "Enter", ctrlKey: true });
    expect(createNote).toHaveBeenCalledOnce();

    await act(async () => {
      settle({ id: "stored" });
    });
    expect(host.querySelector(".capture-told")).not.toBeNull();
    expect(textarea().hasAttribute("readonly")).toBe(false);
  });

  test("unmounting clears the confirmation timer", async () => {
    vi.useFakeTimers();
    createNote.mockResolvedValueOnce({ id: "stored", day: "2026-09-11", text: "Renew the domain before the end of the month", capturedAt: "2026-09-11T10:00:00.000Z", updatedAt: "2026-09-11T10:00:00.000Z" });
    await type("Order printer paper");
    await submit();
    expect(vi.getTimerCount()).toBe(1);
    render(null, host);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("keeps the note in the editor and explains a refusal", async () => {
    createNote.mockRejectedValueOnce(Object.assign(new Error("Forbidden"), { status: 403 }));
    await type("Book the dentist");
    await submit();

    expect(textarea().value).toBe("Book the dentist");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("can't write notes");
    expect(submitButton().textContent?.trim()).toMatch(/^tell omnesis$/i);
    expect(submitButton().hasAttribute("disabled")).toBe(false);

    await act(async () => {
      host
        .querySelector('button[aria-label="Dismiss"]')
        ?.dispatchEvent(new parsed.window.Event("click", { bubbles: true }));
    });
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  test("a retry of the same note re-sends the same idempotency key", async () => {
    createNote.mockRejectedValueOnce(new Error("network"));
    createNote.mockResolvedValueOnce({ id: "stored", day: "2026-09-11", text: "Renew the domain before the end of the month", capturedAt: "2026-09-11T10:00:00.000Z", updatedAt: "2026-09-11T10:00:00.000Z" });
    await type("Call the plumber");
    await submit();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("try again");
    await submit();

    expect(createNote).toHaveBeenCalledTimes(2);
    expect(createNote.mock.calls[1][0]).toEqual(createNote.mock.calls[0][0]);
    expect(textarea().value).toBe("");
  });

  test("an edited note after a failure is a new capture", async () => {
    createNote.mockRejectedValueOnce(new Error("network"));
    createNote.mockResolvedValueOnce({ id: "stored", day: "2026-09-11", text: "Renew the domain before the end of the month", capturedAt: "2026-09-11T10:00:00.000Z", updatedAt: "2026-09-11T10:00:00.000Z" });
    await type("Call the plumber");
    await submit();
    await type("Call the plumber on Monday");
    await submit();

    expect(createNote.mock.calls[1][0].id).not.toBe(createNote.mock.calls[0][0].id);
    expect(createNote.mock.calls[1][0].text).toBe("Call the plumber on Monday");
  });

  test("refuses an over-long note before the round trip", async () => {
    await type("x".repeat(MAX_NOTE_LENGTH + 1));
    await submit();

    expect(createNote).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Too long");
    expect(textarea().value.length).toBe(MAX_NOTE_LENGTH + 1);
  });

  test("only a modifier+Enter submits; a bare Enter stays a newline", async () => {
    createNote.mockResolvedValue({ id: "stored" });
    await type("Pick up the parcel");
    await keydown({ key: "Enter" });
    expect(createNote).not.toHaveBeenCalled();
    await keydown({ key: "Enter", ctrlKey: true });
    expect(createNote).toHaveBeenCalledOnce();
    await type("Pick up the parcel tomorrow");
    await keydown({ key: "Enter", metaKey: true });
    expect(createNote).toHaveBeenCalledTimes(2);
  });
});

describe("captureRequest", () => {
  test("freezes the capture instant, zone and offset from the browser clock", () => {
    const now = new Date("2026-03-04T05:06:07.000Z");
    const body = captureRequest("note", now);
    expect(body.capturedAt).toBe("2026-03-04T05:06:07.000Z");
    expect(body.capturedUtcOffsetSeconds).toBe(-now.getTimezoneOffset() * 60);
    expect(body.capturedTimeZoneId).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    expect(body.surface).toBe("portal");
  });

  test("mints a fresh idempotency key per request", () => {
    expect(captureRequest("a").id).not.toBe(captureRequest("a").id);
  });
});

describe("captureErrorMessage", () => {
  test("names the actionable failures and falls back to a retry", () => {
    expect(captureErrorMessage({ status: 403 })).toContain("write notes");
    expect(captureErrorMessage({ status: 429 })).toContain("Too many");
    expect(captureErrorMessage({ status: 422 })).toContain("(422)");
    expect(captureErrorMessage({ status: 500 })).toContain("try again");
    expect(captureErrorMessage(undefined)).toContain("try again");
  });
});

function noteEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "note-1",
    day: "2026-09-11",
    text: "First note",
    capturedAt: "2026-09-11T10:00:00.000Z",
    updatedAt: "2026-09-11T10:00:00.000Z",
    ...overrides,
  };
}

function noteItems(): HTMLElement[] {
  return Array.from(host.querySelectorAll(".note-row"));
}

/** Open a row's "⋯" action menu, then run fn while it is open. */
async function withRowMenu(item: HTMLElement, fn: () => Promise<void>) {
  const trigger = item.querySelector(".row-action-trigger") as HTMLElement;
  expect(trigger).toBeTruthy();
  await act(async () => {
    trigger.dispatchEvent(new parsed.window.Event("click", { bubbles: true }));
  });
  await act(async () => {});
  await fn();
}

async function clickRowAction(label: string, item: HTMLElement) {
  await withRowMenu(item, async () => click(label, item));
}

function noteTexts(): string[] {
  return noteItems().map(
    (item) => item.querySelector(".note-item-text")?.textContent ?? "",
  );
}

function clickButton(label: string, scope: ParentNode = host): HTMLElement {
  const buttons = Array.from(scope.querySelectorAll("button"));
  const found = buttons.find((b) => b.textContent?.trim() === label);
  expect(found).toBeTruthy();
  return found!;
}

async function click(label: string, scope: ParentNode = host) {
  await act(async () => {
    clickButton(label, scope).dispatchEvent(
      new parsed.window.Event("click", { bubbles: true }),
    );
  });
  await act(async () => {});
}

describe("note history", () => {
  test("lists newest first under day headers and loads more without duplicates", async () => {
    getNotesHistory.mockImplementation(async ({ cursor }: { cursor?: string }) => {
      if (!cursor) {
        return {
          entries: [noteEntry({ id: "n2", text: "Second", capturedAt: "2026-09-11T11:00:00.000Z", updatedAt: "2026-09-11T11:00:00.000Z" })],
          pageInfo: { hasMore: true, nextCursor: "cursor-1" },
        };
      }
      return {
        entries: [noteEntry({ id: "n1", text: "First", day: "2026-09-10", capturedAt: "2026-09-10T11:00:00.000Z", updatedAt: "2026-09-10T11:00:00.000Z" })],
        pageInfo: { hasMore: false },
      };
    });
    await act(async () => {
      render(null, host);
      render(h(CaptureView, {}), host);
    });
    await act(async () => {});

    expect(noteTexts()).toEqual(["Second"]);
    expect(host.querySelector(".capture-day")?.textContent).toBe("2026-09-11");

    // linkedom has no IntersectionObserver, so the pager falls back to an
    // explicit "Show more" button (real browsers auto-load on scroll).
    await click("Show more");
    expect(noteTexts()).toEqual(["Second", "First"]);
    const days = Array.from(host.querySelectorAll(".capture-day")).map((d) => d.textContent);
    expect(days).toEqual(["2026-09-11", "2026-09-10"]);
    // Mount (beforeEach default), remount with the override, then load-more.
    expect(getNotesHistory).toHaveBeenCalledTimes(3);
    const lastCall = getNotesHistory.mock.calls[2][0];
    expect(lastCall).toMatchObject({ cursor: "cursor-1", limit: 25 });
  });

  test("rows are flat: title and one actions menu on the same row", async () => {
    getNotesHistory.mockResolvedValue({
      entries: [noteEntry({ id: "n1", text: "Flat me" })],
      pageInfo: { hasMore: false },
    });
    await act(async () => {
      render(null, host);
      render(h(CaptureView, {}), host);
    });
    await act(async () => {});

    const row = noteItems()[0];
    expect(row.tagName).toBe("TR");
    // The row holds only its two cells (the popover menu has no td).
    const cells = row.querySelectorAll("td");
    expect(cells).toHaveLength(2);
    expect(cells[0].querySelector(".note-item-text")?.textContent).toBe("Flat me");
    expect(cells[1].className).toContain("portal-table-actions-col");
    expect(cells[1].querySelector(".row-action-trigger")).toBeTruthy();
    // No inline Edit/Delete buttons — both live behind the menu.
    expect(cells[0].querySelector("button")).toBeNull();

    await withRowMenu(row, async () => {
      const items = Array.from(row.querySelectorAll('[role="menuitem"]')).map(
        (el) => el.textContent?.trim(),
      );
      expect(items).toEqual(["Edit", "Delete"]);
      expect(
        row.querySelector('[role="menuitem"].danger')?.textContent?.trim(),
      ).toBe("Delete");
    });
  });

  test("a fresh capture appears on top without a refetch", async () => {
    getNotesHistory.mockResolvedValue({ entries: [], pageInfo: { hasMore: false } });
    createNote.mockResolvedValueOnce(
      noteEntry({ id: "fresh", text: "Just told", capturedAt: "2026-09-11T12:00:00.000Z", updatedAt: "2026-09-11T12:00:00.000Z" }),
    );
    await type("Just told");
    await submit();
    expect(noteTexts()).toEqual(["Just told"]);
    expect(getNotesHistory).toHaveBeenCalledTimes(1);
  });

  test("a seeded second page omits the day (the route rejects day+cursor)", async () => {
    getNotesHistory.mockImplementation(async ({ cursor }: { cursor?: string }) => {
      if (!cursor) {
        return {
          entries: [noteEntry({ id: "n2", text: "Second" })],
          pageInfo: { hasMore: true, nextCursor: "cursor-1" },
        };
      }
      return {
        entries: [noteEntry({ id: "n1", text: "First" })],
        pageInfo: { hasMore: false },
      };
    });
    await act(async () => {
      render(null, host);
      render(h(CaptureView, { day: "2026-09-11" }), host);
    });
    await act(async () => {});

    // First page carries the seed — the route contract for Manage-notes links.
    expect(getNotesHistory).toHaveBeenCalledWith(
      expect.objectContaining({ day: "2026-09-11" }),
    );
    expect(noteTexts()).toEqual(["Second"]);

    await click("Show more");
    expect(noteTexts()).toEqual(["Second", "First"]);
    // The continuation must not re-send the seed: day+cursor is a 400.
    // (Call 0 is the beforeEach mount, call 1 the seeded first page.)
    const continuation = getNotesHistory.mock.calls[2][0];
    expect(continuation).toMatchObject({ cursor: "cursor-1", limit: 25 });
    expect(continuation.day).toBeUndefined();
  });

  test("a stale initial response cannot erase a just-captured note", async () => {
    let releaseInitial!: (value: unknown) => void;
    getNotesHistory.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseInitial = resolve as (value: unknown) => void;
        }),
    );
    await act(async () => {
      render(null, host);
      render(h(CaptureView, {}), host);
    });
    await act(async () => {});

    // Capture while the initial history load is still pending.
    createNote.mockResolvedValueOnce(
      noteEntry({ id: "fresh", text: "Just told", capturedAt: "2026-09-11T12:00:00.000Z", updatedAt: "2026-09-11T12:00:00.000Z" }),
    );
    await type("Just told");
    await submit();
    expect(noteTexts()).toEqual(["Just told"]);

    // The stale initial response lands afterwards (empty, from before the
    // capture). The confirmed note must survive it.
    await act(async () => {
      releaseInitial({ entries: [], pageInfo: { hasMore: false } });
    });
    await act(async () => {});
    expect(noteTexts()).toEqual(["Just told"]);
  });

  test.each([
    ["omits the note", { entries: [], pageInfo: { hasMore: false } }],
    [
      "includes an older copy of the note",
      {
        entries: [
          noteEntry({
            id: "fresh",
            text: "Just told",
            capturedAt: "2026-09-11T12:00:00.000Z",
            updatedAt: "2026-09-11T12:00:00.000Z",
          }),
        ],
        pageInfo: { hasMore: false },
      },
    ],
  ])(
    "a saved edit survives a stale initial response that %s",
    async (_label, stalePayload) => {
      let releaseInitial!: (value: unknown) => void;
      getNotesHistory.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseInitial = resolve as (value: unknown) => void;
          }),
      );
      await act(async () => {
        render(null, host);
        render(h(CaptureView, {}), host);
      });
      await act(async () => {});

      createNote.mockResolvedValueOnce(
        noteEntry({ id: "fresh", text: "Just told", capturedAt: "2026-09-11T12:00:00.000Z", updatedAt: "2026-09-11T12:00:00.000Z" }),
      );
      await type("Just told");
      await submit();
      expect(noteTexts()).toEqual(["Just told"]);

      // Edit the just-captured note and save: the server confirms the
      // corrected text with a newer version.
      patchNoteEntry.mockResolvedValueOnce(
        noteEntry({ id: "fresh", text: "Corrected", updatedAt: "2026-09-11T12:05:00.000Z" }),
      );
      await clickRowAction("Edit", noteItems()[0]);
      const area = noteItems()[0].querySelector("textarea") as HTMLTextAreaElement;
      await act(async () => {
        area.value = "Corrected";
        area.dispatchEvent(new parsed.window.Event("input", { bubbles: true }));
      });
      await click("Save", noteItems()[0]);
      expect(patchNoteEntry).toHaveBeenCalledWith("fresh", "Corrected");
      expect(noteTexts()).toEqual(["Corrected"]);

      // The stale initial response lands after the save. The corrected
      // text must win over the snapshot either way.
      await act(async () => {
        releaseInitial(stalePayload);
      });
      await act(async () => {});
      expect(noteTexts()).toEqual(["Corrected"]);
    },
  );

  test("edit saves through the API and an empty edit stays local", async () => {
    getNotesHistory.mockResolvedValue({
      entries: [noteEntry()],
      pageInfo: { hasMore: false },
    });
    await act(async () => {
      render(null, host);
      render(h(CaptureView, {}), host);
    });
    await act(async () => {});

    await clickRowAction("Edit", noteItems()[0]);
    const area = noteItems()[0].querySelector("textarea") as HTMLTextAreaElement;
    expect(area).not.toBeNull();
    await act(async () => {
      area.value = "   ";
      area.dispatchEvent(new parsed.window.Event("input", { bubbles: true }));
    });
    await click("Save", noteItems()[0]);
    expect(patchNoteEntry).not.toHaveBeenCalled();
    expect(noteItems()[0].querySelector('[role="alert"]')?.textContent).toMatch(/must not be empty/);

    patchNoteEntry.mockResolvedValueOnce(noteEntry({ text: "Amended" }));
    await act(async () => {
      area.value = "Amended";
      area.dispatchEvent(new parsed.window.Event("input", { bubbles: true }));
    });
    await click("Save", noteItems()[0]);
    expect(patchNoteEntry).toHaveBeenCalledWith("note-1", "Amended");
    expect(noteTexts()).toEqual(["Amended"]);
  });

  test("delete confirms, removes the row, and a 404 converges silently", async () => {
    getNotesHistory.mockResolvedValue({
      entries: [noteEntry({ id: "gone" }), noteEntry({ id: "stays", text: "Stays" })],
      pageInfo: { hasMore: false },
    });
    await act(async () => {
      render(null, host);
      render(h(CaptureView, {}), host);
    });
    await act(async () => {});

    deleteNoteEntry.mockResolvedValueOnce({});
    await clickRowAction("Delete", noteItems()[0]);
    await click("Delete", host.querySelector(".confirm-modal-backdrop") as unknown as ParentNode);
    expect(deleteNoteEntry).toHaveBeenCalledWith("gone");
    expect(noteTexts()).toEqual(["Stays"]);

    deleteNoteEntry.mockRejectedValueOnce({ status: 404 });
    await clickRowAction("Delete", noteItems()[0]);
    await click("Delete", host.querySelector(".confirm-modal-backdrop") as unknown as ParentNode);
    expect(noteTexts()).toEqual([]);
  });

  test("a failed load offers retry and a seeded day is passed through", async () => {
    getNotesHistory.mockRejectedValueOnce(new Error("boom"));
    await act(async () => {
      render(null, host);
      render(h(CaptureView, { day: "2026-09-01" }), host);
    });
    await act(async () => {});
    expect(getNotesHistory).toHaveBeenCalledWith(
      expect.objectContaining({ day: "2026-09-01" }),
    );
    expect(host.textContent).toMatch(/Couldn't load notes/);

    getNotesHistory.mockResolvedValue({ entries: [], pageInfo: { hasMore: false } });
    await click("Retry");
    expect(host.textContent).toMatch(/No notes on or before 2026-09-01/);
  });

  test("a failed delete keeps the row and shows the error", async () => {
    getNotesHistory.mockResolvedValue({
      entries: [noteEntry()],
      pageInfo: { hasMore: false },
    });
    await act(async () => {
      render(null, host);
      render(h(CaptureView, {}), host);
    });
    await act(async () => {});

    deleteNoteEntry.mockRejectedValueOnce({ status: 500 });
    await clickRowAction("Delete", noteItems()[0]);
    await click("Delete", host.querySelector(".confirm-modal-backdrop") as unknown as ParentNode);
    expect(noteTexts()).toEqual(["First note"]);
    expect(noteItems()[0].querySelector('[role="alert"]')?.textContent).toMatch(/Couldn't delete/);
  });
});
