// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import {
  DEFAULT_WEB_CAPTURE_RULES,
  type WebCapturePolicy,
} from "@omnesis/provider-web/capture-policy";
import { CAPTURE_POLICY_KEY } from "../capture/policy.js";
import { QUEUE_STORAGE_KEY } from "../push/queue.js";
import { CAPTURE_CONTENT_SCRIPT } from "./content-registration.js";
import {
  CAPTURE_PERMISSION_STATE_KEY,
  PAIRING_KEY,
  PROFILE_LABEL_KEY,
  TOKEN_KEY,
} from "./storage.js";

/**
 * Test doubles for the extension's own pages (popup, options). The page is the
 * real `public/*.html` parsed by linkedom, so the controllers are exercised
 * against the markup they ship with; `chrome` is an in-memory record plus a
 * scripted `runtime.sendMessage`. Every value is invented.
 */

export const TEST_PAIRING = {
  gatewayUrl: "https://gateway.example.com",
  scopes: ["write:web"],
  deviceId: "0d0e0f10-1111-4222-8333-444455556666",
  pairedAt: Date.UTC(2026, 0, 15, 10, 0, 0),
};

/** A gateway capture policy with nothing excluded, as `GET /web-capture-policy` returns it. */
export function policyBody(overrides: Partial<WebCapturePolicy> = {}): WebCapturePolicy {
  return {
    updatedAt: "",
    pause: null,
    excludedDomains: [],
    ownedDomains: [],
    rules: DEFAULT_WEB_CAPTURE_RULES,
    removedPages: [],
    removedPagesTruncated: false,
    ...overrides,
  };
}

/** The browser's durable copy of a policy, fresh as of `fetchedAt`. */
export function cachedPolicy(policy = policyBody(), fetchedAt = Date.now()): string {
  return JSON.stringify({ policy, fetchedAt });
}

/** Storage of a browser paired with the HTTPS grant in place and a fresh policy copy. */
export function pairedStorage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [PAIRING_KEY]: JSON.stringify(TEST_PAIRING),
    [TOKEN_KEY]: "invented-token",
    [CAPTURE_PERMISSION_STATE_KEY]: true,
    [CAPTURE_POLICY_KEY]: cachedPolicy(),
    [PROFILE_LABEL_KEY]: "Personal",
    [QUEUE_STORAGE_KEY]: "[]",
    ...overrides,
  };
}

/** Parse one of the shipped pages; `window` supplies the `Event` class its nodes accept. */
export function loadPage(name: "popup.html" | "options.html"): {
  document: Document;
  window: { Event: typeof Event };
} {
  const html = readFileSync(new URL(`../../public/${name}`, import.meta.url), "utf8");
  const { document, window } = parseHTML(html);
  return {
    document: document as unknown as Document,
    window: window as unknown as { Event: typeof Event },
  };
}

export type SentMessage = { type: string } & Record<string, unknown>;
export type MessageScript = (message: SentMessage) => unknown;

/**
 * A `chrome` with the members the pages and their helper modules read:
 * `storage.local`, `runtime`, `tabs`, `permissions` and `scripting`. Install it
 * as the global (`vi.stubGlobal("chrome", fake.api)`) — the storage and
 * permission helpers read the global — and pass it to the page's `init` too.
 */
export class FakePageChrome {
  readonly messages: SentMessage[] = [];
  readonly openOptionsPage = { calls: 0 };
  readonly permissionRequests: chrome.permissions.Permissions[] = [];
  hostPermission = true;
  contentScriptRegistered = true;
  activeTab: chrome.tabs.Tab | undefined = { id: 7, url: "https://news.example.com/story" };
  tabStatus: unknown = { state: "watching" };
  manifestVersion = "0.4.5";
  respond: MessageScript = () => ({ ok: true });

  constructor(readonly storage: Record<string, unknown>) {}

  readonly api = {
    storage: {
      local: {
        get: (keys: string | string[] | null): Promise<Record<string, unknown>> => {
          if (keys === null) return Promise.resolve({ ...this.storage });
          const list = Array.isArray(keys) ? keys : [keys];
          return Promise.resolve(
            Object.fromEntries(
              list.filter((key) => key in this.storage).map((key) => [key, this.storage[key]]),
            ),
          );
        },
        getKeys: (): Promise<string[]> => Promise.resolve(Object.keys(this.storage)),
        set: (items: Record<string, unknown>): Promise<void> => {
          Object.assign(this.storage, items);
          return Promise.resolve();
        },
        remove: (keys: string | string[]): Promise<void> => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete this.storage[key];
          return Promise.resolve();
        },
      },
    },
    runtime: {
      id: "extension-test",
      getManifest: () => ({ version: this.manifestVersion }),
      openOptionsPage: (): Promise<void> => {
        this.openOptionsPage.calls += 1;
        return Promise.resolve();
      },
      sendMessage: async <T>(message: unknown): Promise<T> => {
        const typed = message as SentMessage;
        this.messages.push(typed);
        return (await this.respond(typed)) as T;
      },
    },
    tabs: {
      query: (): Promise<chrome.tabs.Tab[]> =>
        Promise.resolve(this.activeTab ? [this.activeTab] : []),
      sendMessage: <T>(): Promise<T> => {
        if (this.tabStatus instanceof Error) return Promise.reject(this.tabStatus);
        return Promise.resolve(this.tabStatus as T);
      },
    },
    permissions: {
      getAll: (): Promise<chrome.permissions.Permissions> =>
        Promise.resolve({
          origins: this.hostPermission ? ["https://*/*"] : [],
          permissions: ["storage", "alarms"],
        }),
      request: (permissions: chrome.permissions.Permissions): Promise<boolean> => {
        this.permissionRequests.push(permissions);
        this.hostPermission = true;
        return Promise.resolve(true);
      },
    },
    scripting: {
      getRegisteredContentScripts: (): Promise<chrome.scripting.RegisteredContentScript[]> =>
        Promise.resolve(this.contentScriptRegistered ? [CAPTURE_CONTENT_SCRIPT] : []),
    },
  };

  sent(type: string): SentMessage[] {
    return this.messages.filter((message) => message.type === type);
  }
}
