// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Minimal ambient declarations for the slice of the `chrome.*` MV3 API this
 * extension touches. The extension deliberately does not depend on
 * `@types/chrome`: the push pipeline is `chrome`-free, and the thin glue only
 * uses the handful of members declared here, so the full typings would add a
 * large dependency for little coverage. Widen this file as the glue grows.
 *
 * A regular `.ts` module (not a `.d.ts`) so it sits in both the build graph and
 * the lint program (`tsconfig.lint.json` excludes `*.d.ts`); `export {}` keeps
 * it a module and `declare global` exposes the `chrome` global to the glue.
 */

declare global {
  namespace chrome {
    namespace storage {
      interface StorageChange {
        oldValue?: unknown;
        newValue?: unknown;
      }
      interface StorageArea {
        get(keys: string | string[] | null): Promise<Record<string, unknown>>;
        /** Chrome 130+: enumerate keys without materializing every stored value. */
        getKeys(): Promise<string[]>;
        set(items: Record<string, unknown>): Promise<void>;
        remove(keys: string | string[]): Promise<void>;
      }
      const local: StorageArea;
      const onChanged: {
        addListener(
          callback: (changes: Record<string, StorageChange>, areaName: string) => void,
        ): void;
        removeListener(
          callback: (changes: Record<string, StorageChange>, areaName: string) => void,
        ): void;
      };
    }

    namespace runtime {
      interface Port {
        name: string;
        sender?: MessageSender;
        postMessage(message: unknown): void;
        disconnect(): void;
        onMessage: { addListener(callback: (message: unknown) => void): void };
        onDisconnect: { addListener(callback: () => void): void };
      }
      function connect(details: { name: string }): Port;
      const onConnect: { addListener(callback: (port: Port) => void): void };
      function getContexts(filter: {
        documentIds: string[];
        contextTypes: string[];
      }): Promise<Array<{ windowId: number; tabId: number }>>;
      const onInstalled: { addListener(callback: () => void): void };
      interface MessageSender {
        id?: string;
        documentId?: string;
        url?: string;
        tab?: { id?: number; url?: string; incognito?: boolean };
      }
      /** The extension id, or `undefined` once the extension context is invalidated. */
      const id: string | undefined;
      function openOptionsPage(): Promise<void>;
      function getURL(path: string): string;
      /**
       * This build's manifest. Only `version` is declared: it is the
       * extension's product version, which the store-package contract keeps
       * equal to the package manifest's, and the gateway's version ledger
       * reads it from the pairing capabilities.
       */
      function getManifest(): { version: string };
      /** Fire-and-forget / awaitable message from a content script to the SW. */
      function sendMessage<T = unknown>(message: unknown): Promise<T>;
      const onMessage: {
        addListener(
          callback: (
            message: unknown,
            sender: MessageSender,
            sendResponse: (response?: unknown) => void,
          ) => boolean | void | Promise<unknown>,
        ): void;
        removeListener(
          callback: (
            message: unknown,
            sender: MessageSender,
            sendResponse: (response?: unknown) => void,
          ) => boolean | void | Promise<unknown>,
        ): void;
      };
    }

    namespace alarms {
      interface Alarm {
        name: string;
        scheduledTime: number;
      }
      interface AlarmCreateInfo {
        when?: number;
        delayInMinutes?: number;
        periodInMinutes?: number;
      }
      function create(name: string, alarmInfo: AlarmCreateInfo): void;
      function clear(name: string): Promise<boolean>;
      const onAlarm: {
        addListener(callback: (alarm: Alarm) => void): void;
      };
    }

    namespace action {
      /** Set the toolbar badge text ("" clears it). Needs no extra permission. */
      function setBadgeText(details: { text: string }): Promise<void>;
      function setBadgeBackgroundColor(details: { color: string }): Promise<void>;
      /** Set the toolbar button tooltip (the hover/long-press title). */
      function setTitle(details: { title: string }): Promise<void>;
    }

    namespace permissions {
      interface Permissions {
        origins?: string[];
        permissions?: string[];
      }
      function request(permissions: Permissions): Promise<boolean>;
      function contains(permissions: Permissions): Promise<boolean>;
      function getAll(): Promise<Permissions>;
      function remove(permissions: Permissions): Promise<boolean>;
      const onAdded: {
        addListener(callback: (permissions: Permissions) => void): void;
      };
      const onRemoved: {
        addListener(callback: (permissions: Permissions) => void): void;
      };
    }

    namespace scripting {
      function executeScript<T>(details: {
        target: { tabId: number };
        func: () => T;
      }): Promise<Array<{ result?: T }>>;
      interface RegisteredContentScript {
        id: string;
        matches: string[];
        js: string[];
        runAt?: "document_start" | "document_end" | "document_idle";
        persistAcrossSessions?: boolean;
      }
      function getRegisteredContentScripts(filter: {
        ids?: string[];
      }): Promise<RegisteredContentScript[]>;
      function registerContentScripts(scripts: RegisteredContentScript[]): Promise<void>;
      function updateContentScripts(scripts: RegisteredContentScript[]): Promise<void>;
      function unregisterContentScripts(filter: { ids?: string[] }): Promise<void>;
    }

    namespace tabs {
      interface Tab {
        id?: number;
        windowId?: number;
        url?: string;
        title?: string;
        incognito?: boolean;
      }
      function create(details: { url: string; active?: boolean }): Promise<Tab>;
      function query(queryInfo: {
        active?: boolean;
        currentWindow?: boolean;
        lastFocusedWindow?: boolean;
      }): Promise<Tab[]>;
      function get(tabId: number): Promise<Tab>;
      function update(tabId: number, details: { active?: boolean; url?: string }): Promise<Tab>;
      function update(details: { active?: boolean; url?: string }): Promise<Tab>;
      function sendMessage<T = unknown>(tabId: number, message: unknown): Promise<T>;
    }
    namespace windows {
      const WINDOW_ID_CURRENT: number;
      function update(windowId: number, details: { focused: boolean }): Promise<unknown>;
      function getCurrent(): Promise<{ id?: number }>;
    }

    namespace omnibox {
      type OnInputEnteredDisposition = "currentTab" | "newForegroundTab" | "newBackgroundTab";
      interface SuggestResult {
        content: string;
        description: string;
      }
      function setDefaultSuggestion(suggestion: { description: string }): Promise<void>;
      const onInputStarted: { addListener(callback: () => void): void };
      const onInputChanged: {
        addListener(
          callback: (text: string, suggest: (results: SuggestResult[]) => void) => void,
        ): void;
      };
      const onInputEntered: {
        addListener(callback: (text: string, disposition: OnInputEnteredDisposition) => void): void;
      };
      const onInputCancelled: { addListener(callback: () => void): void };
    }

    namespace commands {
      function getAll(): Promise<Array<{ name?: string; shortcut?: string }>>;
      const onCommand: { addListener(callback: (command: string, tab?: tabs.Tab) => void): void };
    }
    namespace contextMenus {
      function removeAll(): Promise<void>;
      function create(details: {
        id: string;
        title: string;
        contexts: string[];
        documentUrlPatterns?: string[];
      }): void;
      const onClicked: {
        addListener(
          callback: (
            info: { menuItemId: string | number; pageUrl?: string; selectionText?: string },
            tab?: tabs.Tab,
          ) => void,
        ): void;
      };
    }
    namespace sidePanel {
      function setOptions(details: { enabled: boolean; path?: string }): Promise<void>;
      function open(details: { tabId: number } | { windowId: number }): Promise<void>;
      function close(details: { windowId?: number; tabId?: number }): Promise<void>;
      const onOpened: {
        addListener(
          callback: (info: { windowId: number; tabId?: number; path: string }) => void,
        ): void;
      };
      const onClosed: {
        addListener(
          callback: (info: { windowId: number; tabId?: number; path: string }) => void,
        ): void;
      };
    }
    namespace extension {
      /** True when this context runs in an incognito (private) window. */
      const inIncognitoContext: boolean;
    }
  }
}

export {};
