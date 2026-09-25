// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Ending a watch's access to an integration, honestly.
 *
 * The record that authorises a wake is the one thing on a watch's page that can
 * be taken away without taking the watch with it, so the two actions live
 * apart: revoking stops the waking and keeps everything already sent, and
 * purging removes a record that has already reached a terminal state.
 */

import {
  getPrivacySubscription,
  purgePrivacySubscription,
  revokePrivacySubscription,
} from "../../api.js";
import { privacySubscriptionDocument } from "./vocabulary.js";

/**
 * Revokes a watch's access, and treats a failed POST as unrevoked unless one
 * authoritative read proves the record reached a terminal state anyway.
 *
 * A revoke that succeeded on the gateway and lost its response would otherwise
 * be reported as still-granted, which is the one direction this must never get
 * wrong.
 */
export async function revokePrivacySubscriptionRequest(subscriptionId) {
  let actionError;
  try {
    const detail = privacySubscriptionDocument(await revokePrivacySubscription(subscriptionId));
    if (!detail) throw new Error("Subscription revoke response was incomplete.");
    return detail;
  } catch (error) {
    actionError = error;
  }

  try {
    const detail = privacySubscriptionDocument(await getPrivacySubscription(subscriptionId));
    if (detail && ["revoked", "expired"].includes(detail.status)) return detail;
  } catch {
    // Preserve the POST failure unless one authoritative read proves terminal state.
  }
  throw actionError;
}

export { purgePrivacySubscription };
