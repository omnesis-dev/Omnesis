// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderId } from "@omnesis/types";
import { afterEach, describe, expect, test, vi } from "vitest";
import { fakeProviderHost } from "@omnesis/source-sdk/testing";
import { saveTokens } from "./provider.js";
import definition from "./index.js";
import type { NotionClient } from "./client.js";

const tmpDirs: string[] = [];

async function makeConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omnesis-notion-context-"));
  tmpDirs.push(dir);
  await writeFile(
    join(dir, "notion-credentials.json"),
    JSON.stringify({ client_id: "notion-client", client_secret: "notion-secret" }),
  );
  return dir;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Notion isAuthenticated", () => {
  async function contextFor(configDir: string) {
    await saveTokens(
      "workspace-1",
      {
        access_token: "secret-token",
        workspace_id: "workspace-1",
        workspace_name: "test-workspace",
        bot_id: "bot-1",
      },
      configDir,
    );
    // `createContext` warms a user map over the network before handing back
    // the context; answer it so the test isn't paying the client's retry ladder.
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ object: "list", results: [], has_more: false }), {
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ),
    );
    return definition.createContext!({
      accountId: "workspace-1",
      providerId: ProviderId("notion:workspace-1"),
      host: fakeProviderHost({ configDir }),
    });
  }

  /**
   * A client that turns any reach for the Notion API into a failure. Answering
   * this gate from the network cannot tell "Notion is unreachable" from "the
   * workspace revoked the integration", so it would park every Notion source in
   * needs-auth and push a re-auth reminder the credentials never warranted.
   */
  function unreachableClient(): NotionClient {
    return new Proxy({} as NotionClient, {
      get(_target, property) {
        throw new Error(`isAuthenticated reached for client.${String(property)}`);
      },
    });
  }

  test("answers from the stored grant without calling Notion", async () => {
    const configDir = await makeConfigDir();
    const context = await contextFor(configDir);
    context.client = unreachableClient();

    await expect(definition.credentialState!(context)).resolves.toEqual({ status: "connected" });
  });

  test("reports unauthenticated once the grant is gone from disk", async () => {
    const configDir = await makeConfigDir();
    const context = await contextFor(configDir);
    context.client = unreachableClient();

    await rm(join(configDir, "notion", "workspace-1"), { recursive: true, force: true });

    await expect(definition.credentialState!(context)).resolves.toEqual({
      status: "never-connected",
    });
  });
});
