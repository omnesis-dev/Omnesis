// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Recordings, the experimental portal page: the list of recorded conversations, and
// one recording with its speakers to name, its chunks, kept audio to play, and
// deletion behind a confirmation.

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({
  deleteRecording: vi.fn(),
  getPeople: vi.fn(),
  getRecordingChunkAudio: vi.fn(),
  getRecordingChunks: vi.fn(),
  getRecordingSpeakers: vi.fn(),
  listRecordings: vi.fn(),
  setRecordingSpeaker: vi.fn(),
}));
const router = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock("../api.js", () => api);
vi.mock("../lib/router.js", () => router);

// @ts-expect-error — portal modules are plain JS.
import { RecordingsView, chunkSummary, formatOffset, formatRecordedTime, speakerSummary } from "./recordings.js";

const ID = "8f14e45f-ceea-467a-9575-7d5b2b2a5e11";
const START = "2026-03-02T09:00:00.000Z";

function recording(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    title: "Planning the move",
    startedAt: START,
    state: "done",
    chunkCount: 3,
    chunks: { received: 3, pending: 0, transcribed: 2, failed: 1, silent: 0 },
    durationMs: 180_000,
    speakers: 2,
    namedSpeakers: 0,
    documentId: "doc-1",
    ...overrides,
  };
}

function speaker(n: number, overrides: Record<string, unknown> = {}) {
  return {
    speaker: n,
    isSelf: false,
    personId: null,
    name: null,
    talkMs: 65_000,
    samples: [`Line ${n}`],
    ...overrides,
  };
}

const CHUNKS = [
  { seq: 0, startedAt: START, durationMs: 60_000, status: "transcribed", interrupted: false, audio: true, audioDeletedAt: "2026-03-05T09:01:00.000Z" },
  { seq: 1, startedAt: "2026-03-02T09:01:00.000Z", durationMs: 60_000, status: "failed", interrupted: true, audio: false, audioDeletedAt: null },
  { seq: 2, startedAt: "2026-03-02T09:02:00.000Z", durationMs: 60_000, status: "transcribed", interrupted: false, audio: false, audioDeletedAt: null },
];

describe("recording vocabulary", () => {
  test("recorded time reads in seconds, minutes, then hours", () => {
    expect(formatRecordedTime(0)).toBe("0 s");
    expect(formatRecordedTime(40_000)).toBe("40 s");
    expect(formatRecordedTime(12 * 60_000)).toBe("12 min");
    expect(formatRecordedTime(65 * 60_000)).toBe("1 h 05 min");
  });

  test("a chunk's place in the recording reads as the transcript stamps it", () => {
    expect(formatOffset(0)).toBe("00:00:00");
    expect(formatOffset(125_400)).toBe("00:02:05");
    expect(formatOffset(3_725_000)).toBe("01:02:05");
    expect(formatOffset(-5)).toBe("00:00:00");
  });

  test("the chunk line names only what is worth a look", () => {
    expect(chunkSummary(recording({ chunks: { received: 1, pending: 0, failed: 0 }, chunkCount: null }))).toBe("1 chunk");
    expect(chunkSummary(recording())).toBe("3 chunks · 1 not transcribed");
    expect(chunkSummary(recording({ chunkCount: 5, chunks: { received: 3, pending: 2, failed: 0 } }))).toBe(
      "3 of 5 chunks · 2 waiting",
    );
  });

  test("speakers are counted only once some were told apart", () => {
    expect(speakerSummary(recording({ speakers: 0 }))).toBeNull();
    expect(speakerSummary(recording({ speakers: 3, namedSpeakers: 2 }))).toBe("2 of 3 speakers named");
  });
});

describe("Recordings page", () => {
  let host: HTMLElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#root") as unknown as HTMLElement;
    api.getRecordingChunks.mockResolvedValue({ recording: recording(), chunks: CHUNKS });
    api.getRecordingSpeakers.mockResolvedValue({ speakers: [speaker(1), speaker(2)] });
  });

  afterEach(() => {
    render(null, host);
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
  });

  async function settle() {
    for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); });
  }

  async function mount(props: Record<string, unknown> = {}) {
    await act(async () => { render(h(RecordingsView, props), host); await Promise.resolve(); });
    await settle();
  }

  const text = () => host.textContent ?? "";
  const button = (label: string) =>
    [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
  const speakerRow = (n: number) => host.querySelector(`.recording-speaker[data-speaker="${n}"]`) as HTMLElement;
  const within = (root: HTMLElement, label: string) =>
    [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;

  async function click(target: HTMLElement | undefined) {
    expect(target).toBeDefined();
    await act(async () => { target!.click(); });
    await settle();
  }

  async function type(input: HTMLInputElement, value: string) {
    await act(async () => {
      input.value = value;
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  }

  test("lists each recording with where it stands", async () => {
    api.listRecordings.mockResolvedValue({
      recordings: [recording(), recording({ id: "other", title: "Standup", state: "transcribing", speakers: 0 })],
    });
    await mount();
    const rows = [...host.querySelectorAll(".recordings-list li")];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Planning the move");
    expect(rows[0]!.textContent).toContain("3 min · 3 chunks · 1 not transcribed");
    expect(rows[0]!.textContent).toContain("0 of 2 speakers named");
    expect(rows[0]!.textContent).toContain("Done");
    expect(rows[1]!.textContent).toContain("Transcribing");
    expect(rows[1]!.textContent).not.toContain("speakers named");
    expect(rows[0]!.querySelector("a")?.getAttribute("href")).toBe(`/portal/recordings/${ID}`);
  });

  test("says how to record one when there is none", async () => {
    api.listRecordings.mockResolvedValue({ recordings: [] });
    await mount();
    expect(text()).toContain("No recorded conversations yet");
  });

  test("a gateway outside experimental mode has no recordings to list", async () => {
    api.listRecordings.mockRejectedValue(Object.assign(new Error("404"), { status: 404 }));
    await mount();
    expect(text()).toContain("Recordings are off");
    expect(host.querySelector(".privacy-banner.error")).toBeNull();
  });

  test("one recording shows its speakers, its chunks and a link to its transcript", async () => {
    await mount({ recordingId: ID });
    expect(api.getRecordingChunks).toHaveBeenCalledWith(ID);
    expect(host.querySelector("h1")?.textContent).toBe("Planning the move");
    expect(host.querySelectorAll(".recording-speaker")).toHaveLength(2);
    expect(speakerRow(1).textContent).toContain("Not named yet");
    expect(speakerRow(1).textContent).toContain("Spoke for 1 min");
    expect(speakerRow(1).textContent).toContain("“Line 1”");
    const chunks = [...host.querySelectorAll(".recording-chunk")];
    expect(chunks.map((c) => c.querySelector(".recording-chunk-at")?.textContent)).toEqual([
      "00:00:00",
      "00:01:00",
      "00:02:00",
    ]);
    expect(chunks.map((c) => c.querySelector(".recording-chunk-status")?.textContent?.trim())).toEqual([
      "Transcribed",
      "Not transcribed · interrupted",
      "Transcribed",
    ]);
    // Only a chunk whose audio is kept can be played.
    expect(chunks[0]!.querySelector(".recording-chunk-play button")).not.toBeNull();
    expect(chunks[0]!.textContent).toContain("Audio kept until");
    expect(chunks[2]!.querySelector(".recording-chunk-play")).toBeNull();
    await click([...host.querySelectorAll("a")].find((a) => a.textContent === "Open the transcript"));
    expect(router.navigate).toHaveBeenCalledWith("/portal/doc/doc-1");
  });

  test("a recording that is gone says so", async () => {
    api.getRecordingChunks.mockRejectedValue(Object.assign(new Error("404"), { status: 404 }));
    await mount({ recordingId: ID });
    expect(text()).toContain("No recording here");
  });

  test("the owner says a speaker is them", async () => {
    api.setRecordingSpeaker.mockResolvedValue({ speakers: [speaker(1, { isSelf: true }), speaker(2)] });
    await mount({ recordingId: ID });
    await click(within(speakerRow(1), "This is me"));
    expect(api.setRecordingSpeaker).toHaveBeenCalledWith(ID, 1, { self: true });
    expect(speakerRow(1).querySelector(".recording-speaker-who")?.textContent).toBe("You");
    // A named speaker can be cleared; being them already, "This is me" is gone.
    expect(within(speakerRow(1), "Clear")).toBeDefined();
    expect(within(speakerRow(1), "This is me")).toBeUndefined();
  });

  test("the owner gives a speaker a plain name", async () => {
    api.setRecordingSpeaker.mockResolvedValue({ speakers: [speaker(1), speaker(2, { name: "Maya" })] });
    await mount({ recordingId: ID });
    await click(within(speakerRow(2), "Type a name…"));
    await type(speakerRow(2).querySelector("input") as HTMLInputElement, "  Maya ");
    await act(async () => {
      speakerRow(2).querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(api.setRecordingSpeaker).toHaveBeenCalledWith(ID, 2, { name: "Maya" });
    expect(speakerRow(2).querySelector(".recording-speaker-who")?.textContent).toBe("Maya");
  });

  test("the owner picks a person for a speaker", async () => {
    api.getPeople.mockResolvedValue({ people: [{ id: "person-7", canonicalName: "Maya" }] });
    api.setRecordingSpeaker.mockResolvedValue({
      speakers: [speaker(1, { personId: "person-7", name: "Maya" }), speaker(2)],
    });
    await mount({ recordingId: ID });
    await click(within(speakerRow(1), "Choose a person…"));
    await type(speakerRow(1).querySelector("input") as HTMLInputElement, "May");
    await vi.waitFor(() => expect(api.getPeople).toHaveBeenCalledWith("May", 8));
    await settle();
    await click(within(speakerRow(1), "Maya"));
    expect(api.setRecordingSpeaker).toHaveBeenCalledWith(ID, 1, { personId: "person-7" });
    expect(speakerRow(1).textContent).toContain("Maya, from People");
  });

  test("a refused mapping is shown on the speaker's row", async () => {
    api.setRecordingSpeaker.mockRejectedValue(Object.assign(new Error("400"), { serverMessage: "no such person" }));
    await mount({ recordingId: ID });
    await click(within(speakerRow(1), "This is me"));
    expect(speakerRow(1).querySelector("[role=alert]")?.textContent).toBe("no such person");
  });

  test("kept audio is fetched and played on demand", async () => {
    api.getRecordingChunkAudio.mockResolvedValue(new Blob(["audio"], { type: "audio/aac" }));
    await mount({ recordingId: ID });
    await click(host.querySelector(".recording-chunk-play button") as HTMLButtonElement);
    expect(api.getRecordingChunkAudio).toHaveBeenCalledWith(ID, 0);
    expect(host.querySelector("audio.recording-chunk-audio")?.getAttribute("src")).toMatch(/^blob:/);
  });

  test("audio deleted meanwhile says it is gone", async () => {
    api.getRecordingChunkAudio.mockRejectedValue(Object.assign(new Error("404"), { status: 404 }));
    await mount({ recordingId: ID });
    await click(host.querySelector(".recording-chunk-play button") as HTMLButtonElement);
    expect(host.querySelector(".recording-chunk-error")?.textContent).toBe("The audio is gone.");
  });

  test("deleting asks first, then returns to the list", async () => {
    api.deleteRecording.mockResolvedValue(null);
    await mount({ recordingId: ID });
    await click(button("Delete recording"));
    expect(api.deleteRecording).not.toHaveBeenCalled();
    expect(text()).toContain("Delete this recording?");
    await click(button("Delete"));
    expect(api.deleteRecording).toHaveBeenCalledWith(ID);
    expect(router.navigate).toHaveBeenCalledWith("/portal/recordings");
  });
});
