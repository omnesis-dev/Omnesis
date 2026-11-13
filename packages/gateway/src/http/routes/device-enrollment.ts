// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { cloudRelayEnabled } from "@omnesis/core";
import {
  deviceSignatureSchema,
  EnrollmentChallenges,
  enrollmentOpaque,
  tokenRotationTranscript,
  verifyDeviceSignature,
} from "@omnesis/cloud-relay";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { getDeviceEnrollmentPublicKey } from "../../data/repositories/DeviceRepository.js";
import { HttpError } from "../errors.js";
import { scope } from "../scope.js";
import { validateJson } from "../validate.js";
import { log } from "./admin/internals.js";
import type Database from "better-sqlite3";
import type { WriteGate } from "../../write-gate.js";
import type { RouteApp } from "./types.js";

/** How long a rotated-away token keeps working, so requests in flight still land. */
const TOKEN_OVERLAP_MS = 60 * 60 * 1000;

const rotateBody = z
  .object({ challenge: enrollmentOpaque, signature: deviceSignatureSchema })
  .strict();

export interface DeviceEnrollmentRoutesDeps {
  db: Database.Database;
  writeGate: WriteGate;
  /** Every TLS key a client may have reached this gateway through. */
  spkiFingerprints: () => readonly string[];
  now?: () => number;
}

/**
 * Device-key token rotation. Mounted only behind the cloud relay opt-in: off
 * it, these routes do not exist.
 */
export function mountDeviceEnrollmentRoutes(app: RouteApp, deps: DeviceEnrollmentRoutesDeps): void {
  if (!cloudRelayEnabled()) return;
  const { db, writeGate: w, spkiFingerprints } = deps;
  const rotationChallenges = new EnrollmentChallenges(deps.now ?? Date.now);
  const bounded = bodyLimit({
    maxSize: 20_000,
    onError: (c) => c.json({ error: "Request body too large", code: "PAYLOAD_TOO_LARGE" }, 413),
  });

  app.post("/devices/token/challenge", scope.deviceSelf(), (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(rotationChallenges.issue());
  });

  app.post(
    "/devices/token/rotate",
    scope.deviceSelf(),
    bounded,
    validateJson(rotateBody),
    async (c) => {
      c.header("Cache-Control", "no-store");
      const auth = c.get("auth");
      const deviceId = auth.deviceId!;
      const { challenge, signature } = c.req.valid("json");
      const devicePublicKey = getDeviceEnrollmentPublicKey(db, deviceId);
      if (!devicePublicKey) {
        throw new HttpError(
          409,
          "DEVICE_KEY_REQUIRED",
          "This device has no device key, so its token cannot be rotated this way.",
        );
      }
      const signed = spkiFingerprints().some((gatewaySpkiFingerprint) =>
        verifyDeviceSignature(
          devicePublicKey,
          tokenRotationTranscript({ deviceId, gatewaySpkiFingerprint, challenge, devicePublicKey }),
          signature,
        ),
      );
      if (!signed) {
        throw new HttpError(403, "TOKEN_ROTATION_REFUSED", "Token rotation refused");
      }
      // A signature is only checked against a challenge the gateway issued, or
      // against the receipt the writer holds for a retry of this same request.
      const result = await w.rotateDeviceToken({
        deviceId,
        tokenId: auth.tokenId!,
        challenge,
        signature,
        challengeConsumed: rotationChallenges.consume(challenge),
        overlapMs: TOKEN_OVERLAP_MS,
      });
      if (result.outcome === "refused") {
        throw new HttpError(
          409,
          "TOKEN_HAS_EXPIRY",
          "A token with its own expiry cannot be rotated into one without it.",
        );
      }
      if (result.outcome !== "rotated") {
        throw new HttpError(403, "TOKEN_ROTATION_REFUSED", "Token rotation refused");
      }
      if (!result.replayed) log.info(`Device token rotated: device=${deviceId}`);
      return c.json({ token: result.token, tokenId: result.tokenId });
    },
  );
}
