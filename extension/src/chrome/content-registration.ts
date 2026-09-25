// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { CAPTURE_ORIGINS, hasCapturePermission } from "./host-permission.js";
import { loadCapturePermissionState } from "./storage.js";

export const CAPTURE_CONTENT_SCRIPT = {
  id: "omnesis-web-capture-v1",
  matches: CAPTURE_ORIGINS,
  js: ["content.js"],
  runAt: "document_idle",
  persistAcrossSessions: true,
} satisfies chrome.scripting.RegisteredContentScript;

interface ScriptingApi {
  getRegisteredContentScripts(filter: {
    ids?: string[];
  }): Promise<chrome.scripting.RegisteredContentScript[]>;
  registerContentScripts(scripts: chrome.scripting.RegisteredContentScript[]): Promise<void>;
  updateContentScripts(scripts: chrome.scripting.RegisteredContentScript[]): Promise<void>;
  unregisterContentScripts(filter: { ids?: string[] }): Promise<void>;
}

/** Keep dynamic capture injection in lockstep with optional HTTPS access. */
export async function syncCaptureContentScript(
  granted: boolean,
  scripting: ScriptingApi = chrome.scripting,
): Promise<void> {
  const ids = [CAPTURE_CONTENT_SCRIPT.id];
  const registered = (await scripting.getRegisteredContentScripts({ ids })).find(
    (script) => script.id === CAPTURE_CONTENT_SCRIPT.id,
  );
  if (granted && !registered) {
    await scripting.registerContentScripts([CAPTURE_CONTENT_SCRIPT]);
  } else if (granted && registered && !matchesCaptureRegistration(registered)) {
    await scripting.updateContentScripts([CAPTURE_CONTENT_SCRIPT]);
  } else if (!granted && registered) {
    await scripting.unregisterContentScripts({ ids });
  }
}

function matchesCaptureRegistration(script: chrome.scripting.RegisteredContentScript): boolean {
  return (
    arraysEqual(script.matches, CAPTURE_CONTENT_SCRIPT.matches) &&
    arraysEqual(script.js, CAPTURE_CONTENT_SCRIPT.js) &&
    script.runAt === CAPTURE_CONTENT_SCRIPT.runAt &&
    script.persistAcrossSessions === CAPTURE_CONTENT_SCRIPT.persistAcrossSessions
  );
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export async function hasCaptureContentScript(
  scripting: ScriptingApi = chrome.scripting,
): Promise<boolean> {
  return (await scripting.getRegisteredContentScripts({ ids: [CAPTURE_CONTENT_SCRIPT.id] })).some(
    (script) => script.id === CAPTURE_CONTENT_SCRIPT.id && matchesCaptureRegistration(script),
  );
}

/** Chrome access, dynamic injection, and the fail-closed storage mirror must agree. */
export async function hasCaptureAccess(
  readPermission: () => Promise<boolean> = hasCapturePermission,
  readRegistration: () => Promise<boolean> = hasCaptureContentScript,
  readMirroredState: () => Promise<boolean> = loadCapturePermissionState,
): Promise<boolean> {
  const [permission, registered, mirrored] = await Promise.all([
    readPermission(),
    readRegistration(),
    readMirroredState(),
  ]);
  return permission && registered && mirrored;
}
