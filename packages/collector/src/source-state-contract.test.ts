// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The state contract, driven through the real instantiator.
 *
 * The unit tests in `@omnesis/source-sdk` prove the resolution logic. These
 * prove the wiring: that a source declaring versioned state actually gets
 * wrapped when the collector builds it, that the wrapper sits in the right
 * place relative to the provider context, and that a source declaring nothing
 * is left exactly as it was.
 *
 * The sources here are synthetic but shaped like real ones, so the cases that
 * matter are the cases the tree actually contains: a shared-account provider
 * whose two sources persist unrelated bookmarks, and a local source that
 * versioned its own cursor before envelopes existed.
 */

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defineProvider,
  defineSource,
  isStateEnvelope,
  mergeContractDeclarations,
  checkContractCompatibility,
} from "@omnesis/source-sdk";

it("every scoped-snapshot provider declares the host generation and deletion capability it uses", async () => {
  const { allDefinitions } = await import("./source-descriptors.js");
  const contracts = new Map(
    allDefinitions.flatMap((definition) =>
      "sources" in definition
        ? definition.sources.map(
            (entry) =>
              [entry.id, mergeContractDeclarations(definition.contract, entry.contract)] as const,
          )
        : [[definition.id, definition.contract] as const],
    ),
  );
  for (const id of [
    "notion-databases",
    "github",
    "github-commits",
    "imap",
    "outlook-calendar",
    "claude-code",
    "codex",
    "pi",
    "local-files",
    "apple-contacts",
  ]) {
    const contract = contracts.get(id);
    expect(contract, id).toBeDefined();
    expect(contract!.apiVersion, id).toBe(2);
    expect(contract!.requires, id).toContain("snapshot-sessions");
    expect(checkContractCompatibility(contract, id)).toBeNull();
    expect(
      checkContractCompatibility(contract, id, {
        capabilities: ["state-envelope", "multi-table-batch"],
      })?.kind,
    ).toBe("missing-capability");
  }
});
import { AccountId, ProviderType, SourceType } from "@omnesis/types";
import { setupSources, type SourceInstantiatorContext } from "./source-instantiator.js";
import { buildSourceToProviderMap } from "./source-config-reconciler.js";
import type {
  GatewayClient,
  SourceDescriptor,
  SourceOrProviderDefinition,
} from "@omnesis/source-sdk";
import type { RegisteredProvider } from "./sync-engine-types.js";

let isolatedConfigDir: string;
let fallbackConfigDir: string;
beforeEach(() => {
  isolatedConfigDir = mkdtempSync(join(tmpdir(), "omnesis-state-contract-"));
  fallbackConfigDir = mkdtempSync(join(tmpdir(), "omnesis-state-fallback-"));
  vi.stubEnv("OMNESIS_CONFIG_DIR", fallbackConfigDir);
});
afterEach(() => {
  try {
    // Explicit fixture ownership must win over the process-wide fallback.
    expect(readdirSync(fallbackConfigDir)).toEqual([]);
  } finally {
    vi.unstubAllEnvs();
    rmSync(isolatedConfigDir, { recursive: true, force: true });
    rmSync(fallbackConfigDir, { recursive: true, force: true });
  }
});

function makeDescriptor(id: string, providerId: string): SourceDescriptor {
  return {
    id: SourceType(id),
    name: id,
    description: id,
    provider: { id: ProviderType(providerId), name: providerId },
    authType: "local",
  };
}

function makeCtx(
  definitions: SourceOrProviderDefinition[],
  descriptors: SourceDescriptor[],
  registered: RegisteredProvider[],
): SourceInstantiatorContext {
  return {
    configDir: isolatedConfigDir,
    definitions,
    descriptors,
    sourceToProvider: buildSourceToProviderMap(descriptors),
    config: { sources: {} },
    gateway: {} as GatewayClient,
    engine: { registerProvider: (p: RegisteredProvider) => registered.push(p) } as never,
  };
}

const instancesOf = (registered: RegisteredProvider[]) =>
  new Map(registered.flatMap((p) => p.sources.map((s) => [String(s.id), s.instance] as const)));

// ── Synthetic sources, shaped like real ones ───────────────────────────────

/**
 * A mail source shaped like Gmail: an upstream change token plus a page
 * pointer, bumped from a bare token in an earlier release.
 */
interface MailStateV2 extends Record<string, unknown> {
  historyId: string;
  pageToken?: string;
}
const isMailV2 = (v: unknown): v is MailStateV2 =>
  typeof v === "object" && v !== null && typeof (v as MailStateV2).historyId === "string";

/**
 * A notes source shaped like Obsidian: a map of file fingerprints, and a
 * cursor that carried its own `version` field before envelopes existed.
 */
interface NotesStateV3 extends Record<string, unknown> {
  files: Record<string, number>;
}
const isNotesV3 = (v: unknown): v is NotesStateV3 =>
  typeof v === "object" && v !== null && typeof (v as NotesStateV3).files === "object";

describe("a shared-account provider whose sources persist unrelated bookmarks", () => {
  /** Records the state each source was handed, keyed by source id. */
  function build() {
    const handed = new Map<string, unknown>();
    const def = defineProvider({
      provider: { id: "synth-mailco", name: "Mailco" },
      authType: "local",
      contract: { apiVersion: 2 },
      discover: async () => [AccountId("person@example.com")],
      createContext: async () => ({ token: "shared" }),
      sources: [
        {
          id: "synth-mail",
          name: "Mailco mail",
          description: "Messages",
          contract: {
            requires: ["state-envelope"],
            state: {
              version: 2,
              decode: (v) => (isMailV2(v) ? v : null),
              // v1 stored the token bare; v2 wraps it and adds a page pointer.
              migrate: {
                1: (old) => ({ historyId: String((old as { token?: string }).token ?? "") }),
              },
            },
          },
          create: async ({ sourceId }) => ({
            sync: async (cursor) => {
              handed.set(String(sourceId), cursor);
              return {
                documents: [],
                deletedExternalIds: [],
                cursor: { historyId: "99" },
                hasMore: false,
              };
            },
          }),
        },
        {
          id: "synth-calendar",
          name: "Mailco calendar",
          description: "Events",
          // Deliberately declares no state contract: the sibling's declaration
          // must not reach it.
          create: async ({ sourceId }) => ({
            sync: async (cursor) => {
              handed.set(String(sourceId), cursor);
              return { documents: [], deletedExternalIds: [], cursor: { raw: 1 }, hasMore: false };
            },
          }),
        },
      ],
    });
    const registered: RegisteredProvider[] = [];
    const ctx = makeCtx(
      [def],
      [
        makeDescriptor("synth-mail", "synth-mailco"),
        makeDescriptor("synth-calendar", "synth-mailco"),
      ],
      registered,
    );
    return { ctx, registered, handed };
  }

  it("migrates the declaring source's stored state before it sees it", async () => {
    const { ctx, registered, handed } = build();
    await setupSources(ctx, {
      "synth-mail": { enabled: true },
      "synth-calendar": { enabled: true },
    });
    const mail = instancesOf(registered).get("synth-mail:person@example.com");

    await mail!.sync({ e: 1, v: 1, state: { token: "abc" } } as never);
    expect(handed.get("synth-mail:person@example.com")).toEqual({ historyId: "abc" });
  });

  it("wraps what the declaring source returns, stamped with its own source id", async () => {
    const { ctx, registered } = build();
    await setupSources(ctx, {
      "synth-mail": { enabled: true },
      "synth-calendar": { enabled: true },
    });
    const mail = instancesOf(registered).get("synth-mail:person@example.com");

    const result = await mail!.sync(null);
    expect(isStateEnvelope(result.cursor)).toBe(true);
    expect(result.cursor).toEqual({
      e: 1,
      v: 2,
      s: "synth-mail:person@example.com",
      state: { historyId: "99" },
    });
  });

  it("leaves a sibling that declares nothing completely untouched", async () => {
    const { ctx, registered, handed } = build();
    await setupSources(ctx, {
      "synth-mail": { enabled: true },
      "synth-calendar": { enabled: true },
    });
    const calendar = instancesOf(registered).get("synth-calendar:person@example.com");

    const stored = { syncToken: "opaque", nested: { a: 1 } };
    const result = await calendar!.sync(stored as never);
    // Handed through raw, and returned raw: nothing about this source changed.
    expect(handed.get("synth-calendar:person@example.com")).toEqual(stored);
    expect(result.cursor).toEqual({ raw: 1 });
    expect(isStateEnvelope(result.cursor)).toBe(false);
  });

  it("never lets one source resume from the other's envelope", async () => {
    const { ctx, registered } = build();
    await setupSources(ctx, {
      "synth-mail": { enabled: true },
      "synth-calendar": { enabled: true },
    });
    const mail = instancesOf(registered).get("synth-mail:person@example.com");

    // An envelope stamped for the sibling arriving under this key is a storage
    // bug; resuming from it would attribute one source's position to another.
    await expect(
      mail!.sync({
        e: 1,
        v: 2,
        s: "synth-calendar:person@example.com",
        state: { historyId: "wrong" },
      } as never),
    ).rejects.toThrow(/synth-calendar:person@example\.com/);
  });
});

describe("a local source that versioned its own cursor before envelopes existed", () => {
  function build() {
    const handed: unknown[] = [];
    const def = defineSource({
      id: "synth-notes",
      name: "Synth notes",
      description: "Notes from a folder",
      authType: "local",
      contract: {
        apiVersion: 2,
        requires: ["state-envelope"],
        state: {
          version: 3,
          decode: (v) => (isNotesV3(v) ? v : null),
          // The pre-envelope cursor carried `version: 2`; anything older is v1.
          legacyVersion: (v) => ((v as { version?: number }).version === 2 ? 2 : 1),
          migrate: {
            // v1 keyed files by path; v2 introduced a stable id map.
            1: (old) => ({ version: 2, fileMap: (old as { paths?: string[] }).paths ?? [] }),
            // v2's own shape, lifted into the envelope-era field name.
            2: (old) => ({
              files: Object.fromEntries(
                ((old as { fileMap?: string[] }).fileMap ?? []).map((p) => [p, 0]),
              ),
            }),
          },
        },
      },
      discover: async () => [AccountId("local")],
      create: async () => ({
        sync: async (cursor) => {
          handed.push(cursor);
          return {
            documents: [],
            deletedExternalIds: [],
            cursor: { files: { "a.md": 1 } },
            hasMore: false,
          };
        },
      }),
    });
    const registered: RegisteredProvider[] = [];
    const ctx = makeCtx([def], [makeDescriptor("synth-notes", "synth-notes")], registered);
    return { ctx, registered, handed };
  }

  it("classifies a self-versioned legacy cursor and migrates only the last hop", async () => {
    const { ctx, registered, handed } = build();
    await setupSources(ctx, { "synth-notes": { enabled: true } });
    const notes = instancesOf(registered).get("synth-notes:local");

    await notes!.sync({ version: 2, fileMap: ["a.md", "b.md"] } as never);
    expect(handed[0]).toEqual({ files: { "a.md": 0, "b.md": 0 } });
  });

  it("takes the full chain for a cursor older than the source's own versioning", async () => {
    const { ctx, registered, handed } = build();
    await setupSources(ctx, { "synth-notes": { enabled: true } });
    const notes = instancesOf(registered).get("synth-notes:local");

    await notes!.sync({ paths: ["old.md"] } as never);
    expect(handed[0]).toEqual({ files: { "old.md": 0 } });
  });

  it("refuses state from a newer build instead of re-reading the whole vault", async () => {
    const { ctx, registered, handed } = build();
    await setupSources(ctx, { "synth-notes": { enabled: true } });
    const notes = instancesOf(registered).get("synth-notes:local");

    await expect(notes!.sync({ e: 1, v: 4, state: {} } as never)).rejects.toThrow(
      /newer than this build/,
    );
    // The source was never called, so nothing walked the folder.
    expect(handed).toEqual([]);
  });

  it("carries an operator remedy on the refusal, not just a message", async () => {
    const { ctx, registered } = build();
    await setupSources(ctx, { "synth-notes": { enabled: true } });
    const notes = instancesOf(registered).get("synth-notes:local");

    const err = (await notes!
      .sync({ e: 1, v: 4, state: {} } as never)
      .catch((e: unknown) => e)) as { remediation?: { steps: string[] } };
    const steps = err.remediation?.steps.join(" ");
    expect(steps).toContain("take a backup");
    expect(steps).toContain("verified that the source can recover its history");
    expect(steps).not.toContain("omnesis sources resync");
  });
});

describe("a package this build cannot run", () => {
  it("is refused before it is instantiated, rather than run degraded", async () => {
    let created = false;
    const def = defineSource({
      id: "synth-future",
      name: "Synth future",
      description: "Written against a later generation",
      authType: "local",
      // Opaque source connection allocation is not provided by this build.
      contract: { requires: ["connection-identity"] },
      discover: async () => [AccountId("local")],
      create: async () => {
        created = true;
        return {
          sync: async () => ({ documents: [], deletedExternalIds: [], cursor: {}, hasMore: false }),
        };
      },
    });
    const registered: RegisteredProvider[] = [];
    const ctx = makeCtx([def], [makeDescriptor("synth-future", "synth-future")], registered);

    const failures = await setupSources(ctx, { "synth-future": { enabled: true } });

    expect(created).toBe(false);
    expect(failures.map((f) => f.key)).toContain("synth-future:local");
    expect(failures[0]?.error).toContain("connection-identity");
    expect(instancesOf(registered).size).toBe(0);
  });

  it("refuses only the entry that asked, never its siblings", async () => {
    const def = defineProvider({
      provider: { id: "synth-mixed", name: "Mixed" },
      authType: "local",
      contract: { apiVersion: 2 },
      discover: async () => [AccountId("local")],
      sources: [
        {
          id: "synth-ok",
          name: "Runnable",
          description: "Asks for nothing",
          create: async () => ({
            sync: async () => ({
              documents: [],
              deletedExternalIds: [],
              cursor: {},
              hasMore: false,
            }),
          }),
        },
        {
          id: "synth-too-new",
          name: "Too new",
          description: "Asks for a capability this build lacks",
          contract: { requires: ["connection-identity"] },
          create: async () => ({
            sync: async () => ({
              documents: [],
              deletedExternalIds: [],
              cursor: {},
              hasMore: false,
            }),
          }),
        },
      ],
    });
    const registered: RegisteredProvider[] = [];
    const ctx = makeCtx(
      [def],
      [makeDescriptor("synth-ok", "synth-mixed"), makeDescriptor("synth-too-new", "synth-mixed")],
      registered,
    );

    const failures = await setupSources(ctx, {
      "synth-ok": { enabled: true },
      "synth-too-new": { enabled: true },
    });

    expect([...instancesOf(registered).keys()]).toEqual(["synth-ok:local"]);
    expect(failures.map((f) => f.key)).toEqual(["synth-too-new:local"]);
  });

  it("inherits the provider's generation field-wise, so an entry's own state does not erase it", async () => {
    // A provider declares the generation once; an entry declares its own
    // bookmark. Replacing one declaration with the other would silently revert
    // the entry to generation 1 while it uses a generation 2 feature.
    const def = defineProvider({
      provider: { id: "synth-inherit", name: "Inherit" },
      authType: "local",
      contract: { apiVersion: 2, requires: ["state-envelope"] },
      discover: async () => [AccountId("local")],
      sources: [
        {
          id: "synth-child",
          name: "Child",
          description: "Declares only its own state",
          contract: {
            state: {
              version: 1,
              decode: (v) => (typeof v === "object" && v ? (v as Record<string, unknown>) : null),
            },
          },
          create: async () => ({
            sync: async () => ({
              documents: [],
              deletedExternalIds: [],
              cursor: { a: 1 },
              hasMore: false,
            }),
          }),
        },
      ],
    });
    const merged = mergeContractDeclarations(def.contract, def.sources[0]!.contract);
    expect(merged?.apiVersion).toBe(2);
    expect(merged?.requires).toEqual(["state-envelope"]);
    expect(merged?.state?.version).toBe(1);

    const registered: RegisteredProvider[] = [];
    const ctx = makeCtx([def], [makeDescriptor("synth-child", "synth-inherit")], registered);
    await setupSources(ctx, { "synth-child": { enabled: true } });
    expect(instancesOf(registered).size).toBe(1);
  });
});
