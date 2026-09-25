// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join } from "node:path";
import { test, expect, vi } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { fakeSourceHost } from "@omnesis/source-sdk/testing";
import { inspectMessageStore } from "./message-store.js";
import definition from "./index.js";

vi.mock("./provider.js", () => ({
  WhatsAppProvider: class {
    async initialize() {}
    async isAuthenticated() {
      return true;
    }
    async authenticate() {}
    getStore() {
      return {};
    }
    getMediaDownloader() {
      return undefined;
    }
  },
}));
vi.mock("./messages.js", () => ({ WhatsAppMessagesSource: class {} }));
vi.mock("./message-store.js", () => ({
  inspectMessageStore: vi.fn(() => ({
    keyName: "whatsapp-store",
    label: "WhatsApp message archive",
    state: "absent",
  })),
}));

test("the local archive probe uses the source host's config root", async () => {
  const host = fakeSourceHost({ configDir: "/fixture/config" });
  const source = await definition.create!({
    accountId: "+15550100001",
    sourceId: SourceId("whatsapp:+15550100001"),
    providerId: ProviderId("whatsapp:+15550100001"),
    host,
  });
  await source.probeLocalStores!({ signal: new AbortController().signal });
  expect(inspectMessageStore).toHaveBeenCalledWith(
    join(host.configDir, "whatsapp", "+15550100001"),
  );
});
