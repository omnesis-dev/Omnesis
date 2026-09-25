// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  CAPTURE_HANDOFF_FAILURE_KEY,
  CAPTURE_HANDOFF_OVERFLOW_KEY,
  CAPTURE_PENDING_PREFIX,
} from "./chrome/messages.js";
import {
  CAPTURE_PERMISSION_STATE_KEY,
  CONFIG_KEY,
  INSTALL_ID_KEY,
  PAIRING_KEY,
  PROFILE_LABEL_KEY,
  TOKEN_KEY,
} from "./chrome/storage.js";
import { PAIRING_ATTEMPT_KEY } from "./chrome/pairing-attempt.js";
import { CAPTURE_POLICY_KEY } from "./capture/policy.js";
import { PUSH_SERVER_STATE_KEY } from "./push/observability.js";
import { QUEUE_CORRUPTION_KEY, QUEUE_OVERFLOW_KEY, QUEUE_STORAGE_KEY } from "./push/queue.js";

/**
 * Every `chrome.storage.local` key the extension writes is an on-disk contract
 * with the installs already out there: an upgrade that reads a renamed key
 * finds nothing and silently unpairs the browser, drops its queue, or forgets
 * its exclusions. Keys are therefore append-only. Renaming one requires a
 * migration that reads the old key on worker start, and this table changes in
 * the same commit — never on its own.
 */
describe("chrome.storage.local keys are append-only", () => {
  it("pins every persisted key to its literal", () => {
    expect({
      PAIRING_KEY,
      TOKEN_KEY,
      CONFIG_KEY,
      CAPTURE_PERMISSION_STATE_KEY,
      INSTALL_ID_KEY,
      PROFILE_LABEL_KEY,
      CAPTURE_POLICY_KEY,
      CAPTURE_HANDOFF_FAILURE_KEY,
      CAPTURE_HANDOFF_OVERFLOW_KEY,
      CAPTURE_PENDING_PREFIX,
      QUEUE_STORAGE_KEY,
      QUEUE_CORRUPTION_KEY,
      QUEUE_OVERFLOW_KEY,
      PUSH_SERVER_STATE_KEY,
      PAIRING_ATTEMPT_KEY,
    }).toEqual({
      PAIRING_KEY: "omnesis.pairing.v1",
      TOKEN_KEY: "omnesis.token.v1",
      // Legacy combined record; read only by the worker-start migration.
      CONFIG_KEY: "omnesis.config.v1",
      CAPTURE_PERMISSION_STATE_KEY: "omnesis.capture.hostPermission.v1",
      INSTALL_ID_KEY: "omnesis.installId.v1",
      PROFILE_LABEL_KEY: "omnesis.browserProfileLabel.v1",
      // The browser's copy of the gateway-owned capture settings. The keys the
      // settings lived under while they were browser-local
      // (`omnesis.capture.denylist.v1`, `omnesis.capture.pause.v1`) are read
      // once by the worker-start migration and then removed.
      CAPTURE_POLICY_KEY: "omnesis.capture.policy.v1",
      CAPTURE_HANDOFF_FAILURE_KEY: "omnesis.capture.handoffFailure.v1",
      CAPTURE_HANDOFF_OVERFLOW_KEY: "omnesis.capture.handoffOverflow.v1",
      CAPTURE_PENDING_PREFIX: "omnesis.capture.pending.v1.",
      QUEUE_STORAGE_KEY: "omnesis.push.queue.v1",
      QUEUE_CORRUPTION_KEY: "omnesis.push.queueCorruption.v1",
      QUEUE_OVERFLOW_KEY: "omnesis.push.queueOverflow.v1",
      PUSH_SERVER_STATE_KEY: "omnesis.push.serverState.v1",
      PAIRING_ATTEMPT_KEY: "omnesis.pairing.attempt.v1",
    });
  });
});
