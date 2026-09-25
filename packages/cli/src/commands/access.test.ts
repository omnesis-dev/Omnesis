// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { legacyMcpProfileTarget, retireLegacyMcpProfile } from "./access.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function profile(mode: "answer" | "direct", version: 1 | 2 = 2) {
  const root = await mkdtemp(join(tmpdir(), "omnesis-legacy-mcp-test-"));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  const target = legacyMcpProfileTarget(mode, root);
  writeFileSync(
    target.profilePath,
    `${JSON.stringify(
      version === 1
        ? {
            version,
            gatewayUrl: "https://gateway.example.org",
            token: "legacy-secret-never-log",
          }
        : {
            version,
            mode,
            gatewayUrl: "https://gateway.example.org",
            token: "legacy-secret-never-log",
          },
    )}\n`,
    { mode: 0o600 },
  );
  return target;
}

describe("legacy MCP profile retirement", () => {
  test("revokes the exact bearer before removing its local profile", async () => {
    const target = await profile("answer");
    const events: string[] = [];
    const result = await retireLegacyMcpProfile(target, {
      trust: vi.fn(async () => ({ action: "already-trusted" as const })),
      request: vi.fn(async (_url, init) => {
        events.push(`request:${new Headers(init?.headers).get("Authorization")}`);
        return new Response(JSON.stringify({ revoked: true }), { status: 200 });
      }),
      remove: (path) => {
        expect(readFileSync(path, "utf8")).toContain("legacy-secret-never-log");
        events.push("remove");
      },
    });
    expect(result.outcome).toBe("revoked");
    expect(events).toEqual(["request:Bearer legacy-secret-never-log", "remove"]);
  });

  test("retires the original v1 Answer profile that predates the mode field", async () => {
    const target = await profile("answer", 1);
    const request = vi.fn(
      async () => new Response(JSON.stringify({ revoked: true }), { status: 200 }),
    );
    const result = await retireLegacyMcpProfile(target, {
      trust: vi.fn(async () => ({ action: "already-trusted" as const })),
      request,
    });
    expect(result.outcome).toBe("revoked");
    expect(request).toHaveBeenCalledOnce();
    expect(() => readFileSync(target.profilePath)).toThrow();
  });

  test("does not reinterpret a v1 Answer profile as Direct", async () => {
    const target = await profile("direct", 1);
    await expect(
      retireLegacyMcpProfile(target, {
        trust: vi.fn(async () => ({ action: "already-trusted" as const })),
        request: vi.fn(),
      }),
    ).rejects.toThrow("not a valid legacy Omnesis MCP direct profile");
    expect(readFileSync(target.profilePath, "utf8")).toContain("legacy-secret-never-log");
  });

  test("keeps the profile when the Gateway refuses the cutover", async () => {
    const target = await profile("direct");
    await expect(
      retireLegacyMcpProfile(target, {
        trust: vi.fn(async () => ({ action: "already-trusted" as const })),
        request: vi.fn(async () => new Response("not a legacy CLI token", { status: 409 })),
      }),
    ).rejects.toThrow("Gateway refused to retire");
    expect(readFileSync(target.profilePath, "utf8")).toContain("legacy-secret-never-log");
  });

  test("keeps a profile when a 401 cannot prove whether the bearer is inactive", async () => {
    const target = await profile("answer");
    await expect(
      retireLegacyMcpProfile(target, {
        trust: vi.fn(async () => ({ action: "already-trusted" as const })),
        request: vi.fn(async () => new Response(null, { status: 401 })),
      }),
    ).rejects.toThrow("Gateway refused to retire");
    expect(readFileSync(target.profilePath, "utf8")).toContain("legacy-secret-never-log");
  });
});

describe("access audit", () => {
  test.each([["--principal"], ["--connection"]])(
    "%s narrows the request to that connection id",
    async (flag) => {
      const { runCommand } = await import("citty");
      const { accessCommand } = await import("./access.js");
      const request = vi
        .fn()
        .mockResolvedValue(Response.json({ items: [], pageInfo: { hasMore: false, limit: 50 } }));
      vi.stubGlobal("fetch", request);
      vi.stubEnv("OMNESIS_TOKEN", `omn_${"a".repeat(32)}`);
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await runCommand(accessCommand, { rawArgs: ["audit", flag, "p-1"] });
      } finally {
        log.mockRestore();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
      }
      expect(request).toHaveBeenCalledOnce();
      const url = new URL(String(request.mock.calls[0]?.[0]));
      expect(url.pathname).toBe("/admin/access/audit");
      expect(url.searchParams.get("principalId")).toBe("p-1");
    },
  );

  test("builds the route path from only the filters given", async () => {
    const { accessAuditPath } = await import("./access.js");
    expect(accessAuditPath({})).toBe("/admin/access/audit");
    expect(accessAuditPath({ limit: "20", cursor: "abc", connection: "p-1", grant: "g-1" })).toBe(
      "/admin/access/audit?limit=20&cursor=abc&principalId=p-1&grantId=g-1",
    );
  });

  test("renders one line per event and the cursor for the next page", async () => {
    const { formatAccessAuditPage } = await import("./access.js");
    const lines = formatAccessAuditPage({
      items: [
        {
          id: "e-1",
          occurredAt: Date.UTC(2026, 0, 2, 3, 4, 5),
          eventType: "mcp-tool-invoked",
          principalId: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          grantId: "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          grantRevision: 2,
          credentialId: "33333333-cccc-4ccc-8ccc-cccccccccccc",
          oauthClientId: "omn_oc_fictional",
          actorTokenId: null,
          detail: { tool: "search_many", outcome: "ok", sourceMode: "allowlist" },
        },
      ],
      pageInfo: { hasMore: true, limit: 1, nextCursor: "next-cursor" },
    });
    expect(lines[1]).toContain("2026-01-02T03:04:05.000Z");
    expect(lines[1]).toContain("mcp-tool-invoked");
    expect(lines[1]).toContain("11111111   22222222  2    33333333");
    expect(lines[1]).toContain("tool=search_many outcome=ok sourceMode=allowlist");
    expect(lines.at(-1)).toContain("--cursor next-cursor");
    expect(formatAccessAuditPage({ items: [], pageInfo: { hasMore: false, limit: 50 } })).toEqual([
      "No access events recorded.",
    ]);
  });
});

describe("access levels", () => {
  test("lists what each level grants and the connections and devices on it", async () => {
    const { formatAccessLevels } = await import("./access.js");
    const lines = formatAccessLevels({
      sources: [
        { id: "src-notes", available: true },
        { id: "src-calendar", available: true },
        { id: "src-mail", available: true },
        { id: "src-old", available: false },
      ],
      policyFamilies: [{ id: "policy-open", name: "Open" }],
      levels: [
        {
          id: "level-voice",
          name: "Voice answers",
          connectionCount: 0,
          devices: [{ id: "device-voice", name: "Studio voice" }],
          rules: [
            {
              capability: "answer",
              sources: { mode: "allowlist", sourceIds: ["src-notes", "src-calendar"] },
              release: { mode: "reviewed", policyFamilyId: "policy-open" },
            },
          ],
        },
        {
          id: "level-desk",
          name: "Desk agent",
          connectionCount: 1,
          rules: [
            { capability: "direct", sources: { mode: "denylist", sourceIds: ["src-mail"] } },
            {
              capability: "answer",
              sources: { mode: "all", sourceIds: [] },
              release: { mode: "unreviewed" },
            },
            { capability: "notes", sources: { mode: "all", sourceIds: [] } },
          ],
        },
      ],
    }).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
    expect(lines).toEqual([
      "Voice answers  No connections · 1 integration · level-voice",
      "  answer from 2 of 3 sources · reviewed under “Open”",
      "  answers for integrations: Studio voice",
      "Desk agent  1 connection · level-desk",
      "  direct from 2 of 3 sources",
      "  answer from all sources · no privacy review",
      "  notes",
      "",
      "Edit levels on the portal's Access page; choose an integration's level on its Devices page.",
    ]);
  });

  test("says when there are none", async () => {
    const { formatAccessLevels } = await import("./access.js");
    expect(formatAccessLevels({ sources: [], policyFamilies: [], levels: [] })).toEqual([
      "No access levels.",
    ]);
  });
});
