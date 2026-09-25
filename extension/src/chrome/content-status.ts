// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { CAPTURE_STATUS_MESSAGE, type CaptureContentStatus } from "./messages.js";

type RuntimeMessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
) => boolean | void | Promise<unknown>;

interface RuntimeMessageEvent {
  addListener(listener: RuntimeMessageListener): void;
  removeListener(listener: RuntimeMessageListener): void;
}

/** Attach the popup status responder and return an idempotent teardown. */
export function attachCaptureStatusListener(
  readStatus: () => CaptureContentStatus,
  event: RuntimeMessageEvent = chrome.runtime.onMessage,
): () => void {
  const listener: RuntimeMessageListener = (message, _sender, sendResponse) => {
    if ((message as { type?: string })?.type !== CAPTURE_STATUS_MESSAGE.type) return false;
    sendResponse(readStatus());
    return false;
  };
  event.addListener(listener);
  let attached = true;
  return () => {
    if (!attached) return;
    attached = false;
    try {
      event.removeListener(listener);
    } catch {
      // Extension reload can invalidate the context before teardown runs.
    }
  };
}
