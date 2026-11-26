// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { getScope } from "../api.js";
import { adminJsonRequest } from "./admin-request.js";

const request = adminJsonRequest("/admin/recordings/restore-review", "Restored recording review");

/** Client cache only avoids known-forbidden requests; the server remains the authorization boundary. */
export function mayRequestRecordingReview() {
  let scope;
  try {
    scope = getScope();
  } catch {
    return true;
  }
  if (scope == null) return true;
  return scope === "admin" || (Array.isArray(scope) && scope.includes("admin"));
}

export function recordingReviewSnapshot(value) {
  if (
    !value ||
    typeof value.reviewRequired !== "boolean" ||
    typeof value.hasPendingChunks !== "boolean" ||
    !Number.isSafeInteger(value.keepAudioDays) ||
    value.keepAudioDays < 0 ||
    value.keepAudioDays > 365 ||
    !(
      value.transcriberAssignment === null ||
      (typeof value.transcriberAssignment === "string" &&
        value.transcriberAssignment.length > 0 &&
        new TextEncoder().encode(value.transcriberAssignment).length <= 1024 &&
        !/[\u0000-\u001f\u007f-\u009f]/u.test(value.transcriberAssignment))
    ) ||
    !["off", "local", "replay"].includes(value.speakers) ||
    typeof value.version !== "string" ||
    value.version.length !== 64 ||
    !/^[a-f0-9]{64}$/.test(value.version)
  ) {
    throw new Error(
      "Current recording choices could not be verified. Check again before resuming.",
    );
  }
  return {
    reviewRequired: value.reviewRequired,
    hasPendingChunks: value.hasPendingChunks,
    keepAudioDays: value.keepAudioDays,
    transcriberAssignment: value.transcriberAssignment,
    speakers: value.speakers,
    version: value.version,
  };
}

export async function getRecordingRestoreReview({ signal } = {}) {
  return recordingReviewSnapshot(await request("GET", "", { signal }));
}

export async function resumeRecordingRestoreReview(version, { signal } = {}) {
  if (typeof version !== "string" || version.length !== 64 || !/^[a-f0-9]{64}$/.test(version))
    throw new Error("Review the current choices before resuming.");
  return recordingReviewSnapshot(await request("POST", "/resume", { body: { version }, signal }));
}
