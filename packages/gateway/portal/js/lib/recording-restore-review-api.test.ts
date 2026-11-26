// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { beforeEach, expect, test, vi } from "vitest";
const api = vi.hoisted(() => ({ apiFetch: vi.fn(), getScope: vi.fn() }));
vi.mock("../api.js", () => api);
// @ts-expect-error — portal modules are plain JS.
import * as recordingReview from "./recording-restore-review-api.js";
const {
  getRecordingRestoreReview,
  mayRequestRecordingReview,
  recordingReviewSnapshot,
  resumeRecordingRestoreReview,
} = recordingReview;
const version = "a".repeat(64);
const snapshot = {
  reviewRequired: true,
  hasPendingChunks: false,
  keepAudioDays: 0,
  transcriberAssignment: null,
  speakers: "local",
  version,
};
const json = (status: number, body: unknown) => ({
  ok: status < 400,
  status,
  json: async () => body,
});
beforeEach(() => {
  vi.resetAllMocks();
  api.getScope.mockReturnValue(["admin"]);
  api.apiFetch.mockResolvedValue(json(200, snapshot));
});

test("uses exact admin routes and one version-bound body through existing authenticated request helper", async () => {
  const signal = new AbortController().signal;
  expect(await getRecordingRestoreReview({ signal })).toEqual(snapshot);
  await resumeRecordingRestoreReview(version, { signal });
  expect(
    api.apiFetch.mock.calls.map(([path, init]) => [
      path,
      init.method,
      init.body,
      init.cache,
      init.signal,
    ]),
  ).toEqual([
    ["/admin/recordings/restore-review", "GET", undefined, "no-store", signal],
    [
      "/admin/recordings/restore-review/resume",
      "POST",
      JSON.stringify({ version }),
      "no-store",
      signal,
    ],
  ]);
});

test("known nonadministrative cache suppresses requests without treating unknown scope as authorization", () => {
  for (const scope of [["read:documents"], "read", []]) {
    api.getScope.mockReturnValue(scope);
    expect(mayRequestRecordingReview()).toBe(false);
  }
  for (const scope of [["admin"], "admin", null]) {
    api.getScope.mockReturnValue(scope);
    expect(mayRequestRecordingReview()).toBe(true);
  }
});

test("rejects missing/unknown policies and malformed versions rather than enabling resume", () => {
  for (const patch of [
    { hasPendingChunks: undefined },
    { reviewRequired: 1 },
    { keepAudioDays: Infinity },
    { keepAudioDays: -1 },
    { keepAudioDays: 366 },
    { transcriberAssignment: "x".repeat(1025) },
    { transcriberAssignment: "é".repeat(513) },
    { transcriberAssignment: "model\nname" },
    { transcriberAssignment: "model\u007fname" },
    { transcriberAssignment: "model\u0085name" },
    { speakers: "remote" },
    { transcriberAssignment: {} },
    { version: [version] },
    { version: version + "\n" },
  ]) {
    expect(() => recordingReviewSnapshot({ ...snapshot, ...patch })).toThrow();
  }
  expect(recordingReviewSnapshot({ ...snapshot, undisclosed: "not part of the DTO" })).toEqual(
    snapshot,
  );
});

test("stale choices remain a 409 for the view to recheck, with no automatic retry", async () => {
  api.apiFetch.mockResolvedValue(json(409, { error: "Recording choices changed." }));
  await expect(resumeRecordingRestoreReview(version)).rejects.toMatchObject({
    status: 409,
    serverMessage: "Recording choices changed.",
  });
  expect(api.apiFetch).toHaveBeenCalledOnce();
});

test("invalid CAS token never sends a mutation", async () => {
  await expect(resumeRecordingRestoreReview("invalid")).rejects.toThrow();
  await expect(resumeRecordingRestoreReview(version + "\n")).rejects.toThrow();
  expect(api.apiFetch).not.toHaveBeenCalled();
});

test("accepts boundary retention and UTF-8 model identifiers", () => {
  expect(
    recordingReviewSnapshot({
      ...snapshot,
      keepAudioDays: 365,
      transcriberAssignment: "é".repeat(512),
    }),
  ).toMatchObject({ keepAudioDays: 365, transcriberAssignment: "é".repeat(512) });
});
