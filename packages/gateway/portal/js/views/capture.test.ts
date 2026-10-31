// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { createNote, deleteNoteEntry, getNotesHistory, getNotesForDay, getNotesProvenance, getStatus, patchNoteEntry, undoTask } = vi.hoisted(() => ({
  createNote: vi.fn(),
  deleteNoteEntry: vi.fn(),
  getNotesHistory: vi.fn(),
  getNotesForDay: vi.fn(),
  getNotesProvenance: vi.fn(),
  getStatus: vi.fn(),
  patchNoteEntry: vi.fn(),
  undoTask: vi.fn(),
}));
vi.mock("../api.js", () => ({
  createNote,
  deleteNoteEntry,
  getNotesHistory,
  getNotesForDay,
  getNotesProvenance,
  getStatus,
  patchNoteEntry,
  undoTask,
}));

// @ts-expect-error — portal is plain JS without sibling declarations.
import * as captureModule from "./capture.js";

const { CONFIRMATION_MS, CaptureView, MAX_NOTE_LENGTH, captureErrorMessage, captureRequest, noteDayHeading } =
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
  getNotesForDay.mockReset().mockResolvedValue({ entries: [] });
  getNotesProvenance.mockReset();
  getStatus.mockReset();
  getStatus.mockResolvedValue({ tasks: { available: true, noteAgent: false } });
  undoTask.mockReset();
  getNotesProvenance.mockResolvedValue({ mentions: [], annotations: [], loops: [] });
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
    expect(host.querySelector(".capture-told")).not.toBeNull();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
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

describe("day headings", () => {
  test("uses the local calendar for Today and Yesterday across a month boundary", () => {
    const now = new Date(2026, 9, 1, 9);
    expect(noteDayHeading("2026-10-01", now).label).toBe("Today");
    expect(noteDayHeading("2026-09-30", now).label).toBe("Yesterday");
    expect(noteDayHeading("2026-09-29", now).label).toBe(new Date(2026, 8, 29, 12).toLocaleDateString([], { month: "short", day: "numeric" }));
    expect(noteDayHeading("2026-09-29", now).fullDate).toBe(new Date(2026, 8, 29, 12).toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" }));
  });
});

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
    expect(host.querySelector(".capture-day-count")?.textContent).toBe("1 note shown");
    expect(host.querySelector(".capture-day")?.getAttribute("data-day")).toBe("2026-09-11");

    // linkedom has no IntersectionObserver, so the pager falls back to an
    // explicit "Show more" button (real browsers auto-load on scroll).
    await click("Show more");
    expect(noteTexts()).toEqual(["Second", "First"]);
    const days = Array.from(host.querySelectorAll(".capture-day")).map((d) => d.getAttribute("data-day"));
    expect(days).toEqual(["2026-09-11", "2026-09-10"]);
    // Mount (beforeEach default), remount with the override, then load-more.
    expect(getNotesHistory).toHaveBeenCalledTimes(3);
    const lastCall = getNotesHistory.mock.calls[2][0];
    expect(lastCall).toMatchObject({ cursor: "cursor-1", limit: 25 });
  });

  test("puts notes before day-level relationships and links the combined document from the heading", async () => {
    getNotesHistory.mockResolvedValue({
      entries: [noteEntry({ id: "n1", text: "Workshop preparation" }), noteEntry({ id: "n2", text: "Bring the registration form" })],
      pageInfo: { hasMore: false },
    });
    getNotesProvenance.mockResolvedValue({ documentId: "daily/document", mentions: [], annotations: [], loops: [] });
    await act(async () => {
      render(null, host);
      render(h(CaptureView, {}), host);
    });
    await act(async () => {});
    // Provenance arrives after history and then updates the parent day heading.
    // Wait for that observable update rather than assuming a fixed effect count.
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(host.querySelector(".capture-day-link")?.getAttribute("href")).toBe("/portal/doc/daily%2Fdocument");
    });
    const group = host.querySelector(".capture-day-group")!;
    expect(group.querySelector(".capture-day-count")?.textContent).toBe("2 notes");
    expect(group.querySelector(".capture-day-link")?.getAttribute("href")).toBe("/portal/doc/daily%2Fdocument");
    expect(group.querySelector(".capture-day-link")?.textContent).toBe("View combined note");
    expect(group.querySelector("time")?.getAttribute("datetime")).toBe("2026-09-11");
    const children = Array.from(group.children);
    expect(children.indexOf(group.querySelector(".portal-table-wrap")!)).toBeLessThan(children.indexOf(group.querySelector(".note-day-references")!));
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

  test("a voice note awaiting its gateway transcript says so, then shows the transcript", async () => {
    vi.useFakeTimers();
    const pending = noteEntry({
      id: "voice-1",
      text: "water the fens",
      transcription: "pending",
    });
    const typed = noteEntry({ id: "typed-1", text: "A typed note" });
    getNotesHistory.mockResolvedValueOnce({
      entries: [pending, typed],
      pageInfo: { hasMore: false },
    });
    await act(async () => {
      render(null, host);
      render(h(CaptureView, {}), host);
    });
    await act(async () => {});

    const badge = () => host.querySelectorAll(".note-item-transcribing");
    expect(badge()).toHaveLength(1);
    expect(noteItems()[0].querySelector(".note-item-transcribing")?.textContent).toContain(
      "Transcribing on your gateway",
    );
    expect(noteItems()[1].querySelector(".note-item-transcribing")).toBeNull();

    getNotesHistory.mockResolvedValue({
      entries: [{ ...pending, text: "Water the ferns.", transcription: undefined }, typed],
      pageInfo: { hasMore: false },
    });
    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    await act(async () => {});
    expect(noteItems()[0].querySelector(".note-item-text")?.textContent).toBe("Water the ferns.");
    expect(badge()).toHaveLength(0);

    // Nothing pending any more: the list stops re-reading.
    const calls = getNotesHistory.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(getNotesHistory.mock.calls.length).toBe(calls);
  });

  test("a transcribed voice note is not marked edited; an edit after it is", async () => {
    getNotesHistory.mockResolvedValue({
      entries: [
        noteEntry({
          id: "transcribed",
          updatedAt: "2026-09-11T10:02:00.000Z",
          transcribedAt: "2026-09-11T10:02:00.000Z",
        }),
        noteEntry({
          id: "edited-after",
          updatedAt: "2026-09-11T10:05:00.000Z",
          transcribedAt: "2026-09-11T10:02:00.000Z",
        }),
      ],
      pageInfo: { hasMore: false },
    });
    await act(async () => {
      render(null, host);
      render(h(CaptureView, {}), host);
    });
    await act(async () => {});
    const edited = noteItems().map((row) => row.textContent?.includes("edited"));
    expect(edited).toEqual([false, true]);
  });

  test("references are requested once per day even when it contains several notes", async () => {
    getNotesHistory.mockResolvedValue({
      entries: [
        noteEntry({ id: "same-day-a" }),
        noteEntry({ id: "same-day-b" }),
        noteEntry({ id: "older", day: "2026-09-10" }),
      ],
      pageInfo: { hasMore: false },
    });
    await act(async () => {
      render(null, host);
      render(h(CaptureView, {}), host);
    });
    await act(async () => {});
    expect(host.querySelectorAll(".note-day-references")).toHaveLength(2);
    expect(getNotesProvenance.mock.calls.map(([day]) => day)).toEqual(["2026-09-11", "2026-09-10"]);
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

describe("the note agent's receipts", () => {
  async function mountWith(entries: unknown[], status = { tasks: { available: true, noteAgent: true } }) {
    getStatus.mockResolvedValue(status);
    getNotesHistory.mockResolvedValue({ entries, pageInfo: { hasMore: false } });
    await act(async () => {
      render(null, host);
      render(h(CaptureView, {}), host);
    });
    await act(async () => {});
  }

  const doneNote = noteEntry({
    id: "note-done",
    text: "Call the vet about the booster on Friday",
    agent: {
      state: "done",
      receipt: {
        text: "Added a task for Friday.",
        changes: [
          { text: "Added: Call the vet about the booster", taskId: "loop_a", undoSeq: 41 },
          { text: "Noted the clinic's new hours", taskId: null, undoSeq: null },
        ],
      },
    },
  });

  test("the hint shows only when the gateway runs the note agent", async () => {
    await mountWith([], { tasks: { available: true, noteAgent: false } });
    expect(host.querySelector(".capture-agent-hint")).toBeNull();
    await mountWith([]);
    expect(host.querySelector(".capture-agent-hint")?.textContent).toBe("Omnesis will act on what you tell it");
  });

  test("a done note shows its receipt, task links and Undo", async () => {
    await mountWith([doneNote]);
    const receipt = host.querySelector(".note-agent-receipt")!;
    expect(receipt.querySelector(".note-agent-text")?.textContent).toBe("Added a task for Friday.");
    const changes = Array.from(receipt.querySelectorAll(".note-agent-change"));
    expect(changes).toHaveLength(2);
    expect(changes[0].querySelector("a")?.getAttribute("href")).toBe("/portal/tasks");
    expect(changes[0].querySelector(".note-agent-undo")).not.toBeNull();
    expect(changes[1].querySelector("a")).toBeNull();
    expect(changes[1].querySelector(".note-agent-undo")).toBeNull();
  });

  test("Undo reverts the change, marks it undone and toasts the gateway's receipt", async () => {
    undoTask.mockResolvedValueOnce({ task: null, receipt: { text: "Removed: Call the vet about the booster", undoSeq: null } });
    await mountWith([doneNote]);
    await act(async () => {
      (host.querySelector(".note-agent-undo") as HTMLButtonElement).click();
    });
    await act(async () => {});
    expect(undoTask).toHaveBeenCalledWith(41);
    expect(host.querySelector(".note-agent-change.undone .note-agent-undone")?.textContent).toBe("Undone");
    expect(host.querySelector(".note-agent-receipt .toast")?.textContent).toBe("Removed: Call the vet about the booster");
  });

  test("an Undo refused because a later change exists says so", async () => {
    undoTask.mockRejectedValueOnce(Object.assign(new Error("conflict"), { status: 409 }));
    await mountWith([doneNote]);
    await act(async () => {
      (host.querySelector(".note-agent-undo") as HTMLButtonElement).click();
    });
    await act(async () => {});
    expect(host.querySelector(".note-agent-error")?.textContent).toBe(
      "A later change to this task has to be undone first.",
    );
    expect(host.querySelector(".note-agent-change.undone")).toBeNull();
  });

  test("failed reads quietly and skipped shows nothing", async () => {
    await mountWith([
      noteEntry({ id: "failed", agent: { state: "failed", receipt: null } }),
      noteEntry({ id: "skipped", text: "Second", agent: { state: "skipped", receipt: { text: "Nothing to do.", changes: [] } } }),
    ]);
    const rows = noteItems();
    expect(rows[0].querySelector(".note-agent-failed")?.textContent?.trim()).toBe("Omnesis couldn't act on this note.");
    expect(rows[1].querySelector(".note-agent")).toBeNull();
  });

  async function editTo(text: string) {
    await clickRowAction("Edit", noteItems().at(-1)!);
    await act(async () => {
      const editor = host.querySelector('[aria-label="Edit note"]') as HTMLTextAreaElement;
      editor.value = text;
      editor.dispatchEvent(new parsed.window.Event("input", { bubbles: true }));
    });
    await click("Save");
  }

  test("an edited older loaded note clears its old receipt and refreshes outside the head page", async () => {
    vi.useFakeTimers();
    const old = noteEntry({ id: "older", day: "2026-08-10", capturedAt: "2026-08-10T10:00:00.000Z", updatedAt: "2026-08-10T10:00:00.000Z", text: "Plan the greenhouse", agent: { state: "done", receipt: { text: "Added the greenhouse task.", changes: [] } } });
    const head = noteEntry({ id: "newer", text: "A newer note" });
    getNotesHistory.mockImplementation(async ({ cursor }: { cursor?: string }) => cursor
      ? { entries: [old], pageInfo: { hasMore: false } }
      : { entries: [head], pageInfo: { hasMore: true, nextCursor: "older-page" } });
    await act(async () => { render(null, host); render(h(CaptureView, {}), host); });
    await act(async () => {});
    await click("Show more");
    expect(host.textContent).toContain("Added the greenhouse task.");
    const updated = { ...old, text: "Move the greenhouse task to Friday", updatedAt: "2026-09-12T10:00:00.000Z", agent: { state: "pending", receipt: null } };
    patchNoteEntry.mockResolvedValueOnce(updated);
    await editTo(updated.text);
    expect(host.textContent).not.toContain("Added the greenhouse task.");
    expect(host.querySelector(".note-agent-reading")).not.toBeNull();
    getNotesForDay.mockResolvedValue({ entries: [{ ...updated, agent: { state: "done", receipt: { text: "Moved the greenhouse task to Friday.", changes: [] } } }] });
    await act(async () => { vi.advanceTimersByTime(5_000); });
    await act(async () => {});
    expect(getNotesForDay).toHaveBeenCalledExactlyOnceWith("2026-08-10");
    expect(host.textContent).toContain("Moved the greenhouse task to Friday.");
    expect(host.querySelector(".note-agent-reading")).toBeNull();
  });

  test("a poll started before an edit cannot restore the old revision's success", async () => {
    vi.useFakeTimers();
    const reading = noteEntry({ id: "note-done", agent: { state: "running", receipt: null } });
    await mountWith([reading]);
    let release!: (value: unknown) => void;
    getNotesHistory.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    await act(async () => { vi.advanceTimersByTime(5_000); });
    const updated = { ...reading, text: "Plan the greenhouse on Friday", updatedAt: "2026-09-12T10:00:00.000Z", agent: { state: "pending", receipt: null } };
    patchNoteEntry.mockResolvedValueOnce(updated);
    await editTo(updated.text);
    await act(async () => { release({ entries: [doneNote], pageInfo: { hasMore: false } }); });
    await act(async () => {});
    expect(host.textContent).not.toContain("Added a task for Friday.");
    expect(host.querySelector(".note-agent-reading")).not.toBeNull();
    expect(noteTexts()).toEqual([updated.text]);
    getNotesHistory.mockResolvedValue({ entries: [{ ...updated, agent: { state: "done", receipt: { text: "Planned the greenhouse for Friday.", changes: [] } } }], pageInfo: { hasMore: false } });
    await act(async () => { vi.advanceTimersByTime(5_000); });
    await act(async () => {});
    expect(host.textContent).toContain("Planned the greenhouse for Friday.");
  });

  test("a note being read refreshes every five seconds until its receipt arrives", async () => {
    vi.useFakeTimers();
    const reading = noteEntry({ id: "note-done", agent: { state: "running", receipt: null } });
    await mountWith([reading]);
    expect(host.querySelector(".note-agent-reading")?.textContent?.trim()).toBe("Omnesis is reading this…");
    getNotesHistory.mockResolvedValue({ entries: [doneNote], pageInfo: { hasMore: false } });
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    await act(async () => {});
    expect(host.querySelector(".note-agent-reading")).toBeNull();
    expect(host.querySelector(".note-agent-text")?.textContent).toBe("Added a task for Friday.");
    const calls = getNotesHistory.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(getNotesHistory.mock.calls.length).toBe(calls);
  });
});

describe("inactive note processing notice", () => {
  test("saves notes while showing the Agent model remedy", async () => {
    render(null, host);
    getStatus.mockResolvedValue({ noteAgent: { enabled: true, modelAssigned: false, active: false } });
    await act(async () => { render(h(CaptureView, {}), host); });
    await act(async () => {});
    expect(host.textContent).toContain("Agent model is missing or unavailable");
    expect(host.querySelector('a[href="/portal/settings/models/agent"]')).not.toBeNull();
    expect(host.querySelector("textarea")).not.toBeNull();
    createNote.mockResolvedValueOnce({ id: "saved-warning", day: "2026-09-11", text: "Plan a greenhouse", capturedAt: "2026-09-11T10:00:00Z" });
    await type("Plan a greenhouse");
    await submit();
    expect(createNote).toHaveBeenCalledOnce();
    expect(host.querySelector(".capture-told")).not.toBeNull();
  });
});
