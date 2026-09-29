// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Gateway dictation E2E — the mobile apps' contract against a real spawned
 * gateway.
 *
 * A phone reads `dictation` on `GET /status` and sends the audio it recorded
 * to `POST /dictation/transcribe` only while that verdict is active. This
 * drives the whole lifecycle an operator goes through: the feature advertised
 * but off, the opt-in written through `PATCH /admin/config` (what the portal
 * and the apps' settings do), the transcript returned, and the opt-in
 * withdrawn. The gateway runs the synthetic transcriber, which decodes the
 * audio bytes as UTF-8, so no Whisper model is needed. A stable-mode gateway
 * proves the surface does not exist outside experimental mode.
 */

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";

interface DictationStatus {
  visible: boolean;
  enabled: boolean;
  modelAssigned: boolean;
  active: boolean;
  reason?: string;
  maxAudioBytes: number;
}

const enc = (s: string) => new TextEncoder().encode(s);

async function dictationStatus(harness: SyntheticE2EHarness): Promise<DictationStatus> {
  return (await harness.gatewayJson<{ dictation: DictationStatus }>("/status")).dictation;
}

function dictate(harness: SyntheticE2EHarness, text: string, query = ""): Promise<Response> {
  return harness.gatewayFetch(`/dictation/transcribe${query}`, {
    method: "POST",
    headers: { "Content-Type": "audio/mp4" },
    body: enc(text) as unknown as BodyInit,
  });
}

async function setOptIn(harness: SyntheticE2EHarness, on: boolean): Promise<void> {
  await harness.gatewayJson("/admin/config", {
    method: "PATCH",
    body: JSON.stringify({ inference: { dictation: { transcribeOnGateway: on } } }),
  });
}

describe("gateway dictation in experimental mode (E2E)", () => {
  let harness: SyntheticE2EHarness;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "experimental",
      transcriberBackend: "replay",
    });
    await harness.start();
  }, 60_000);

  afterAll(async () => {
    await harness.destroy();
  });

  test("the feature is advertised but off until the operator opts in", async () => {
    const status = await dictationStatus(harness);
    expect(status).toMatchObject({
      visible: true,
      enabled: false,
      modelAssigned: true,
      active: false,
    });
    expect(status.maxAudioBytes).toBeGreaterThan(0);

    const res = await dictate(harness, "not yet");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("DICTATION_DISABLED");
  });

  test("once opted in, the gateway transcribes dictation audio", async () => {
    await setOptIn(harness, true);
    expect((await dictationStatus(harness)).active).toBe(true);

    const res = await dictate(harness, "book a table for four on thursday", "?language=en");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string; language?: string };
    expect(body.text).toBe("book a table for four on thursday");
    expect(body.language).toBe("en");
  });

  test("withdrawing the opt-in takes effect without a restart", async () => {
    await setOptIn(harness, false);
    expect((await dictationStatus(harness)).active).toBe(false);
    expect((await dictate(harness, "too late")).status).toBe(409);
  });
});

describe("gateway dictation outside experimental mode (E2E)", () => {
  let harness: SyntheticE2EHarness;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", transcriberBackend: "replay" });
    await harness.start();
  }, 60_000);

  afterAll(async () => {
    await harness.destroy();
  });

  test("the route does not exist and the status is inactive, even with the opt-in set", async () => {
    await setOptIn(harness, true);
    expect(await dictationStatus(harness)).toMatchObject({
      visible: false,
      enabled: true,
      active: false,
    });
    expect((await dictate(harness, "hello")).status).toBe(404);
  });
});
