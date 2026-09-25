// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";

/**
 * The carrier-visible wake is intentionally incapable of carrying content.
 * A phone resolves the notification by claiming it from its paired gateway.
 */
export const pushWakeSchema = z.object({}).strict();
export type PushWake = z.infer<typeof pushWakeSchema>;
export const PUSH_WAKE: PushWake = Object.freeze({});

/** Exact carrier payload for an iOS alert wake. No caller input is accepted. */
export const APNS_WAKE_PAYLOAD = Object.freeze({
  aps: Object.freeze({
    alert: Object.freeze({
      title: "Omnesis",
      body: "Omnesis has something for you",
    }),
    "mutable-content": 1 as const,
    sound: "default" as const,
  }),
});

/** Stable serialized bytes used by invariant tests and the APNs carrier. */
export const APNS_WAKE_JSON = JSON.stringify(APNS_WAKE_PAYLOAD);

/** Exact flat FCM data map for an Android wake. No caller input is accepted. */
export const FCM_WAKE_DATA = Object.freeze({ wake: "1" as const });
