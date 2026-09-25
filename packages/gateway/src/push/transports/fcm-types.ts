// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Configuration for the direct FCM transport. */
export interface FcmConfig {
  serviceAccountPath: string;
  projectId?: string;
  appId?: string;
  baseUrl?: string;
}

/** Addressing for one content-free FCM wake. */
export interface FcmWake {
  registrationToken: string;
}

export type FcmSendResult =
  | { ok: true; name: string | null }
  | {
      ok: false;
      statusCode: number;
      reason: string;
      unregistered: boolean;
    };
