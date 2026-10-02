// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Voice notes E2E — the mobile apps' quick-capture voice-note contract against a
 * spawned gateway.
 *
 * A phone reads `dictation` on `GET /status` and, while it is active, sends a
 * quick-capture note to `POST /notes/voice` with its audio and its own
 * transcript. The gateway saves the note at once and its transcriber replaces
 * the text afterwards. This drives the lifecycle an operator goes through: the
 * feature on by default once a transcriber is assigned, a note saved and later
 * transcribed, a note transcribed that the device had no text for, and the
 * setting switched off through `PATCH /admin/config` (what the portal and the
 * apps' settings do). The gateway runs the synthetic transcriber, which decodes
 * the audio bytes as UTF-8, so no Whisper model is needed. Both stable and
 * experimental gateways prove the same generally available contract.
 */

import "./synth-env.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";

interface DictationStatus {
  visible: boolean;
  enabled: boolean;
  modelAssigned: boolean;
  active: boolean;
  reason?: string;
  maxAudioBytes: number;
}

interface NoteEntry {
  id: string;
  text: string;
}

async function dictationStatus(harness: SyntheticE2EHarness): Promise<DictationStatus> {
  return (await harness.gatewayJson<{ dictation: DictationStatus }>("/status")).dictation;
}

async function sendVoiceNote(
  harness: SyntheticE2EHarness,
  note: { id: string; text?: string },
  spoken: string,
): Promise<Response> {
  const form = new FormData();
  form.set("note", JSON.stringify({ ...note, language: "en-GB", surface: "ios-app" }));
  form.set("audio", new Blob([new TextEncoder().encode(spoken)], { type: "audio/mp4" }), "n.m4a");
  // Encode the form first: the harness defaults a bodied request without a
  // Content-Type to JSON, which would drop the multipart boundary.
  const encoded = new Response(form);
  return harness.gatewayFetch("/notes/voice", {
    method: "POST",
    headers: { "Content-Type": encoded.headers.get("content-type")! },
    body: await encoded.arrayBuffer(),
  });
}

async function noteText(harness: SyntheticE2EHarness, id: string): Promise<string | undefined> {
  const { entries } = await harness.gatewayJson<{ entries: NoteEntry[] }>("/notes");
  return entries.find((entry) => entry.id === id)?.text;
}

async function setOptIn(harness: SyntheticE2EHarness, on: boolean): Promise<void> {
  await harness.gatewayJson("/admin/config", {
    method: "PATCH",
    body: JSON.stringify({ inference: { dictation: { transcribeOnGateway: on } } }),
  });
}

describe.each(["stable", "experimental"] as const)(
  "voice notes in %s mode (E2E)",
  (gatewayMode) => {
    let harness: SyntheticE2EHarness;

    beforeAll(async () => {
      harness = new SyntheticE2EHarness({
        gatewayMode,
        transcriberBackend: "replay",
      });
      await harness.start();
    }, 60_000);

    afterAll(async () => {
      await harness.destroy();
    });

    test("the feature is on by default once a transcriber is assigned", async () => {
      expect(await dictationStatus(harness)).toMatchObject({
        visible: true,
        enabled: true,
        modelAssigned: true,
        active: true,
      });
    });

    test("a voice note is saved at once and transcribed by the gateway", async () => {
      const id = randomUUID();
      const res = await sendVoiceNote(
        harness,
        { id, text: "book a table for for on thursday" },
        "Book a table for four on Thursday.",
      );
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ id, transcription: "pending" });

      await vi.waitFor(
        async () => expect(await noteText(harness, id)).toBe("Book a table for four on Thursday."),
        { timeout: 15_000, interval: 250 },
      );
    });

    test("a note the device had no transcript for is transcribed all the same", async () => {
      const id = randomUUID();
      expect((await sendVoiceNote(harness, { id }, "Renew the parking permit.")).status).toBe(202);
      await vi.waitFor(
        async () => expect(await noteText(harness, id)).toBe("Renew the parking permit."),
        { timeout: 15_000, interval: 250 },
      );
    });

    test("switching it off takes effect without a restart", async () => {
      await setOptIn(harness, false);
      expect((await dictationStatus(harness)).active).toBe(false);
      const res = await sendVoiceNote(harness, { id: randomUUID(), text: "too late" }, "too late");
      expect(res.status).toBe(409);
    });
  },
);
