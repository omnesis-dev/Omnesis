// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { expect, test } from "vitest";
import { SCOPE_ADMIN, SCOPE_READ, DeviceId, TokenId } from "@omnesis/types";
import { ConfigStore } from "../../../config-store.js";
import { strictRoute } from "../../scope.js";
import { errorResponse, HttpError } from "../../errors.js";
import { mountRecordingReviewRoutes } from "./recording-review.js";
import type { AppEnv } from "../types.js";

test("admin review works with Lab off, refuses nonadmin/stale resumes, and changes only the reviewed flag", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omnesis-recording-route-"));
  const store = new ConfigStore({ filePath: join(dir, "omnesis.json") });
  try {
    await store.load();
    await store.patch({
      inference: {
        assignments: { transcriber: null },
        recordings: { restoreReviewRequired: true, keepAudioDays: 0 },
      },
    });
    const app = strictRoute(new Hono<AppEnv>());
    app.onError((error, c) => {
      if (error instanceof HttpError) return errorResponse(c, error);
      throw error;
    });
    app.use("*", async (c, next) => {
      c.set("auth", {
        authMethod: "bearer",
        deviceId: DeviceId("00000000-0000-4000-8000-000000000001"),
        tokenId: TokenId("00000000-0000-4000-8000-000000000002"),
        scopes: c.req.header("x-fixture-admin") === "yes" ? [SCOPE_ADMIN] : [SCOPE_READ],
      });
      await next();
    });
    mountRecordingReviewRoutes(app, store, () => false);
    const path = "/admin/recordings/restore-review";
    const headers = { "x-fixture-admin": "yes", "content-type": "application/json" };
    expect((await app.request(path)).status).toBe(403);
    const first = await app.request(path, { headers });
    expect(first.status).toBe(200);
    const review = await first.json();
    expect(review).toMatchObject({
      reviewRequired: true,
      keepAudioDays: 0,
      transcriberAssignment: null,
      speakers: "off",
    });
    await store.patch({ inference: { recordings: { keepAudioDays: 7 } } });
    expect(
      (
        await app.request(path + "/resume", {
          method: "POST",
          headers,
          body: JSON.stringify({ version: review.version }),
        })
      ).status,
    ).toBe(409);
    const current = await (await app.request(path, { headers })).json();
    expect(
      (
        await app.request(path + "/resume", {
          method: "POST",
          headers,
          body: JSON.stringify({ version: current.version + "\n" }),
        })
      ).status,
    ).toBe(400);
    expect(store.get().inference?.recordings?.restoreReviewRequired).toBe(true);
    expect(
      (
        await app.request(path + "/resume", {
          method: "POST",
          headers,
          body: JSON.stringify({ version: current.version, unreviewed: true }),
        })
      ).status,
    ).toBe(400);
    const resumed = await app.request(path + "/resume", {
      method: "POST",
      headers,
      body: JSON.stringify({ version: current.version }),
    });
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({
      reviewRequired: false,
      keepAudioDays: 7,
      transcriberAssignment: null,
    });
  } finally {
    store.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
