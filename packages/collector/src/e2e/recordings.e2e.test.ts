// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Recorded conversations E2E — the Android "record a conversation" contract
 * against a spawned gateway.
 *
 * A phone opens a session, uploads numbered chunks while it records (in any
 * order, retried, some silent), and finishes it; the gateway transcribes the
 * chunks as they arrive and writes one searchable document per session. The
 * synthetic transcriber decodes each chunk's bytes as UTF-8, so no Whisper
 * model is needed; the replay voice separator reads the same scripted chunks
 * to tell speakers apart. The routes exist only in experimental mode.
 */

import "./synth-env.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";

const START = "2026-03-02T09:00:00.000Z";

interface RecordingStatus {
  id: string;
  state: "recording" | "transcribing" | "done";
  chunkCount: number | null;
  chunks: {
    received: number;
    pending: number;
    transcribed: number;
    failed: number;
    silent: number;
  };
}

async function putChunk(
  harness: SyntheticE2EHarness,
  id: string,
  seq: number,
  spoken: string | null,
): Promise<Response> {
  const form = new FormData();
  form.set(
    "chunk",
    JSON.stringify({
      startedAt: new Date(Date.parse(START) + seq * 60_000).toISOString(),
      durationMs: 60_000,
      ...(spoken === null ? { silent: true } : {}),
    }),
  );
  if (spoken !== null) {
    form.set("audio", new Blob([new TextEncoder().encode(spoken)], { type: "audio/aac" }), "c.aac");
  }
  // Encode the form first: the harness defaults a bodied request without a
  // Content-Type to JSON, which would drop the multipart boundary.
  const encoded = new Response(form);
  return harness.gatewayFetch(`/recordings/${id}/chunks/${seq}`, {
    method: "PUT",
    headers: { "Content-Type": encoded.headers.get("content-type")! },
    body: await encoded.arrayBuffer(),
  });
}

describe("recorded conversations in experimental mode (E2E)", () => {
  let harness: SyntheticE2EHarness;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "experimental",
      transcriberBackend: "replay",
      extraGatewayConfig: { inference: { recordings: { speakers: "replay" } } },
    });
    await harness.start();
  }, 60_000);

  afterAll(async () => {
    await harness.destroy();
  });

  test("a conversation uploaded in chunks becomes one searchable document, and deleting it removes it", async () => {
    const health = await harness.gatewayJson<{ capabilities: Record<string, unknown> }>("/health");
    expect(health.capabilities.recordings).toEqual({ min: 1, max: 1 });

    const id = randomUUID();
    const start = await harness.gatewayFetch("/recordings", {
      method: "POST",
      body: JSON.stringify({
        id,
        title: "Site walkthrough",
        startedAt: START,
        startedTimeZoneId: "Europe/Rome",
        startedUtcOffsetSeconds: 3600,
        language: "en-GB",
      }),
    });
    expect(start.status).toBe(201);

    // Out of order, with a retry and a silent minute, as a phone draining
    // its outbox after a dropped connection would send them.
    expect((await putChunk(harness, id, 2, "The kitchen needs new tiles.")).status).toBe(200);
    expect((await putChunk(harness, id, 0, "Welcome to the estate tour.")).status).toBe(200);
    expect((await putChunk(harness, id, 0, "Welcome to the estate tour.")).status).toBe(200);
    expect((await putChunk(harness, id, 1, null)).status).toBe(200);

    const finished = await harness.gatewayFetch(`/recordings/${id}/finish`, {
      method: "POST",
      body: JSON.stringify({ chunkCount: 3, endedAt: "2026-03-02T09:03:00.000Z" }),
    });
    expect(finished.status).toBe(200);

    await vi.waitFor(
      async () => {
        const status = await harness.gatewayJson<RecordingStatus>(`/recordings/${id}`);
        expect(status).toMatchObject({
          state: "done",
          chunkCount: 3,
          chunks: { received: 3, transcribed: 2, silent: 1, pending: 0 },
        });
      },
      { timeout: 20_000, interval: 250 },
    );

    const search = await harness.gatewayJson<{
      results?: Array<{ source_id: string; content?: string; title?: string }>;
    }>(`/documents/search?q=${encodeURIComponent("new tiles")}&limit=10`);
    const hits = (search.results ?? []).filter((r) => r.source_id === "omnesis-recordings");
    expect(hits).toHaveLength(1);

    const { internalSources } = await harness.gatewayJson<{
      internalSources: Array<{ id: string }>;
    }>("/admin/sources");
    expect(internalSources.map((s) => s.id)).toContain("omnesis-recordings");

    expect((await harness.gatewayFetch(`/recordings/${id}`, { method: "DELETE" })).status).toBe(
      204,
    );
    await vi.waitFor(
      async () => {
        const after = await harness.gatewayJson<{ results?: Array<{ source_id: string }> }>(
          `/documents/search?q=${encodeURIComponent("new tiles")}&limit=10`,
        );
        expect(
          (after.results ?? []).filter((r) => r.source_id === "omnesis-recordings"),
        ).toHaveLength(0);
      },
      { timeout: 10_000, interval: 250 },
    );
  });
});

describe("recorded conversation speakers in experimental mode (E2E)", () => {
  let harness: SyntheticE2EHarness;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "experimental",
      transcriberBackend: "replay",
      extraGatewayConfig: { inference: { recordings: { speakers: "replay" } } },
    });
    await harness.start();
    // The universe's people, one of whom stands in for the guest.
    await harness.syncAllSources();
    await harness.waitForPeopleResolution();
  }, 180_000);

  afterAll(async () => {
    await harness.destroy();
  });

  test("speakers mapped to people name the transcript and link the conversation to them", async () => {
    const id = randomUUID();
    await harness.gatewayFetch("/recordings", {
      method: "POST",
      body: JSON.stringify({ id, title: "Design sync", startedAt: START, language: "en-GB" }),
    });
    const script = (lines: Array<[number, number, string, string]>) =>
      JSON.stringify({
        segments: lines.map(([startMs, endMs, voice, text]) => ({ startMs, endMs, voice, text })),
      });
    await putChunk(
      harness,
      id,
      0,
      script([
        [0, 3_000, "guest", "The mockups are ready for review."],
        [4_000, 6_000, "owner", "Send them over today."],
      ]),
    );
    await putChunk(harness, id, 1, script([[0, 4_000, "guest", "Done, check your inbox."]]));
    await harness.gatewayFetch(`/recordings/${id}/finish`, {
      method: "POST",
      body: JSON.stringify({ chunkCount: 2, endedAt: "2026-03-02T09:02:00.000Z" }),
    });
    await vi.waitFor(
      async () => {
        expect(await harness.gatewayJson<RecordingStatus>(`/recordings/${id}`)).toMatchObject({
          state: "done",
        });
      },
      { timeout: 20_000, interval: 250 },
    );

    const { speakers } = await harness.gatewayJson<{
      speakers: Array<{ speaker: number; samples: string[] }>;
    }>(`/recordings/${id}/speakers`);
    expect(speakers.map((s) => s.samples[0])).toEqual([
      "The mockups are ready for review.",
      "Send them over today.",
    ]);

    // Any person of the universe stands in for the guest.
    const { items } = await harness.gatewayJson<{
      items: Array<{ id: string; canonicalName: string; isSelf: boolean }>;
    }>("/people/search?q=&limit=10");
    const guest = items.find((p) => !p.isSelf)!;
    for (const [speaker, body] of [
      [1, { personId: guest.id }],
      [2, { self: true }],
    ] as const) {
      const res = await harness.gatewayFetch(`/recordings/${id}/speakers/${speaker}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
    }

    await vi.waitFor(
      async () => {
        const search = await harness.gatewayJson<{
          results?: Array<{ id: string; source_id: string }>;
        }>(`/documents/search?q=${encodeURIComponent("mockups")}&limit=10`);
        const hit = (search.results ?? []).find((r) => r.source_id === "omnesis-recordings")!;
        const { content } = await harness.gatewayJson<{ content: string }>(`/documents/${hit.id}`);
        expect(content).toContain(`${guest.canonicalName}: The mockups are ready for review.`);
        expect(content).toContain("You: Send them over today.");
        const { people } = await harness.gatewayJson<{
          people: Array<{ personId: string; role: string }>;
        }>(`/documents/${hit.id}/people`);
        expect(people).toContainEqual(
          expect.objectContaining({ personId: guest.id, role: "participant" }),
        );
      },
      { timeout: 40_000, interval: 500 },
    );
  }, 90_000);
});

describe("recorded conversations in stable mode (E2E)", () => {
  let harness: SyntheticE2EHarness;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", transcriberBackend: "replay" });
    await harness.start();
  }, 60_000);

  afterAll(async () => {
    await harness.destroy();
  });

  test("the routes do not exist and nothing advertises them", async () => {
    const res = await harness.gatewayFetch("/recordings", {
      method: "POST",
      body: JSON.stringify({ id: randomUUID(), startedAt: START }),
    });
    expect(res.status).toBe(404);
    const health = await harness.gatewayJson<{ capabilities: Record<string, unknown> }>("/health");
    expect(health.capabilities.recordings).toBeUndefined();
    const { internalSources } = await harness.gatewayJson<{
      internalSources: Array<{ id: string }>;
    }>("/admin/sources");
    expect(internalSources.map((s) => s.id)).not.toContain("omnesis-recordings");
  });
});
